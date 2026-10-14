/**
 * Rebuilds chat history from a pi session file.
 *
 * A client lists sessions and then subscribes to one. Everything the host has
 * seen live is already in memory, but a session from the catalogue exists only
 * on disk — so subscribing has to reconstruct its state, or the client opens an
 * empty conversation.
 *
 * The user's transcript comes from pi's full current branch, not its
 * compaction-aware model context. A compaction marks where the agent's memory
 * changed; it does not erase earlier messages or split a user's AHP turn.
 *
 * This is a *second* mapper, distinct from the streaming one: it works from
 * persisted messages rather than deltas. The file has no prompt-settled event,
 * so the last assistant result in each user turn is the best available outcome.
 */

import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	type Message,
	MessageKind,
	type ResponsePart,
	ResponsePartKind,
	ToolCallCancellationReason,
	ToolCallStatus,
	type ToolResultContent,
	ToolResultContentType,
	type Turn,
	TurnState,
	type UsageInfo,
} from "@microsoft/agent-host-protocol";
import { COMPACTION_NOTICE, compactionNotification } from "./compaction-notice.ts";
import { userMessageFromPiContent } from "./user-message.ts";

interface ContentBlock {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: unknown;
}

interface StoredMessage {
	readonly role?: string;
	readonly content?: string | ContentBlock[];
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly usage?: { input?: number; output?: number; cacheRead?: number };
	readonly model?: string;
	readonly command?: string;
	readonly output?: string;
}

function blocksOf(message: StoredMessage): ContentBlock[] {
	if (typeof message.content === "string") {
		return [{ type: "text", text: message.content }];
	}
	return Array.isArray(message.content) ? message.content : [];
}

function plainText(message: StoredMessage): string {
	return blocksOf(message)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

function toUsage(message: StoredMessage): UsageInfo | undefined {
	const usage = message.usage;
	if (!usage) {
		return undefined;
	}
	return {
		...(usage.input !== undefined ? { inputTokens: usage.input } : {}),
		...(usage.output !== undefined ? { outputTokens: usage.output } : {}),
		...(usage.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
		...(message.model ? { model: message.model } : {}),
	};
}

function textContent(text: string): ToolResultContent[] {
	return [{ type: ToolResultContentType.Text, text }];
}

/** A completed turn cannot leave a tool call running indefinitely. */
function settleToolCalls(parts: readonly ResponsePart[]): ResponsePart[] {
	return parts.map((part) => {
		if (part.kind !== ResponsePartKind.ToolCall || part.toolCall.status !== ToolCallStatus.Running) return part;
		const call = part.toolCall;
		return {
			kind: ResponsePartKind.ToolCall,
			toolCall: {
				status: ToolCallStatus.Cancelled,
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				displayName: call.displayName,
				invocationMessage: call.invocationMessage,
				...(call.toolInput !== undefined ? { toolInput: call.toolInput } : {}),
				reason: ToolCallCancellationReason.Skipped,
			},
		};
	});
}

type StoredTurnResult =
	| { readonly state: TurnState.Complete | TurnState.Cancelled }
	| { readonly state: TurnState.Error; readonly message: string | undefined };

/** A turn under construction, before its tool results have been matched up. */
interface PendingTurn {
	readonly id: string;
	readonly startedAt: string;
	readonly message: Message;
	readonly parts: ResponsePart[];
	/** Pi entries in this turn that a later context edit may target. */
	readonly entryIds: Set<string>;
	usage: UsageInfo | undefined;
	result: StoredTurnResult;
	/** Last non-user entry belonging to this turn; a user entry is not an inclusive anchor. */
	anchor: string | undefined;
}

export interface RebuildOptions {
	/** Prefix for generated turn ids; only needs to be stable within a chat. */
	readonly turnIdPrefix?: string;
}

export interface RebuiltHistory {
	readonly turns: Turn[];
	/**
	 * Turn id → the session entry that turn *ends* on.
	 *
	 * This is the anchor truncation needs. `chat/truncated` keeps turns up to
	 * and including the named one, and pi's `navigateTree` is inclusive for a
	 * non-user entry — so pointing it at a turn's last entry expresses exactly
	 * the protocol's meaning.
	 *
	 * User-only turns have no inclusive anchor: navigating to their user entry
	 * would remove that very turn. The first user entry is recorded under the
	 * empty key for "clear everything", which navigates to its parent.
	 */
	readonly anchors: ReadonlyMap<string, string>;
}

/** Key under which the whole-conversation anchor is stored. */
export const CLEAR_ALL_ANCHOR = "";

/**
 * Converts session entries into completed turns.
 *
 * Turn boundaries come from user messages: each one absorbs assistant attempts,
 * tool results, and compaction notices until the next user message. A Pi run
 * may retry across several assistant messages without starting a new AHP turn.
 */
export function rebuildHistory(entries: readonly SessionEntry[], options: RebuildOptions = {}): RebuiltHistory {
	const prefix = options.turnIdPrefix ?? "turn";
	const turns: Turn[] = [];
	const anchors = new Map<string, string>();
	let current: PendingTurn | undefined;
	/** toolCallId → index in `current.parts`, so a result can find its call. */
	let toolCallParts = new Map<string, number>();

	const closeTurn = (): void => {
		if (!current) {
			return;
		}
		if (current.anchor) {
			anchors.set(current.id, current.anchor);
		}
		const parts = settleToolCalls(current.parts);
		const result = current.result;
		turns.push({
			id: current.id,
			startedAt: current.startedAt,
			message: current.message,
			responseParts:
				result.state === TurnState.Error
					? [
							...parts,
							{
								kind: ResponsePartKind.Error,
								error: { errorType: "agentRunFailed", message: result.message ?? "The agent run failed" },
							},
						]
					: parts,
			usage: current.usage,
			state: result.state,
		});
		current = undefined;
		toolCallParts = new Map();
	};

	const openTurn = (entry: SessionEntry, message: Message): PendingTurn => {
		closeTurn();
		const turn: PendingTurn = {
			id: `${prefix}-${entry.id}`,
			startedAt: entry.timestamp,
			message,
			parts: [],
			entryIds: new Set([entry.id]),
			usage: undefined,
			result: { state: TurnState.Complete },
			anchor: undefined,
		};
		current = turn;
		return turn;
	};

	for (const entry of entries) {
		if (entry.type === "message" && (entry.message as unknown as StoredMessage).role === "user") {
			anchors.set(CLEAR_ALL_ANCHOR, anchors.get(CLEAR_ALL_ANCHOR) ?? entry.id);
		}

		if (entry.type === "compaction") {
			if (current) {
				// Pi does not persist whether this happened inside the prompt or
				// just after it, so keep the notice with the preceding user turn.
				current.parts.push(compactionNotification());
				current.anchor = entry.id;
			} else {
				const id = `${prefix}-compaction-${entry.id}`;
				turns.push({
					id,
					startedAt: entry.timestamp,
					message: { text: COMPACTION_NOTICE, origin: { kind: MessageKind.SystemNotification } },
					responseParts: [],
					usage: undefined,
					state: TurnState.Complete,
				});
				anchors.set(id, entry.id);
			}
			continue;
		}

		if (entry.type === "context_edit") {
			// Retry omissions are persisted *after* the failed assistant message.
			// An anchor before the edit would revive that attempt in model context.
			// Edits targeting older turns must not advance this turn's anchor.
			if (current?.entryIds.has(entry.targetId)) current.anchor = entry.id;
			continue;
		}

		if (entry.type !== "message") {
			// Model / thinking-level changes and labels carry no transcript.
			continue;
		}

		const message = entry.message as unknown as StoredMessage;
		switch (message.role) {
			case "user": {
				openTurn(entry, userMessageFromPiContent(message.content));
				break;
			}

			case "assistant": {
				// A truncated file may start with an assistant message. Keep its
				// content in a turn rather than dropping it with the absent prompt.
				const turn = current ?? openTurn(entry, userMessageFromPiContent(""));
				turn.entryIds.add(entry.id);
				let index = 0;
				for (const block of blocksOf(message)) {
					if (block.type === "text" && block.text) {
						turn.parts.push({
							kind: ResponsePartKind.Markdown,
							id: `${turn.id}:${entry.id}:${index}`,
							content: block.text,
						});
					} else if (block.type === "thinking" && block.thinking) {
						turn.parts.push({
							kind: ResponsePartKind.Reasoning,
							id: `${turn.id}:${entry.id}:${index}`,
							content: block.thinking,
						});
					} else if (block.type === "toolCall" && block.id) {
						toolCallParts.set(block.id, turn.parts.length);
						turn.parts.push({
							kind: ResponsePartKind.ToolCall,
							toolCall: {
								status: ToolCallStatus.Running,
								toolCallId: block.id,
								toolName: block.name ?? "tool",
								displayName: block.name ?? "tool",
								invocationMessage: block.name ?? "tool",
								toolInput: block.arguments === undefined ? undefined : JSON.stringify(block.arguments),
								confirmed: "setting",
							} as never,
						});
					}
					index += 1;
				}
				turn.usage = toUsage(message) ?? turn.usage;
				// A failed attempt is provisional: a later assistant response in
				// this user turn can recover, just as it does in the live mapper.
				if (message.stopReason === "aborted") {
					turn.result = { state: TurnState.Cancelled };
				} else if (message.stopReason === "error") {
					turn.result = { state: TurnState.Error, message: message.errorMessage };
				} else if (message.stopReason && message.stopReason !== "pending") {
					turn.result = { state: TurnState.Complete };
				}
				turn.anchor = entry.id;
				break;
			}

			case "toolResult": {
				if (!current) break;
				current.entryIds.add(entry.id);
				current.anchor = entry.id;
				const partIndex = message.toolCallId ? toolCallParts.get(message.toolCallId) : undefined;
				if (partIndex === undefined) break;
				const existing = current.parts[partIndex] as { toolCall: Record<string, unknown> } | undefined;
				if (!existing) {
					break;
				}
				const text = plainText(message);
				const success = message.isError !== true;
				current.parts[partIndex] = {
					kind: ResponsePartKind.ToolCall,
					toolCall: {
						...existing.toolCall,
						status: ToolCallStatus.Completed,
						success,
						pastTenseMessage: success ? `Ran ${message.toolName ?? "tool"}` : `${message.toolName ?? "tool"} failed`,
						...(text ? { content: textContent(text) } : {}),
					},
				} as ResponsePart;
				break;
			}

			case "bashExecution": {
				// pi records `!command` runs as their own message role; they are
				// part of the transcript even though no model produced them.
				const turn = current ?? openTurn(entry, userMessageFromPiContent(`!${message.command ?? ""}`));
				turn.entryIds.add(entry.id);
				turn.parts.push({
					kind: ResponsePartKind.SystemNotification,
					content: `\`${message.command ?? ""}\`\n\n${message.output ?? ""}`,
				});
				turn.anchor = entry.id;
				break;
			}

			default:
				break;
		}
	}

	closeTurn();
	return { turns, anchors };
}

/** Rebuilds the full user-visible branch; compaction affects only the model's context. */
export function rebuildTurnsFromSession(manager: SessionManager, options: RebuildOptions = {}): Turn[] {
	return rebuildHistoryFromSession(manager, options).turns;
}

/** As {@link rebuildTurnsFromSession}, with truncation anchors. */
export function rebuildHistoryFromSession(manager: SessionManager, options: RebuildOptions = {}): RebuiltHistory {
	return rebuildHistory(manager.getBranch(), options);
}
