/**
 * Activity descriptions.
 *
 * `SessionState.activity` / `ChatState.activity` are what a client shows next
 * to its spinner. Without them a long turn is an opaque wait even though pi's
 * event stream knows exactly which file is being read.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ActionType, type ChatState, chatReducer, type StateAction } from "@microsoft/agent-host-protocol";
import { initialChatState } from "../src/channels/chat.ts";
import { describeToolCall, RESPONDING_ACTIVITY, THINKING_ACTIVITY } from "../src/pi/activity.ts";
import { TurnMapper, userTurnStarted } from "../src/pi/event-mapper.ts";
import { checkSchema } from "./support/schema.ts";

const event = (value: object): AgentSessionEvent => value as unknown as AgentSessionEvent;

describe("activity descriptions", () => {
	it("names the file a read touches", () => {
		assert.equal(describeToolCall("read", { path: "/ws/src/main.ts" }, "/ws"), "Reading src/main.ts");
	});

	it("renders paths relative to the workspace", () => {
		// An absolute path is mostly noise the user already knows.
		assert.equal(describeToolCall("edit", { path: "/ws/a/b.ts" }, "/ws"), "Editing a/b.ts");
		assert.equal(describeToolCall("edit", { path: "/elsewhere/b.ts" }, "/ws"), "Editing /elsewhere/b.ts");
	});

	it("shows the command a bash call runs", () => {
		assert.equal(describeToolCall("bash", { command: "npm test" }), "Running npm test");
	});

	it("shortens the middle, keeping both informative ends", () => {
		const long = describeToolCall("bash", { command: `git log ${"x".repeat(200)} --oneline` });
		assert.ok(long.length < 80);
		assert.match(long, /^Running git log/);
		assert.match(long, /--oneline$/);
	});

	it("falls back to the tool's own name", () => {
		// Extension and custom tools still say something useful.
		assert.equal(describeToolCall("my_custom_tool", {}), "Running my_custom_tool");
	});

	it("copes with missing arguments", () => {
		assert.equal(describeToolCall("read", undefined), "Reading a file");
		assert.equal(describeToolCall("bash", {}), "Running a command");
	});
});

function run(events: AgentSessionEvent[]): { actions: StateAction[]; state: ChatState } {
	const mapper = new TurnMapper("t", 0, { workingDirectory: "/ws" });
	const actions: StateAction[] = [userTurnStarted("t", "go", "1970-01-01T00:00:00.000Z")];
	for (const e of events) {
		actions.push(...mapper.handle(e));
	}
	let state = initialChatState("ahp-chat:/a", "chat", "file:///ws");
	for (const action of actions) {
		state = chatReducer(state, action as never);
	}
	return { actions, state };
}

const activities = (actions: StateAction[]): (string | undefined)[] =>
	actions
		.filter((action) => action.type === ActionType.ChatActivityChanged)
		.map((action) => (action as { activity?: string }).activity);

describe("activity over a turn", () => {
	it("tracks thinking, tools, and responding in order", () => {
		const { actions } = run([
			event({ type: "agent_start" }),
			event({ type: "message_start", message: { role: "assistant" } }),
			event({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read", args: { path: "/ws/a.ts" } }),
			event({ type: "tool_execution_end", toolCallId: "tc1", toolName: "read", result: {}, isError: false }),
			event({
				type: "message_update",
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" },
			}),
			event({ type: "agent_settled" }),
		]);

		assert.deepEqual(activities(actions), [
			THINKING_ACTIVITY,
			"Reading a.ts",
			THINKING_ACTIVITY,
			RESPONDING_ACTIVITY,
			undefined,
		]);
	});

	it("clears the description when the turn ends", () => {
		// A stale one would leave the client showing "Reading …" against an
		// idle chat.
		const { state } = run([
			event({ type: "agent_start" }),
			event({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "ls" } }),
			event({ type: "agent_settled" }),
		]);

		assert.equal(state.activity, undefined);
	});

	it("clears it on a cancelled turn too", () => {
		const mapper = new TurnMapper("t", 0);
		mapper.handle(event({ type: "agent_start" }));
		const closing = mapper.finish("cancelled");

		assert.deepEqual(activities(closing), [undefined]);
	});

	it("does not re-send an unchanged description", () => {
		// Every delta of one response is still "Responding"; re-sending would
		// burn a serverSeq per token.
		const { actions } = run([
			event({ type: "agent_start" }),
			event({ type: "message_start", message: { role: "assistant" } }),
			...["a", "b", "c", "d"].map((delta) =>
				event({
					type: "message_update",
					message: { role: "assistant" },
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
				}),
			),
			event({ type: "agent_settled" }),
		]);

		assert.deepEqual(activities(actions), [THINKING_ACTIVITY, RESPONDING_ACTIVITY, undefined]);
	});

	it("emits schema-conforming actions", () => {
		const { actions } = run([
			event({ type: "agent_start" }),
			event({ type: "tool_execution_start", toolCallId: "tc1", toolName: "grep", args: { pattern: "TODO" } }),
			event({ type: "agent_settled" }),
		]);

		for (const action of actions.filter((a) => a.type === ActionType.ChatActivityChanged)) {
			assert.equal(checkSchema("actions", "StateAction", action), undefined);
		}
	});
});
