/**
 * Replays recorded pi event streams through the mapper, offline.
 *
 * These fixtures were captured from a real model (`scripts/capture-fixtures.ts`) and
 * scrubbed of machine- and tenant-specific values. They exist because scripted
 * backends only ever prove that the mapper handles the event stream *I imagined*;
 * two real bugs — a reasoning block delivered with no deltas, and usage fields
 * with nowhere to go — only showed up against a genuine capture.
 *
 * The assertions are deliberately structural rather than exact-output: the model
 * is free to phrase things differently on a re-capture, but the *shape* of the
 * turn must hold.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	chatReducer,
	ResponsePartKind,
	type StateAction,
	ToolCallStatus,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { initialChatState } from "../src/channels/chat.ts";
import { TurnMapper, userTurnStarted } from "../src/pi/event-mapper.ts";
import { must } from "./harness.ts";
import { checkSchema } from "./support/schema.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CHAT_URI = "ahp-chat:/replay";
const TURN_ID = "replay-turn";

interface Fixture {
	readonly name: string;
	readonly description: string;
	readonly prompt: string;
	readonly events: AgentSessionEvent[];
}

interface Replayed {
	readonly fixture: Fixture;
	readonly actions: StateAction[];
	readonly state: ChatState;
}

function loadFixtures(): Fixture[] {
	return readdirSync(FIXTURE_DIR)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as Fixture);
}

function replay(fixture: Fixture): Replayed {
	const mapper = new TurnMapper(TURN_ID, 0);
	const actions: StateAction[] = [userTurnStarted(TURN_ID, fixture.prompt, "1970-01-01T00:00:00.000Z")];
	for (const event of fixture.events) {
		actions.push(...mapper.handle(event));
	}

	let state = initialChatState(CHAT_URI, "Replay");
	for (const action of actions) {
		state = chatReducer(state, action as never);
	}
	return { fixture, actions, state };
}

const fixtures = loadFixtures();
const byName = new Map(fixtures.map((fixture) => [fixture.name, replay(fixture)]));

function get(name: string): Replayed {
	const replayed = byName.get(name);
	assert.ok(replayed, `missing fixture: ${name} — run \`node scripts/capture-fixtures.ts\``);
	return replayed;
}

function markdownText(state: ChatState): string {
	const turn = state.turns[0] ?? state.activeTurn;
	return (turn?.responseParts ?? [])
		.filter((part) => part.kind === ResponsePartKind.Markdown)
		.map((part) => (part as { content: string }).content)
		.join("");
}

interface ReplayedToolCall {
	readonly status: string;
	readonly toolName: string;
	readonly success?: boolean;
	readonly displayName?: string;
	readonly invocationMessage?: string;
	readonly pastTenseMessage?: string;
	readonly toolInput?: string;
	readonly content?: readonly { readonly type: string; readonly text?: string }[];
	readonly error?: { readonly message?: string };
}

function toolCalls(state: ChatState): ReplayedToolCall[] {
	const turn = state.turns[0] ?? state.activeTurn;
	return (turn?.responseParts ?? [])
		.filter((part) => part.kind === ResponsePartKind.ToolCall)
		.map((part) => (part as { toolCall: ReplayedToolCall }).toolCall);
}

/** The text a tool reported, as the client would concatenate it. */
function toolResultText(call: ReplayedToolCall): string {
	return (call.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

describe("recorded stream replay — invariants", () => {
	it("has fixtures to replay", () => {
		assert.ok(fixtures.length >= 5, `expected the captured corpus, found ${fixtures.length}`);
	});

	for (const { fixture, actions, state } of byName.values()) {
		describe(`${fixture.name} — ${fixture.description}`, () => {
			it("closes every turn it opens, exactly once each", () => {
				const opened = actions.filter((action) => action.type === ActionType.ChatTurnStarted).length;
				const terminators = actions.filter(
					(action) =>
						action.type === ActionType.ChatTurnComplete ||
						action.type === ActionType.ChatTurnCancelled ||
						action.type === ActionType.ChatError,
				);

				// More than one turn means pi injected a message mid-run; each
				// still has to terminate exactly once.
				assert.equal(terminators.length, opened, "every opened turn must terminate once");
				assert.equal(state.activeTurn, undefined);
				assert.equal(state.turns.length, opened);
			});

			it("emits only schema-conforming actions", () => {
				for (const action of actions) {
					assert.equal(checkSchema("actions", "StateAction", action), undefined, `non-conforming ${action.type}`);
				}
			});

			it("leaves no tool call unresolved", () => {
				for (const call of toolCalls(state)) {
					assert.ok(
						call.status === ToolCallStatus.Completed || call.status === ToolCallStatus.Cancelled,
						`${call.toolName} ended in ${call.status}`,
					);
				}
			});

			it("targets every delta at a part that exists", () => {
				// A delta naming an unknown partId is a silent no-op in the
				// reducer, so a mismatch here would lose content with no error.
				const created = new Set<string>();
				for (const action of actions) {
					if (action.type === ActionType.ChatResponsePart && "id" in action.part) {
						created.add(action.part.id);
					}
					if (action.type === ActionType.ChatDelta || action.type === ActionType.ChatReasoning) {
						assert.ok(created.has(action.partId), `delta targets unknown part ${action.partId}`);
					}
				}
			});

			it("keeps every response part id unique", () => {
				const ids = actions
					.filter((action) => action.type === ActionType.ChatResponsePart)
					.map((action) => ("id" in action.part ? action.part.id : undefined));
				assert.equal(new Set(ids).size, ids.length, "part ids collided within a turn");
			});
		});
	}
});

describe("recorded stream replay — per scenario", () => {
	it("plain-text: answers with no tool calls", () => {
		const { state } = get("plain-text");
		assert.equal(state.turns[0]?.state, TurnState.Complete);
		assert.equal(toolCalls(state).length, 0);
		assert.match(markdownText(state), /PONG/i);
	});

	it("describes a tool call in terms a user can act on", () => {
		// These three fields are what a client renders around a tool call: a
		// heading, a line while it runs, and a line once it has. pi knows which
		// file was read or which command ran, and a message that only repeats the
		// tool's name spends all three on saying `read` three times.
		for (const { fixture, state } of byName.values()) {
			for (const call of toolCalls(state)) {
				if (!call.toolInput || call.toolInput === "{}") {
					continue;
				}
				assert.notEqual(
					call.invocationMessage,
					call.toolName,
					`${fixture.name}: ${call.toolName} announces itself with nothing but its own name`,
				);
				// The two lines sit next to each other in a transcript, one for a
				// call in flight and one for a call that finished. Identical text
				// leaves a completed call still claiming to be running.
				assert.notEqual(
					call.pastTenseMessage,
					call.invocationMessage,
					`${fixture.name}: ${call.toolName} still says it is ${call.invocationMessage} after it finished`,
				);
			}
		}
	});

	it("shows a tool's subject rather than its arguments as JSON", () => {
		// `toolInput` is what a client renders for the call itself, and the
		// protocol carries no structured parameters beside it, so serialising the
		// argument object spends the field on quoting and braces. Each of pi's
		// tools has one argument that says what the call is about.
		for (const { fixture, state } of byName.values()) {
			for (const call of toolCalls(state)) {
				if (call.toolInput === undefined) {
					continue;
				}
				assert.ok(
					!call.toolInput.startsWith("{"),
					`${fixture.name}: ${call.toolName} shows its arguments as JSON: ${call.toolInput.slice(0, 60)}`,
				);
			}
		}
	});

	it("tool-edit: hands the client the patch, not a count of edited blocks", () => {
		// pi computes a unified diff for every edit and reports only how many
		// blocks it replaced. The patch is the part a client can render — the
		// same monospace, syntax-highlighted block a shell command gets.
		const { state } = get("tool-edit");
		const edits = toolCalls(state).filter((call) => call.toolName === "edit");
		assert.ok(edits.length >= 1, "expected an edit call");
		for (const call of edits) {
			const shown = toolResultText(call);
			assert.match(shown, /^--- |\n--- /, `edit result carries no patch: ${shown.slice(0, 80)}`);
			assert.match(shown, /^\+.*$/m, "a patch with no added lines is not a patch");
		}
	});

	it("single-tool: runs one tool and answers from its result", () => {
		const { state } = get("single-tool");
		assert.equal(state.turns[0]?.state, TurnState.Complete);
		assert.ok(toolCalls(state).length >= 1);
		assert.match(markdownText(state), /ALPHA BETA GAMMA/);
	});

	it("parallel-tools: keeps several tool calls in one message distinct", () => {
		const { state } = get("parallel-tools");
		const calls = toolCalls(state);
		assert.ok(calls.length >= 2, `expected multiple tool calls, got ${calls.length}`);
		assert.match(markdownText(state), /FIRST/);
		assert.match(markdownText(state), /SECOND/);
	});

	it("tool-loop: spans several assistant messages without part collisions", () => {
		const { fixture, state } = get("tool-loop");
		const assistantMessages = fixture.events.filter(
			(event) =>
				event.type === "message_start" && (event as { message?: { role?: string } }).message?.role === "assistant",
		).length;

		// The scenario exists to produce more than one assistant message, which
		// is where pi's contentIndex restarts at 0.
		assert.ok(assistantMessages >= 2, `expected multiple assistant messages, got ${assistantMessages}`);
		assert.equal(state.turns[0]?.state, TurnState.Complete);
		assert.match(markdownText(state), /42/);
	});

	it("tool-error: surfaces a failed tool without failing the turn", () => {
		const { state } = get("tool-error");
		const failed = toolCalls(state).filter((call) => call.success === false);
		assert.ok(failed.length >= 1, "expected a failed tool call");

		// What the client shows for a failure is `error.message`. pi says why —
		// here an ENOENT naming the missing path — and a message that only
		// repeats the tool's name tells the user nothing they did not know.
		for (const call of failed) {
			const reported = toolResultText(call);
			assert.ok(reported.length > 0, `${call.toolName}: no failure text to show`);
			assert.equal(
				call.error?.message,
				reported,
				`${call.toolName}: error.message should carry what pi reported, not a restatement of the tool name`,
			);
		}
		// The agent recovers and answers, so the turn itself still completes.
		assert.equal(state.turns[0]?.state, TurnState.Complete);
	});

	it("abort: ends the turn as cancelled", () => {
		const { state } = get("abort");
		assert.equal(state.turns[0]?.state, TurnState.Cancelled);
	});

	it("steering: the injected message becomes its own turn", () => {
		const { fixture, state } = get("steering");
		const injectedUserMessages = fixture.events.filter(
			(event) => event.type === "message_start" && (event as { message?: { role?: string } }).message?.role === "user",
		).length;
		assert.ok(injectedUserMessages >= 2, "expected the steering message to appear mid-run");

		// pi stores an injected message as an ordinary user message, with
		// nothing marking it as steering — so a rebuild from disk necessarily
		// makes it a turn. The live path matches, or the same conversation would
		// render differently before and after a reload.
		assert.equal(state.turns.length, injectedUserMessages);
		assert.match(must(state.turns.at(-1)).message.text, /Stop counting/);
	});
});
