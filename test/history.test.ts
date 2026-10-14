import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ResponsePartKind,
	ToolCallCancellationReason,
	ToolCallStatus,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { COMPACTION_NOTICE } from "../src/pi/compaction-notice.ts";
import { CLEAR_ALL_ANCHOR, rebuildHistoryFromSession } from "../src/pi/history.ts";
import { initialTurnsWindow, loadOlderTurns } from "../src/pi/turn-paging.ts";
import { must } from "./support/assertions.ts";

function session(): SessionManager {
	return SessionManager.inMemory(join(tmpdir(), "pi-ahp-history-test"));
}

function user(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: 0 });
}

function assistant(
	manager: SessionManager,
	text: string,
	stopReason: "stop" | "error" | "aborted" | "toolUse" = "stop",
	errorMessage?: string,
): string {
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: 0,
	} as never);
}

describe("rebuilding a user-visible branch", () => {
	it("restores a final failure and cancellation, including the final error part", () => {
		const manager = session();
		user(manager, "failed prompt");
		assistant(manager, "partial", "error", "provider unavailable");
		user(manager, "cancelled prompt");
		assistant(manager, "partial", "aborted", "user cancelled");

		const { turns } = rebuildHistoryFromSession(manager);
		assert.equal(turns[0]?.state, TurnState.Error);
		assert.deepEqual(turns[0]?.responseParts.at(-1), {
			kind: ResponsePartKind.Error,
			error: { errorType: "agentRunFailed", message: "provider unavailable" },
		});
		assert.equal(turns[1]?.state, TurnState.Cancelled);
		assert.equal(
			turns[1]?.responseParts.some((part) => part.kind === ResponsePartKind.Error),
			false,
		);
	});

	it("lets a successful assistant attempt replace an earlier persisted error", () => {
		const manager = session();
		user(manager, "try again");
		const failed = assistant(manager, "partial", "error", "transient");
		manager.appendContextEdit(failed, null); // pi omits the retry attempt from model context, not from history.
		assistant(manager, "recovered");

		const turn = must(rebuildHistoryFromSession(manager).turns[0]);
		assert.equal(turn.state, TurnState.Complete);
		assert.deepEqual(
			turn.responseParts.filter((part) => part.kind === ResponsePartKind.Markdown).map((part) => part.content),
			["partial", "recovered"],
		);
		assert.equal(
			turn.responseParts.some((part) => part.kind === ResponsePartKind.Error),
			false,
		);
	});

	it("anchors a retry omission but not a context edit targeting an older turn", () => {
		const manager = session();
		user(manager, "older request");
		const older = assistant(manager, "older answer");
		const opened = user(manager, "retrying request");
		const failed = assistant(manager, "partial", "error", "try again");
		const omission = manager.appendContextEdit(failed, null);
		manager.appendContextEdit(older, null);

		const { turns, anchors } = rebuildHistoryFromSession(manager);
		assert.equal(turns[1]?.state, TurnState.Error);
		const anchor = must(anchors.get(`turn-${opened}`));
		assert.equal(anchor, omission);
		manager.branch(anchor); // As pi navigation does for a non-user truncation anchor.
		assert.deepEqual(
			manager.buildSessionContext().messages.map((message) => message.role),
			["user", "assistant", "user"],
			"keeping the turn must preserve its omission without retaining the later unrelated edit",
		);
	});

	it("keeps one turn across a compaction that retained only its assistant suffix", () => {
		const manager = session();
		user(manager, "older request");
		assistant(manager, "older answer");
		const opened = user(manager, "long request");
		const failed = assistant(manager, "failed attempt", "error", "context overflow");
		manager.appendContextEdit(failed, null);
		manager.appendCompaction("model summary", failed, 100);
		const recovered = assistant(manager, "recovered answer");
		user(manager, "next request");
		assistant(manager, "next answer");

		assert.equal(manager.buildContextEntries()[1]?.id, failed, "pi can keep a turn starting at its assistant");
		const { turns, anchors } = rebuildHistoryFromSession(manager);
		assert.deepEqual(
			turns.map((turn) => turn.message.text),
			["older request", "long request", "next request"],
		);
		const turn = must(turns[1]);
		assert.equal(turn.id, `turn-${opened}`);
		assert.equal(turn.state, TurnState.Complete);
		assert.deepEqual(
			turn.responseParts.map((part) => ("content" in part ? part.content : part.kind)),
			["failed attempt", COMPACTION_NOTICE, "recovered answer"],
		);
		assert.equal(anchors.get(turn.id), recovered);

		const initial = initialTurnsWindow(turns, 1);
		const older = loadOlderTurns(manager, "turn", initial.nextCursor, 1);
		assert.equal(older.turns[0]?.id, turn.id);
		assert.deepEqual(older.turns[0]?.responseParts, turn.responseParts, "paging must not repeat a retained assistant");
	});

	it("keeps compaction between user messages with the preceding turn", () => {
		const manager = session();
		const opened = user(manager, "first request");
		assistant(manager, "first answer");
		const compaction = manager.appendCompaction("model summary", opened, 100);
		user(manager, "next request");
		assistant(manager, "next answer");

		const { turns, anchors } = rebuildHistoryFromSession(manager);
		assert.deepEqual(
			turns.map((turn) => turn.message.text),
			["first request", "next request"],
		);
		assert.deepEqual(
			turns[0]?.responseParts.map((part) => ("content" in part ? part.content : part.kind)),
			["first answer", COMPACTION_NOTICE],
		);
		assert.equal(anchors.get(must(turns[0]).id), compaction);
	});

	it("does not anchor a user-only turn, and cancels an unfinished tool call", () => {
		const manager = session();
		const opened = user(manager, "unfinished");
		const pending = rebuildHistoryFromSession(manager);
		assert.equal(pending.anchors.get(must(pending.turns[0]).id), undefined);
		assert.equal(pending.anchors.get(CLEAR_ALL_ANCHOR), opened);

		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }],
			stopReason: "aborted",
			timestamp: 0,
		} as never);
		const turn = must(rebuildHistoryFromSession(manager).turns[0]);
		assert.equal(turn.state, TurnState.Cancelled);
		const part = must(turn.responseParts.find((candidate) => candidate.kind === ResponsePartKind.ToolCall));
		assert.equal(part.toolCall.status, ToolCallStatus.Cancelled);
		assert.equal(
			part.toolCall.status === ToolCallStatus.Cancelled && part.toolCall.reason,
			ToolCallCancellationReason.Skipped,
		);
	});
});
