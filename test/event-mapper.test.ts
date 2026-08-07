import { must } from "./harness.ts";
/**
 * The event mapper, exercised as a pure function.
 *
 * These tests feed recorded pi event sequences straight through the mapper and
 * reduce the result with the protocol's own `chatReducer`, so they assert what
 * a client would actually end up rendering — no socket, no model, no clock.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	chatReducer,
	ResponsePartKind,
	SessionStatus,
	type StateAction,
	ToolCallStatus,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { initialChatState } from "../src/channels/chat.ts";
import { TurnMapper, userTurnStarted } from "../src/pi/event-mapper.ts";
import { checkSchema } from "./support/schema.ts";

const CHAT_URI = "ahp-chat:/c1";
const TURN = "turn-1";

/**
 * pi's event types are fully specified (a real `AssistantMessage` carries
 * provider, model, usage, …). These fixtures deliberately supply only the
 * fields the mapper reads, which is also the point: the mapper must not depend
 * on anything else.
 */
function event(value: object): AgentSessionEvent {
	return value as unknown as AgentSessionEvent;
}

/** Shorthands for the pi events the mapper cares about. */
const pi = {
	agentStart: () => event({ type: "agent_start" }),
	agentEnd: (willRetry = false) => event({ type: "agent_end", messages: [], willRetry }),
	settled: () => event({ type: "agent_settled" }),
	assistantStart: () => event({ type: "message_start", message: { role: "assistant", content: [] } }),
	assistantEnd: (usage?: Record<string, number>) =>
		event({
			type: "message_end",
			message: { role: "assistant", content: [], ...(usage ? { usage, model: "test-model" } : {}) },
		}),
	text: (contentIndex: number, delta: string) =>
		event({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex, delta },
		}),
	thinking: (contentIndex: number, delta: string) =>
		event({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "thinking_delta", contentIndex, delta },
		}),
	textEnd: (contentIndex: number, content: string) =>
		event({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_end", contentIndex, content },
		}),
	thinkingEnd: (contentIndex: number, content: string) =>
		event({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "thinking_end", contentIndex, content },
		}),
	toolStart: (contentIndex: number, id: string, name: string) =>
		event({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex,
				partial: {
					content: Array.from({ length: contentIndex + 1 }, (_, i) =>
						i === contentIndex ? { type: "toolCall", id, name } : {},
					),
				},
			},
		}),
	toolDelta: (contentIndex: number, delta: string) =>
		event({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "toolcall_delta", contentIndex, delta },
		}),
	toolEnd: (contentIndex: number, id: string, name: string, args: unknown) =>
		event({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex,
				toolCall: { id, name, arguments: args },
			},
		}),
	execEnd: (toolCallId: string, toolName: string, text: string, isError = false) =>
		event({
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: { content: [{ type: "text", text }] },
			isError,
		}),
	streamError: (message: string, aborted = false) =>
		event({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: {
				type: "error",
				reason: aborted ? "aborted" : "error",
				error: { errorMessage: message, stopReason: aborted ? "aborted" : "error" },
			},
		}),
};

/** Runs a turn end-to-end and returns both the actions and the reduced state. */
function runTurn(events: AgentSessionEvent[], text = "Hello"): { actions: StateAction[]; state: ChatState } {
	const mapper = new TurnMapper(TURN, 0);
	const actions: StateAction[] = [userTurnStarted(TURN, text, "1970-01-01T00:00:00.000Z")];
	for (const event of events) {
		actions.push(...mapper.handle(event));
	}

	let state = initialChatState(CHAT_URI, "Test chat");
	for (const action of actions) {
		state = chatReducer(state, action as never);
	}
	return { actions, state };
}

describe("event mapper — turn boundary", () => {
	it("spans several agent runs in a single turn", () => {
		// An auto-retry produces a second agent_start/agent_end pair. Closing
		// the turn on the first agent_end would make every later action a
		// silent no-op in the reducer.
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "first attempt"),
			pi.agentEnd(true),
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "second attempt"),
			pi.assistantEnd(),
			pi.agentEnd(false),
			pi.settled(),
		]);

		assert.equal(state.activeTurn, undefined);
		assert.equal(state.turns.length, 1);
		assert.equal(state.turns[0]?.state, TurnState.Complete);
		// Both attempts survive as separate parts — the protocol has no action
		// that removes one, so the retry cannot rewrite history.
		const markdown = must(state.turns[0]).responseParts.filter((p) => p.kind === ResponsePartKind.Markdown);
		assert.deepEqual(
			markdown.map((p) => (p as { content: string }).content),
			["first attempt", "second attempt"],
		);
	});

	it("only closes the turn on agent_settled", () => {
		const mapper = new TurnMapper(TURN, 0);
		const beforeSettle = [pi.agentStart(), pi.assistantStart(), pi.text(0, "hi"), pi.agentEnd()].flatMap((event) =>
			mapper.handle(event),
		);

		assert.equal(
			beforeSettle.some((action) => action.type === ActionType.ChatTurnComplete),
			false,
		);
		// The terminator now travels behind an activity clear, so look for it
		// rather than assuming it is first.
		const closing = mapper.handle(pi.settled());
		assert.ok(closing.some((action) => action.type === ActionType.ChatTurnComplete));
	});

	it("reports an aborted run as cancelled, not complete", () => {
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "partial"),
			pi.streamError("aborted by user", true),
			pi.settled(),
		]);

		assert.equal(state.turns[0]?.state, TurnState.Cancelled);
	});

	it("reports a failed run as an error and marks the chat", () => {
		const { state } = runTurn([pi.agentStart(), pi.assistantStart(), pi.streamError("overloaded_error"), pi.settled()]);

		assert.equal(state.turns[0]?.state, TurnState.Error);
		assert.equal(state.turns[0]?.error?.message, "overloaded_error");
		assert.ok(state.status & SessionStatus.Error);
	});

	it("ignores events after the turn has closed", () => {
		const mapper = new TurnMapper(TURN, 0);
		mapper.handle(pi.settled());

		assert.deepEqual(mapper.handle(pi.text(0, "late")), []);
		assert.deepEqual(mapper.finish(), []);
	});

	it("can be closed without agent_settled", () => {
		// An extension command handled entirely by pi never reaches the model,
		// so no agent event ever arrives; the turn must still terminate.
		const mapper = new TurnMapper(TURN, 0);
		const actions = mapper.finish("complete");

		assert.equal(actions[0]?.type, ActionType.ChatTurnComplete);
	});
});

describe("event mapper — part identity", () => {
	it("keeps contentIndex collisions across messages apart", () => {
		// pi restarts contentIndex at 0 for every assistant message. Using it
		// directly as a partId would append the second message's text to the
		// first message's paragraph.
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "first message"),
			pi.assistantEnd(),
			pi.assistantStart(),
			pi.text(0, "second message"),
			pi.assistantEnd(),
			pi.settled(),
		]);

		const markdown = must(state.turns[0]).responseParts.filter((p) => p.kind === ResponsePartKind.Markdown);
		assert.equal(markdown.length, 2);
		assert.deepEqual(
			markdown.map((p) => (p as { content: string }).content),
			["first message", "second message"],
		);
	});

	it("appends consecutive deltas into one part", () => {
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "Hello"),
			pi.text(0, ", "),
			pi.text(0, "world"),
			pi.settled(),
		]);

		const [part] = must(state.turns[0]).responseParts;
		assert.equal((part as { content: string }).content, "Hello, world");
	});

	it("routes thinking into a reasoning part, separate from markdown", () => {
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.thinking(0, "let me think"),
			pi.thinking(0, " harder"),
			pi.text(1, "the answer"),
			pi.settled(),
		]);

		const parts = must(state.turns[0]).responseParts;
		assert.equal(parts[0]?.kind, ResponsePartKind.Reasoning);
		assert.equal((parts[0] as { content: string }).content, "let me think harder");
		assert.equal(parts[1]?.kind, ResponsePartKind.Markdown);
	});

	it("creates parts in arrival order so interleaving survives", () => {
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "before"),
			pi.toolStart(1, "tc-1", "bash"),
			pi.toolEnd(1, "tc-1", "bash", { command: "ls" }),
			pi.text(2, "after"),
			pi.settled(),
		]);

		assert.deepEqual(
			must(state.turns[0]).responseParts.map((part) => part.kind),
			[ResponsePartKind.Markdown, ResponsePartKind.ToolCall, ResponsePartKind.Markdown],
		);
	});

	it("recovers a block a provider never streamed", () => {
		// Observed live: some models emit `thinking_start` / `thinking_end`
		// with no `thinking_delta` in between. Creating parts only from deltas
		// would drop the content silently, exactly like targeting an unknown
		// partId does.
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.thinkingEnd(0, "reasoned without streaming"),
			pi.textEnd(1, "answered without streaming"),
			pi.settled(),
		]);

		const parts = must(state.turns[0]).responseParts;
		assert.equal(parts[0]?.kind, ResponsePartKind.Reasoning);
		assert.equal((parts[0] as { content: string }).content, "reasoned without streaming");
		assert.equal(parts[1]?.kind, ResponsePartKind.Markdown);
		assert.equal((parts[1] as { content: string }).content, "answered without streaming");
	});

	it("does not duplicate a block that was streamed", () => {
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "Hello"),
			pi.text(0, " world"),
			pi.textEnd(0, "Hello world"),
			pi.settled(),
		]);

		const parts = must(state.turns[0]).responseParts;
		assert.equal(parts.length, 1);
		assert.equal((parts[0] as { content: string }).content, "Hello world");
	});

	it("emits no part for an empty delta", () => {
		const { state } = runTurn([pi.agentStart(), pi.assistantStart(), pi.text(0, ""), pi.settled()]);

		assert.deepEqual(must(state.turns[0]).responseParts, []);
	});
});

describe("event mapper — tool calls", () => {
	it("drives a tool call from streaming to completed without confirmation", () => {
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.toolStart(0, "tc-1", "bash"),
			pi.toolDelta(0, '{"command":'),
			pi.toolDelta(0, '"ls"}'),
			pi.toolEnd(0, "tc-1", "bash", { command: "ls" }),
			pi.assistantEnd(),
			pi.execEnd("tc-1", "bash", "file-a\nfile-b"),
			pi.settled(),
		]);

		const part = must(state.turns[0]).responseParts.find((p) => p.kind === ResponsePartKind.ToolCall);
		assert.ok(part);
		const toolCall = (part as { toolCall: { status: string; toolName: string } }).toolCall;
		assert.equal(toolCall.status, ToolCallStatus.Completed);
		assert.equal(toolCall.toolName, "bash");
	});

	it("never enters pending-confirmation", () => {
		// pi has no permission system, so there is nothing for a client to
		// approve. Auto-confirming is the protocol's `confirmed` path, and it
		// means no conforming client renders approve/deny UI for these calls.
		const { actions } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.toolStart(0, "tc-1", "bash"),
			pi.toolEnd(0, "tc-1", "bash", { command: "ls" }),
			pi.execEnd("tc-1", "bash", "ok"),
			pi.settled(),
		]);

		const ready = actions.find((action) => action.type === ActionType.ChatToolCallReady);
		assert.ok(ready);
		assert.equal((ready as { confirmed?: string }).confirmed, "setting");
	});

	it("marks a failed tool call as unsuccessful", () => {
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.toolStart(0, "tc-1", "bash"),
			pi.toolEnd(0, "tc-1", "bash", { command: "false" }),
			pi.execEnd("tc-1", "bash", "boom", true),
			pi.settled(),
		]);

		const part = must(state.turns[0]).responseParts.find((p) => p.kind === ResponsePartKind.ToolCall);
		const toolCall = (part as { toolCall: { status: string; success?: boolean } }).toolCall;
		assert.equal(toolCall.status, ToolCallStatus.Completed);
		assert.equal(toolCall.success, false);
	});

	it("force-cancels a tool call still running when the turn ends", () => {
		// The reducer does this for us; asserting it here pins the behaviour
		// our mapper relies on when an abort lands mid-tool.
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.toolStart(0, "tc-1", "bash"),
			pi.toolEnd(0, "tc-1", "bash", { command: "sleep 100" }),
			pi.settled(),
		]);

		const part = must(state.turns[0]).responseParts.find((p) => p.kind === ResponsePartKind.ToolCall);
		assert.equal((part as { toolCall: { status: string } }).toolCall.status, ToolCallStatus.Cancelled);
	});

	it("ignores tool events for a call it never saw", () => {
		const mapper = new TurnMapper(TURN, 0);
		const actions = mapper.handle(pi.execEnd("unknown", "bash", "x"));

		// No tool-call action: there is nothing to complete. The activity
		// change still goes out — it is display state, not bookkeeping.
		assert.equal(
			actions.some((action) => action.type === ActionType.ChatToolCallComplete),
			false,
		);
	});
});

describe("event mapper — usage and schema", () => {
	it("carries token usage onto the turn", () => {
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "hi"),
			pi.assistantEnd({ input: 100, output: 20, cacheRead: 5 }),
			pi.settled(),
		]);

		assert.deepEqual(state.turns[0]?.usage, {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 5,
			model: "test-model",
		});
	});

	it("keeps the usage fields the protocol has no slot for", () => {
		// pi reports cache writes, a reasoning-token breakdown and computed
		// cost; `UsageInfo` has fields for none of them. Dropping them would
		// lose exactly the numbers a client needs to show what a turn cost.
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "hi"),
			pi.assistantEnd({ input: 3, output: 49, cacheRead: 0, cacheWrite: 2699, reasoning: 20, totalTokens: 2751 }),
			pi.settled(),
		]);

		assert.deepEqual(state.turns[0]?.usage?._meta, {
			cacheWriteTokens: 2699,
			reasoningTokens: 20,
			totalTokens: 2751,
		});
	});

	it("emits only schema-conforming actions", () => {
		const { actions } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.thinking(0, "hmm"),
			pi.text(1, "answer"),
			pi.toolStart(2, "tc-1", "read"),
			pi.toolDelta(2, '{"path":"a"}'),
			pi.toolEnd(2, "tc-1", "read", { path: "a" }),
			pi.assistantEnd({ input: 1, output: 2, cacheRead: 0 }),
			pi.execEnd("tc-1", "read", "contents"),
			pi.settled(),
		]);

		for (const action of actions) {
			assert.equal(checkSchema("actions", "StateAction", action), undefined, `bad action: ${action.type}`);
		}
	});
});

describe("event mapper — outcome from stopReason", () => {
	it("treats an aborted assistant message as a cancelled turn", () => {
		// Aborting before anything streams produces no `error` delta at all:
		// the only signal is the finished message's stopReason. Observed live in
		// the `abort` fixture.
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			event({
				type: "message_end",
				message: { role: "assistant", stopReason: "aborted", errorMessage: "Request aborted" },
			}),
			pi.settled(),
		]);

		assert.equal(state.turns[0]?.state, TurnState.Cancelled);
	});

	it("treats a failed assistant message as an error turn", () => {
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			event({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "upstream exploded" },
			}),
			pi.settled(),
		]);

		assert.equal(state.turns[0]?.state, TurnState.Error);
		assert.equal(state.turns[0]?.error?.message, "upstream exploded");
	});
});

describe("event mapper — injected messages", () => {
	it("gives an injected user message its own turn", () => {
		// pi stores a steering message as an ordinary user message with nothing
		// marking it as steering, so a rebuild from disk necessarily makes it a
		// turn. The live path has to match or the same conversation renders
		// differently before and after a reload.
		const { state } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "1\n2\n3"),
			pi.assistantEnd(),
			event({ type: "message_start", message: { role: "user", content: "Stop counting." } }),
			event({ type: "message_end", message: { role: "user", content: "Stop counting." } }),
			pi.assistantStart(),
			pi.text(0, "STOPPED"),
			pi.assistantEnd(),
			pi.settled(),
		]);

		assert.equal(state.turns.length, 2);
		assert.equal(state.turns[0]?.message.text, "Hello");
		assert.equal(state.turns[1]?.message.text, "Stop counting.");
		assert.equal((must(state.turns[1]).responseParts[0] as { content: string }).content, "STOPPED");
	});

	it("does not split on the run's own opening prompt", () => {
		// The first user message is the prompt the client already opened the
		// turn with; splitting there would produce an empty leading turn.
		const { state } = runTurn([
			pi.agentStart(),
			event({ type: "message_start", message: { role: "user", content: "Hello" } }),
			event({ type: "message_end", message: { role: "user", content: "Hello" } }),
			pi.assistantStart(),
			pi.text(0, "hi"),
			pi.settled(),
		]);

		assert.equal(state.turns.length, 1);
	});

	it("keeps part ids unique across a split", () => {
		const { actions } = runTurn([
			pi.agentStart(),
			pi.assistantStart(),
			pi.text(0, "before"),
			event({ type: "message_start", message: { role: "user", content: "switch" } }),
			pi.assistantStart(),
			pi.text(0, "after"),
			pi.settled(),
		]);

		const ids = actions
			.filter((action) => action.type === ActionType.ChatResponsePart)
			.map((action) => ("id" in action.part ? action.part.id : undefined));
		assert.equal(new Set(ids).size, ids.length, "part ids collided across the split");
	});
});
