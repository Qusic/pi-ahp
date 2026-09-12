/**
 * Replays captured provider streams through the current pi and then through the
 * host mapper. The comparison stops at AHP-visible turn state: pi may change
 * event chunking or add internal events without breaking this adapter.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	type ChatState,
	chatReducer,
	ResponsePartKind,
	type StateAction,
	type Turn,
} from "@microsoft/agent-host-protocol";
import { initialChatState } from "../src/channels/chat.ts";
import { TurnMapper, userTurnStarted } from "../src/pi/event-mapper.ts";
import { loadRecordedFixtures } from "./support/recorded-fixtures.ts";
import { createReplayEnvironment, type ReplayEnvironment, replayTurns } from "./support/replay.ts";
import { assertValid } from "./support/schema.ts";

const fixtures = loadRecordedFixtures();

function settledRuns(events: readonly AgentSessionEvent[]): AgentSessionEvent[][] {
	const runs: AgentSessionEvent[][] = [];
	let current: AgentSessionEvent[] = [];
	for (const event of events) {
		current.push(event);
		if (event.type === "agent_settled") {
			runs.push(current);
			current = [];
		}
	}
	// Manual compaction events can follow the last prompt and have no AHP turn.
	// An unmatched agent run, on the other hand, means replay never settled.
	assert.equal(
		current.some((event) => event.type === "agent_start"),
		false,
		"last agent run never settled",
	);
	return runs;
}

function contentShape(content: unknown): unknown {
	if (!Array.isArray(content)) return undefined;
	return content.map((block) => {
		const value = block as { type?: unknown; text?: unknown };
		return {
			type: value.type,
			...(typeof value.text === "string" ? { hasText: value.text.length > 0 } : {}),
		};
	});
}

function partShape(part: Turn["responseParts"][number]): unknown {
	switch (part.kind) {
		case ResponsePartKind.Markdown:
		case ResponsePartKind.Reasoning:
			return { kind: part.kind, content: part.content };
		case ResponsePartKind.ToolCall: {
			const call = part.toolCall as typeof part.toolCall & {
				success?: boolean;
				pastTenseMessage?: string;
				toolInput?: string;
				content?: unknown;
				error?: unknown;
			};
			return {
				kind: part.kind,
				toolName: call.toolName,
				status: call.status,
				success: call.success,
				displayName: call.displayName,
				invocationMessage: call.invocationMessage,
				pastTenseMessage: call.pastTenseMessage,
				toolInput: call.toolInput,
				content: contentShape(call.content),
				hasError: call.error !== undefined,
			};
		}
		case ResponsePartKind.Error:
			return { kind: part.kind, error: part.error };
		default:
			return { kind: part.kind };
	}
}

function turnShape(turn: Turn): unknown {
	return {
		state: turn.state,
		message: turn.message.text,
		responseParts: turn.responseParts.map(partShape),
		usage: turn.usage,
	};
}

/** Maps each independent prompt run and removes timing and generated IDs. */
function ahpBehavior(events: readonly AgentSessionEvent[], prompt: string): unknown[] {
	return settledRuns(events).map((run, index) => {
		const turnId = `replay-${index}`;
		const mapper = new TurnMapper(turnId, 0);
		const actions: StateAction[] = [
			userTurnStarted(turnId, index === 0 ? prompt : `follow-up-${index}`, "1970-01-01T00:00:00.000Z"),
		];
		for (const event of run) actions.push(...mapper.handle(event));
		assert.equal(mapper.finished, true, `run ${index} never finished`);
		for (const action of actions) {
			assertValid("actions", "StateAction", action, `non-conforming ${action.type}`);
		}

		let state = initialChatState(`ahp-chat:/replay-${index}`, "Replay");
		for (const action of actions) state = chatReducer(state, action as never);
		assert.equal(state.activeTurn, undefined);
		return (state as ChatState).turns.map(turnShape);
	});
}

describe("recorded provider streams preserve AHP-visible behavior", { concurrency: false }, () => {
	let environment: ReplayEnvironment;

	before(() => {
		environment = createReplayEnvironment();
	});

	after(() => {
		environment.close();
	});

	for (const { scenario, fixture } of fixtures) {
		it(fixture.name, async () => {
			assert.ok(fixture.turns.length > 0, `${fixture.name}: no recorded provider turns`);
			const replayed = await replayTurns(fixture, scenario, environment);
			assert.deepEqual(
				ahpBehavior(replayed, fixture.prompt),
				ahpBehavior(fixture.events, fixture.prompt),
				`${fixture.name}: current pi events no longer produce the recorded AHP behavior`,
			);
		});
	}
});
