/**
 * Translates pi's agent event stream into chat-channel actions.
 *
 * This is the load-bearing piece of the whole host, and it is deliberately a
 * **pure function of the event stream**: feed it a recorded `AgentSessionEvent[]`
 * and it yields the `StateAction[]` a client would have seen. No sockets, no
 * model, no clock. That is what makes the turn semantics testable.
 *
 * Three structural mismatches it has to bridge:
 *
 * 1. **Turn granularity.** pi nests three levels — an agent *run*
 *    (`agent_start`…`agent_end`), a pi *turn* (one assistant message), and
 *    content blocks. AHP has two — a turn (one user message through to
 *    completion) and its `responseParts`. So one AHP turn spans everything from
 *    `prompt()` to `agent_settled`, which may contain several agent runs
 *    (auto-retry, post-compaction retry) and several assistant messages. Mapping
 *    `agent_end` to `chat/turnComplete` would close the turn early, after which
 *    every later action is silently dropped by the reducer.
 *
 * 2. **Part identity.** pi's `contentIndex` restarts at 0 for every assistant
 *    message and the stream carries no message id, so `contentIndex` alone
 *    collides across messages within a turn. Parts are keyed by
 *    `<turnId>:<message ordinal>:<contentIndex>` instead.
 *
 * 3. **Part creation.** `chat/delta` *appends* to a part that must already
 *    exist; targeting an unknown `partId` is a silent no-op. Parts are therefore
 *    created lazily, on the first content that lands in them.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/chat-channel
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	MessageKind,
	ResponsePartKind,
	type StateAction,
	ToolCallConfirmationReason,
	type ToolCallResult,
	type ToolResultContent,
	ToolResultContentType,
	type UsageInfo,
} from "@microsoft/agent-host-protocol";
import { describeToolCall, RESPONDING_ACTIVITY, THINKING_ACTIVITY } from "./activity.ts";

/** How a turn ended, decided from the last assistant message's stop reason. */
type TurnOutcome = "complete" | "cancelled" | "error";

interface OpenPart {
	readonly partId: string;
	readonly kind: ResponsePartKind.Markdown | ResponsePartKind.Reasoning;
	/** Whether `chat/responsePart` has been emitted for it yet. */
	created: boolean;
}

/** Minimal shape of pi's streaming deltas; pi types these per provider. */
interface AssistantDelta {
	readonly type: string;
	readonly contentIndex?: number;
	readonly delta?: string;
	/** Final text of a block, carried on `text_end` / `thinking_end`. */
	readonly content?: string;
	readonly toolCall?: { id?: string; name?: string; arguments?: unknown };
	readonly partial?: { content?: unknown[] };
	readonly message?: { usage?: PiUsage; stopReason?: string };
	readonly error?: { errorMessage?: string; stopReason?: string };
}

interface PiUsage {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	/** Subset of `output`, when the provider reports a reasoning breakdown. */
	readonly reasoning?: number;
	readonly totalTokens?: number;
	readonly cost?: unknown;
}

function toUsageInfo(usage: PiUsage | undefined, model: string | undefined): UsageInfo | undefined {
	if (!usage) {
		return undefined;
	}
	// `UsageInfo` only has slots for input/output/cacheRead, but pi reports more
	// (cache writes, a reasoning-token breakdown, and computed cost). Dropping
	// them would lose the numbers a client needs to show what a turn actually
	// cost, so the remainder rides in `_meta` — the protocol's documented place
	// for provider-specific extras.
	const extra: Record<string, unknown> = {};
	if (usage.cacheWrite !== undefined) {
		extra.cacheWriteTokens = usage.cacheWrite;
	}
	if (usage.reasoning !== undefined) {
		extra.reasoningTokens = usage.reasoning;
	}
	if (usage.totalTokens !== undefined) {
		extra.totalTokens = usage.totalTokens;
	}
	if (usage.cost !== undefined) {
		extra.cost = usage.cost;
	}

	return {
		...(usage.input !== undefined ? { inputTokens: usage.input } : {}),
		...(usage.output !== undefined ? { outputTokens: usage.output } : {}),
		...(usage.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
		...(model ? { model } : {}),
		...(Object.keys(extra).length > 0 ? { _meta: extra } : {}),
	};
}

/** pi carries message content either as a plain string or as typed blocks. */
function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block): block is { type: "text"; text: string } => (block as { type?: string })?.type === "text")
		.map((block) => block.text)
		.join("");
}

function textContent(text: string): ToolResultContent[] {
	return [{ type: ToolResultContentType.Text, text }];
}

/** Flattens pi's tool result content blocks into the protocol's text blocks. */
function toolResultContent(result: unknown): ToolResultContent[] | undefined {
	const blocks = (result as { content?: unknown[] } | undefined)?.content;
	if (!Array.isArray(blocks)) {
		return undefined;
	}
	const texts = blocks
		.filter((block): block is { type: "text"; text: string } => (block as { type?: string })?.type === "text")
		.map((block) => block.text)
		.filter((text) => text.length > 0);
	return texts.length > 0 ? textContent(texts.join("\n")) : undefined;
}

/**
 * Maps one AHP turn.
 *
 * A mapper instance is created when a turn starts and discarded when it ends;
 * all per-turn identity (message ordinal, open parts, live tool calls) lives
 * here rather than on the host.
 */
export interface TurnMapperOptions {
	/** Renders tool paths relative to it, so activity reads as `Reading src/x.ts`. */
	readonly workingDirectory?: string;
}

export class TurnMapper {
	/** The turn currently being mapped. Changes when a message is injected mid-run. */
	#turnId: string;
	/** Id of the turn this mapper was created for, used to derive successors. */
	readonly #rootTurnId: string;
	#turnStartedAt: number;
	#injectedCount = 0;

	/** Which assistant message we are on, 0-based, across the whole turn. */
	#messageOrdinal = -1;
	/** Open parts of the *current* assistant message, keyed by contentIndex. */
	#parts = new Map<number, OpenPart>();
	/** contentIndex → toolCallId, for correlating streaming deltas. */
	#toolCallsByIndex = new Map<number, string>();
	/** Tool calls that reached `ready` and have not completed. */
	readonly #liveToolCalls = new Set<string>();
	#outcome: TurnOutcome = "complete";
	#errorMessage: string | undefined;
	#finished = false;

	readonly #options: TurnMapperOptions;
	/** Last activity emitted, so unchanged descriptions are not re-sent. */
	#activity: string | undefined;

	constructor(turnId: string, startedAt: number = Date.now(), options: TurnMapperOptions = {}) {
		this.#turnId = turnId;
		this.#rootTurnId = turnId;
		this.#turnStartedAt = startedAt;
		this.#options = options;
	}

	get turnId(): string {
		return this.#turnId;
	}

	get finished(): boolean {
		return this.#finished;
	}

	/** Translates one pi event into zero or more chat actions. */
	handle(event: AgentSessionEvent): StateAction[] {
		if (this.#finished) {
			return [];
		}
		switch (event.type) {
			case "message_start":
				return this.#onMessageStart(event as { message?: { role?: string } });
			case "message_update":
				return this.#onDelta((event as { assistantMessageEvent: AssistantDelta }).assistantMessageEvent);
			case "message_end":
				return this.#onMessageEnd(
					event as {
						message?: {
							role?: string;
							usage?: PiUsage;
							model?: string;
							stopReason?: string;
							errorMessage?: string;
						};
					},
				);
			case "tool_execution_start":
				// The tool is about to run: say which one, and with what.
				return this.#setActivity(
					describeToolCall(
						(event as { toolName: string }).toolName,
						(event as { args?: unknown }).args,
						this.#options.workingDirectory,
					),
				);
			case "tool_execution_update":
				return this.#onToolUpdate(event as { toolCallId: string; partialResult?: unknown });
			case "tool_execution_end":
				return [
					...this.#onToolEnd(event as { toolCallId: string; toolName: string; result?: unknown; isError?: boolean }),
					// Back to the model. Kept out of `#onToolEnd`, which bails
					// early for a call it never saw start — activity is display
					// state and should not depend on that bookkeeping.
					...this.#setActivity(THINKING_ACTIVITY),
				];
			case "agent_settled":
				return this.finish();
			case "agent_start":
				// A run beginning, or resuming after a retry.
				return this.#setActivity(THINKING_ACTIVITY);
			default:
				// agent_start / agent_end / turn_start / turn_end carry no
				// protocol-visible state of their own: a retry re-enters
				// agent_start inside the same AHP turn, and pi's turn boundaries
				// are just groupings of response parts.
				return [];
		}
	}

	// ── Assistant messages ──────────────────────────────────────────────────

	#onMessageStart(event: { message?: { role?: string; content?: unknown } }): StateAction[] {
		if (event.message?.role === "user") {
			return this.#onInjectedMessage(event.message);
		}
		if (event.message?.role !== "assistant") {
			return [];
		}
		// A new assistant message restarts contentIndex at 0, so the part map
		// must not leak across messages.
		this.#messageOrdinal += 1;
		this.#parts = new Map();
		this.#toolCallsByIndex = new Map();
		return [];
	}

	/**
	 * Emits an activity change, skipping no-ops.
	 *
	 * A turn fires many events that map to the same description — every delta
	 * of one response is still "Responding" — and re-sending it would burn a
	 * `serverSeq` per token.
	 */
	#setActivity(activity: string | undefined): StateAction[] {
		if (this.#activity === activity) {
			return [];
		}
		this.#activity = activity;
		return [{ type: ActionType.ChatActivityChanged, ...(activity ? { activity } : {}) }];
	}

	#onMessageEnd(event: {
		message?: { role?: string; usage?: PiUsage; model?: string; stopReason?: string; errorMessage?: string };
	}): StateAction[] {
		if (event.message?.role !== "assistant") {
			return [];
		}

		// A run cancelled or failed *before* any content streamed produces no
		// `error` delta at all — the outcome shows up only as the finished
		// message's `stopReason`. Observed live: aborting during the first
		// request yields a single assistant message with `stopReason: 'aborted'`
		// and nothing else. Reading it here is what keeps such a turn from being
		// reported as a normal completion.
		if (event.message.stopReason === "aborted") {
			this.#outcome = "cancelled";
			this.#errorMessage ??= event.message.errorMessage;
		} else if (event.message.stopReason === "error") {
			this.#outcome = "error";
			this.#errorMessage ??= event.message.errorMessage;
		}

		const usage = toUsageInfo(event.message.usage, event.message.model);
		return usage ? [{ type: ActionType.ChatUsage, turnId: this.turnId, usage }] : [];
	}

	/**
	 * Handles a user message pi injects part-way through a run.
	 *
	 * pi delivers a steering message as an ordinary user message inside the
	 * running turn, and **stores it in the session file as an ordinary user
	 * message too** — with nothing to mark it as steering. So when that
	 * conversation is later rebuilt from disk it necessarily becomes its own
	 * turn, because a user message is what starts one.
	 *
	 * The live path therefore has to do the same, or the same conversation
	 * renders one way while it is running and another way after a reload. The
	 * turn in flight is closed and a fresh one opened around the injected
	 * message, which also matches how pi's own TUI shows it.
	 *
	 * The first user message of a run is the prompt itself, which the client
	 * already opened the turn with, so only later ones split.
	 */
	#onInjectedMessage(message: { content?: unknown }): StateAction[] {
		if (this.#messageOrdinal < 0) {
			// Nothing has streamed yet: this is the run's own prompt.
			return [];
		}

		const text = extractText(message.content);
		const completed = this.#closeCurrentTurn();

		this.#injectedCount += 1;
		this.#turnId = `${this.#rootTurnId}#${this.#injectedCount}`;
		this.#turnStartedAt = Date.now();
		this.#messageOrdinal = -1;
		this.#parts = new Map();
		this.#toolCallsByIndex = new Map();

		return [
			...completed,
			{
				type: ActionType.ChatTurnStarted,
				turnId: this.#turnId,
				startedAt: new Date(this.#turnStartedAt).toISOString(),
				message: { text, origin: { kind: MessageKind.User } },
			},
		];
	}

	#closeCurrentTurn(): StateAction[] {
		const duration = Math.max(0, Date.now() - this.#turnStartedAt);
		return [{ type: ActionType.ChatTurnComplete, turnId: this.#turnId, duration }];
	}

	// ── Streaming content ───────────────────────────────────────────────────

	#onDelta(delta: AssistantDelta): StateAction[] {
		switch (delta.type) {
			case "text_delta":
				return this.#appendText(delta, ResponsePartKind.Markdown);
			case "thinking_delta":
				return this.#appendText(delta, ResponsePartKind.Reasoning);
			case "text_end":
				return this.#closeBlock(delta, ResponsePartKind.Markdown);
			case "thinking_end":
				return this.#closeBlock(delta, ResponsePartKind.Reasoning);
			case "toolcall_start":
				return this.#onToolCallStart(delta);
			case "toolcall_delta":
				return this.#onToolCallDelta(delta);
			case "toolcall_end":
				return this.#onToolCallReady(delta);
			case "error":
				// Recorded, not emitted: a mid-stream error may still be retried
				// inside the same AHP turn, so only `agent_settled` decides the
				// turn's outcome.
				this.#outcome = delta.error?.stopReason === "aborted" ? "cancelled" : "error";
				this.#errorMessage = delta.error?.errorMessage;
				return [];
			default:
				// `*_start` / `start` / `done` need no action of their own: parts
				// are created lazily by the first delta.
				return [];
		}
	}

	/**
	 * Handles the end of a text or reasoning block.
	 *
	 * Normally a no-op, because the deltas already built the part. But a
	 * provider that does not stream a block incrementally emits only
	 * `*_end` with the finished `content` — observed with reasoning blocks on
	 * some models. Without this the content would be silently dropped, which is
	 * the same failure mode as targeting an unknown `partId`.
	 */
	#closeBlock(delta: AssistantDelta, kind: ResponsePartKind.Markdown | ResponsePartKind.Reasoning): StateAction[] {
		const contentIndex = delta.contentIndex ?? 0;
		if (this.#parts.get(contentIndex)?.created) {
			return [];
		}
		return this.#appendText({ ...delta, delta: delta.content ?? "" }, kind);
	}

	#partId(contentIndex: number): string {
		return `${this.#turnId}:${this.#messageOrdinal}:${contentIndex}`;
	}

	/**
	 * Appends streamed text, creating the part on first use.
	 *
	 * The first chunk rides along on `chat/responsePart` rather than being
	 * followed by a separate `chat/delta`, which halves the actions for short
	 * responses without changing the reduced state.
	 */
	#appendText(delta: AssistantDelta, kind: ResponsePartKind.Markdown | ResponsePartKind.Reasoning): StateAction[] {
		const contentIndex = delta.contentIndex ?? 0;
		const text = delta.delta ?? "";
		if (text.length === 0) {
			return [];
		}

		const responding = this.#setActivity(RESPONDING_ACTIVITY);

		let part = this.#parts.get(contentIndex);
		if (!part) {
			part = { partId: this.#partId(contentIndex), kind, created: false };
			this.#parts.set(contentIndex, part);
		}

		if (!part.created) {
			part.created = true;
			return [
				...responding,
				{
					type: ActionType.ChatResponsePart,
					turnId: this.turnId,
					part:
						kind === ResponsePartKind.Markdown
							? { kind, id: part.partId, content: text }
							: { kind, id: part.partId, content: text },
				},
			];
		}

		return [
			...responding,
			kind === ResponsePartKind.Markdown
				? { type: ActionType.ChatDelta, turnId: this.turnId, partId: part.partId, content: text }
				: { type: ActionType.ChatReasoning, turnId: this.turnId, partId: part.partId, content: text },
		];
	}

	// ── Tool calls ──────────────────────────────────────────────────────────

	#onToolCallStart(delta: AssistantDelta): StateAction[] {
		const contentIndex = delta.contentIndex ?? 0;
		const block = delta.partial?.content?.[contentIndex] as { id?: string; name?: string } | undefined;
		const toolCallId = block?.id;
		if (!toolCallId) {
			// Without an id there is nothing to correlate later; wait for the
			// next delta, which carries the resolved block.
			return [];
		}
		this.#toolCallsByIndex.set(contentIndex, toolCallId);
		const toolName = block.name ?? "tool";
		return [
			{
				type: ActionType.ChatToolCallStart,
				turnId: this.turnId,
				toolCallId,
				toolName,
				displayName: toolName,
			},
		];
	}

	#onToolCallDelta(delta: AssistantDelta): StateAction[] {
		const contentIndex = delta.contentIndex ?? 0;
		let toolCallId = this.#toolCallsByIndex.get(contentIndex);
		if (!toolCallId) {
			// The id may only have materialised after `toolcall_start`; recover
			// from the partial message rather than dropping the call.
			const started = this.#onToolCallStart(delta);
			toolCallId = this.#toolCallsByIndex.get(contentIndex);
			if (!toolCallId) {
				return [];
			}
			return [
				...started,
				{
					type: ActionType.ChatToolCallDelta,
					turnId: this.turnId,
					toolCallId,
					content: delta.delta ?? "",
				},
			];
		}
		return [{ type: ActionType.ChatToolCallDelta, turnId: this.turnId, toolCallId, content: delta.delta ?? "" }];
	}

	/**
	 * Parameters are complete.
	 *
	 * `confirmed: 'setting'` sends the call straight to `running`, skipping
	 * `pending-confirmation`. That is a first-class path in the protocol, and it
	 * is the honest one here: pi has no permission system, so there is nothing
	 * for a client to approve. Because the call never enters
	 * `pending-confirmation`, a conforming client renders no approve/deny UI —
	 * cancelling the whole turn stays available and maps to `abort()`.
	 */
	#onToolCallReady(delta: AssistantDelta): StateAction[] {
		const contentIndex = delta.contentIndex ?? 0;
		const toolCallId = delta.toolCall?.id ?? this.#toolCallsByIndex.get(contentIndex);
		if (!toolCallId) {
			return [];
		}
		this.#toolCallsByIndex.set(contentIndex, toolCallId);
		this.#liveToolCalls.add(toolCallId);

		const toolName = delta.toolCall?.name ?? "tool";
		const args = delta.toolCall?.arguments;
		return [
			{
				type: ActionType.ChatToolCallReady,
				turnId: this.turnId,
				toolCallId,
				invocationMessage: toolName,
				...(args !== undefined ? { toolInput: JSON.stringify(args) } : {}),
				confirmed: ToolCallConfirmationReason.Setting,
			},
		];
	}

	#onToolUpdate(event: { toolCallId: string; partialResult?: unknown }): StateAction[] {
		if (!this.#liveToolCalls.has(event.toolCallId)) {
			return [];
		}
		const content = toolResultContent(event.partialResult);
		return content
			? [
					{
						type: ActionType.ChatToolCallContentChanged,
						turnId: this.turnId,
						toolCallId: event.toolCallId,
						content,
					},
				]
			: [];
	}

	#onToolEnd(event: { toolCallId: string; toolName: string; result?: unknown; isError?: boolean }): StateAction[] {
		if (!this.#liveToolCalls.delete(event.toolCallId)) {
			return [];
		}
		const success = event.isError !== true;
		const content = toolResultContent(event.result);
		const result: ToolCallResult = {
			success,
			pastTenseMessage: success ? `Ran ${event.toolName}` : `${event.toolName} failed`,
			...(content ? { content } : {}),
			// `ToolCallResult.error` is its own shape (message + code), not `ErrorInfo`.
			...(success ? {} : { error: { message: `${event.toolName} failed` } }),
		};
		return [{ type: ActionType.ChatToolCallComplete, turnId: this.turnId, toolCallId: event.toolCallId, result }];
	}

	// ── Turn termination ────────────────────────────────────────────────────

	/**
	 * Closes the turn.
	 *
	 * Also called directly when a turn ends without `agent_settled` — an
	 * extension command that never reaches the model, or a failed `prompt()`.
	 * Without it the turn would stay active forever and the session would sit
	 * at `InProgress`.
	 */
	finish(outcome?: TurnOutcome, message?: string): StateAction[] {
		if (this.#finished) {
			return [];
		}
		this.#finished = true;
		// Nothing is happening once the turn is over; a stale description would
		// leave the client showing "Reading …" against an idle chat.
		const cleared = this.#setActivity(undefined);
		const resolved = outcome ?? this.#outcome;
		const duration = Math.max(0, Date.now() - this.#turnStartedAt);

		switch (resolved) {
			case "cancelled":
				return [...cleared, { type: ActionType.ChatTurnCancelled, turnId: this.turnId, duration }];
			case "error":
				return [
					...cleared,
					{
						type: ActionType.ChatError,
						turnId: this.turnId,
						duration,
						error: {
							errorType: "agentRunFailed",
							message: message ?? this.#errorMessage ?? "The agent run failed",
						},
					},
				];
			default:
				return [...cleared, { type: ActionType.ChatTurnComplete, turnId: this.turnId, duration }];
		}
	}
}

/** Builds the `chat/turnStarted` action for a user message. */
export function userTurnStarted(turnId: string, text: string, startedAt: string): StateAction {
	return {
		type: ActionType.ChatTurnStarted,
		turnId,
		startedAt,
		message: { text, origin: { kind: MessageKind.User } },
	};
}
