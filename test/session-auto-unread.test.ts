/** Server-origin unread state after an actual turn outcome, not a guessed viewer state. */

import assert from "node:assert/strict";
import fs, { readFileSync, statSync } from "node:fs";
import { it } from "node:test";
import {
	ActionType,
	type ChatState,
	MessageKind,
	ResponsePartKind,
	type SessionState,
	SessionStatus,
} from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL } from "../src/core/channels.ts";
import { archiveSessionFixture as fixture, nextArchiveEvent as nextEvent } from "./support/archive-session.ts";
import { must } from "./support/assertions.ts";

for (const outcome of ["complete", "cancel", "error"] as const) {
	it(`marks a read session unread after a ${outcome} turn`, async (t) => {
		const f = await fixture(t);
		f.initialHost.dispatchServerAction(f.chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "unread-turn",
			startedAt: f.timestamp.toISOString(),
			message: { text: "hello", origin: { kind: MessageKind.User } },
		});
		f.client.dispatch(f.session, { type: ActionType.SessionIsReadChanged, isRead: true });
		await f.settle();
		const committed: boolean[] = [];
		f.initialHost.onActionCommitted((channel, action) => {
			if (channel === f.session && action.type === ActionType.SessionIsReadChanged) committed.push(action.isRead);
		});
		const writes = t.mock.method(f.metadata.sessions, "set");
		const roots = outcome === "complete" ? f.client.attachSubscription(ROOT_CHANNEL) : undefined;
		const turnId = "unread-turn";
		const duration = 1000;
		const actions = {
			complete: { type: ActionType.ChatTurnComplete, turnId, duration },
			cancel: { type: ActionType.ChatTurnCancelled, turnId, duration },
			error: {
				type: ActionType.ChatError,
				turnId,
				duration,
				part: { kind: ResponsePartKind.Error, error: { errorType: "test", message: "failed" } },
			},
		} as const;
		f.initialHost.dispatchServerAction(f.chat, actions[outcome]);
		await f.settle();

		assert.deepEqual(committed, [false]);
		assert.deepEqual(
			writes.mock.calls.map((call) => call.arguments),
			[[f.id, "read", false]],
		);
		assert.equal(f.metadata.sessions.get(f.id, "read"), false);
		const expectedStatus = outcome === "error" ? SessionStatus.Error : SessionStatus.Idle;
		assert.equal((f.initialHost.store.get(f.session) as SessionState).status & SessionStatus.IsRead, 0);
		const list = await f.client.request("listSessions", { channel: ROOT_CHANNEL });
		assert.equal(must(list.items[0]).status, expectedStatus);
		if (roots) {
			const first = await nextEvent(roots);
			assert.ok(first.type === "sessionSummaryChanged");
			const unread = first.params.changes.status === SessionStatus.Idle ? first : await nextEvent(roots);
			assert.ok(unread.type === "sessionSummaryChanged");
			assert.equal(unread.params.channel, ROOT_CHANNEL);
			assert.equal(unread.params.session, f.session);
			assert.equal(unread.params.changes.status, SessionStatus.Idle);
			assert.equal(f.createBackend.mock.callCount(), 0);
			assert.deepEqual(readFileSync(f.file), f.history);
			assert.equal(statSync(f.file).mtime.toISOString(), f.timestamp.toISOString());
		}
	});
}

it("skips already-unread, repeated and archived turn outcomes", async (t) => {
	const f = await fixture(t);
	const writes = t.mock.method(f.metadata.sessions, "set");
	const complete = (turnId: string) =>
		f.initialHost.dispatchServerAction(f.chat, { type: ActionType.ChatTurnComplete, turnId, duration: 1000 });
	const start = (turnId: string) =>
		f.initialHost.dispatchServerAction(f.chat, {
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: f.timestamp.toISOString(),
			message: { text: "hello", origin: { kind: MessageKind.User } },
		});
	start("initial");
	complete("initial");
	await f.settle();
	assert.equal(writes.mock.callCount(), 0, "an initially unread session needs no write");

	f.client.dispatch(f.session, { type: ActionType.SessionIsReadChanged, isRead: true });
	await f.settle();
	complete("initial"); // A stale terminal action must not clear a later explicit read.
	await f.settle();
	assert.equal(f.metadata.sessions.get(f.id, "read"), true);
	assert.deepEqual(
		writes.mock.calls.map((call) => call.arguments),
		[[f.id, "read", true]],
	);

	f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
	await f.settle();
	start("archived");
	complete("archived");
	await f.settle();
	assert.equal(
		(f.initialHost.store.get(f.session) as SessionState).status & SessionStatus.IsRead,
		SessionStatus.IsRead,
	);
	assert.equal(f.metadata.sessions.get(f.id, "read"), true);
	assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
	assert.equal(
		writes.mock.calls.some((call) => call.arguments[1] === "read" && call.arguments[2] === false),
		false,
	);
});

it("orders automatic unread before a later client read while session work is queued", async (t) => {
	const f = await fixture(t);
	f.initialHost.dispatchServerAction(f.chat, {
		type: ActionType.ChatTurnStarted,
		turnId: "queued-unread",
		startedAt: f.timestamp.toISOString(),
		message: { text: "hello", origin: { kind: MessageKind.User } },
	});
	f.client.dispatch(f.session, { type: ActionType.SessionIsReadChanged, isRead: true });
	await f.settle();
	const committed: boolean[] = [];
	f.initialHost.onActionCommitted((channel, action) => {
		if (channel === f.session && action.type === ActionType.SessionIsReadChanged) committed.push(action.isRead);
	});
	const gate = Promise.withResolvers<void>();
	const blocked = f.sessions.operations.run(f.id, () => gate.promise);
	try {
		f.initialHost.dispatchServerAction(f.chat, {
			type: ActionType.ChatTurnComplete,
			turnId: "queued-unread",
			duration: 1000,
		});
		await f.client.ping();
		assert.equal(f.metadata.sessions.get(f.id, "read"), true, "automatic unread must wait its turn");
		f.client.dispatch(f.session, { type: ActionType.SessionIsReadChanged, isRead: true });
		await f.client.ping();
		gate.resolve();
		await f.settle();
		assert.deepEqual(committed, [false, true]);
		assert.equal(f.metadata.sessions.get(f.id, "read"), true);
		assert.equal(
			(f.initialHost.store.get(f.session) as SessionState).status & SessionStatus.IsRead,
			SessionStatus.IsRead,
		);
	} finally {
		gate.resolve();
		await blocked;
	}
});

it("does not claim unread when the server-origin metadata write fails", async (t) => {
	const f = await fixture(t);
	f.initialHost.dispatchServerAction(f.chat, {
		type: ActionType.ChatTurnStarted,
		turnId: "failed-write",
		startedAt: f.timestamp.toISOString(),
		message: { text: "hello", origin: { kind: MessageKind.User } },
	});
	f.client.dispatch(f.session, { type: ActionType.SessionIsReadChanged, isRead: true });
	await f.settle();
	const committed: boolean[] = [];
	f.initialHost.onActionCommitted((channel, action) => {
		if (channel === f.session && action.type === ActionType.SessionIsReadChanged) committed.push(action.isRead);
	});
	const rename = t.mock.method(fs, "renameSync", () => {
		throw new Error("unread metadata unavailable");
	});
	try {
		f.initialHost.dispatchServerAction(f.chat, {
			type: ActionType.ChatTurnComplete,
			turnId: "failed-write",
			duration: 1000,
		});
		await f.settle();
	} finally {
		rename.mock.restore();
	}
	assert.deepEqual(committed, []);
	assert.equal(f.metadata.sessions.get(f.id, "read"), true);
	assert.equal(
		(f.initialHost.store.get(f.session) as SessionState).status & SessionStatus.IsRead,
		SessionStatus.IsRead,
	);
	assert.equal((f.initialHost.store.get(f.chat) as ChatState).activeTurn, undefined);
	assert.equal(
		must((await f.client.request("listSessions", { channel: ROOT_CHANNEL })).items[0]).status,
		SessionStatus.Idle | SessionStatus.IsRead,
	);
});
