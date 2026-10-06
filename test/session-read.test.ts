/** Manual session read state across live/cold catalogue paths and restarts. */

import assert from "node:assert/strict";
import fs, { readFileSync, statSync } from "node:fs";
import { it } from "node:test";
import {
	ActionType,
	type ChatState,
	ReconnectResultType,
	type SessionState,
	SessionStatus,
} from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL } from "../src/core/channels.ts";
import { archiveSessionFixture as fixture, nextArchiveEvent as nextEvent } from "./support/archive-session.ts";
import { must } from "./support/assertions.ts";

it("persists manual read toggles on a live session without changing archive or the chat", async (t) => {
	const f = await fixture(t);
	const roots = f.client.attachSubscription(ROOT_CHANNEL);
	f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
	const archived = await nextEvent(roots);
	assert.ok(archived.type === "sessionSummaryChanged");
	assert.deepEqual(archived.params.changes, { status: SessionStatus.Idle | SessionStatus.IsArchived });
	const sessionEvents = f.client.attachSubscription(f.session);
	const chatBefore = structuredClone(must(f.initialHost.store.get(f.chat))) as ChatState;

	for (const read of [true, false, true]) {
		const action = { type: ActionType.SessionIsReadChanged, isRead: read } as const;
		const sent = f.client.dispatch(f.session, action);
		const echo = await nextEvent(sessionEvents);
		assert.ok(echo.type === "action");
		assert.deepEqual(echo.params.action, action);
		assert.deepEqual(echo.params.origin, { clientId: f.clientId, clientSeq: sent.clientSeq });
		assert.equal(echo.params.rejectionReason, undefined);
		const update = await nextEvent(roots);
		assert.ok(update.type === "sessionSummaryChanged");
		assert.deepEqual(update.params, {
			channel: ROOT_CHANNEL,
			session: f.session,
			changes: { status: SessionStatus.Idle | SessionStatus.IsArchived | (read ? SessionStatus.IsRead : 0) },
		});
		assert.equal(f.metadata.sessions.get(f.id, "read"), read);
		assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
	}
	assert.deepEqual(f.initialHost.store.get(f.chat), chatBefore);
	const fresh = await f.restart();
	const page = await fresh.request("listSessions", { channel: ROOT_CHANNEL });
	assert.equal(must(page.items[0]).status, SessionStatus.Idle | SessionStatus.IsRead | SessionStatus.IsArchived);
	const snapshot = must((await fresh.subscribe(f.session)).result.snapshot).state as SessionState;
	assert.equal(snapshot.status, SessionStatus.Idle | SessionStatus.IsRead | SessionStatus.IsArchived);
	assert.equal(f.createBackend.mock.callCount(), 0);
	assert.deepEqual(readFileSync(f.file), f.history);
	assert.equal(statSync(f.file).mtime.toISOString(), f.timestamp.toISOString());
});

it("toggles a cold session without hydration and preserves both flags across actions", async (t) => {
	const f = await fixture(t, { loaded: false });
	const roots = f.client.attachSubscription(ROOT_CHANNEL);
	for (const [action, status] of [
		[{ type: ActionType.SessionIsReadChanged, isRead: true }, SessionStatus.Idle | SessionStatus.IsRead],
		[
			{ type: ActionType.SessionIsArchivedChanged, isArchived: true },
			SessionStatus.Idle | SessionStatus.IsRead | SessionStatus.IsArchived,
		],
		[{ type: ActionType.SessionIsReadChanged, isRead: false }, SessionStatus.Idle | SessionStatus.IsArchived],
	] as const) {
		f.client.dispatch(f.session, action);
		const update = await nextEvent(roots);
		assert.ok(update.type === "sessionSummaryChanged");
		assert.deepEqual(update.params, { channel: ROOT_CHANNEL, session: f.session, changes: { status } });
		await f.settle();
		assert.equal(must((await f.client.request("listSessions", { channel: ROOT_CHANNEL })).items[0]).status, status);
		assert.equal(f.initialHost.store.has(f.session), false);
		assert.equal(f.initialHost.store.has(f.chat), false);
	}
	assert.equal(f.metadata.sessions.get(f.id, "read"), false);
	assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
	const fresh = await f.restart();
	assert.equal(
		must((await fresh.request("listSessions", { channel: ROOT_CHANNEL })).items[0]).status,
		SessionStatus.Idle | SessionStatus.IsArchived,
	);
	assert.equal(
		(must((await fresh.subscribe(f.session)).result.snapshot).state as SessionState).status,
		SessionStatus.Idle | SessionStatus.IsArchived,
	);
	assert.equal(f.createBackend.mock.callCount(), 0);
	assert.deepEqual(readFileSync(f.file), f.history);
	assert.equal(statSync(f.file).mtime.toISOString(), f.timestamp.toISOString());
});

it("rejects a cold read write failure before accepting or announcing it", async (t) => {
	const f = await fixture(t, { loaded: false });
	const seq = f.initialHost.serverSeq;
	const notify = t.mock.method(f.initialHost, "notify");
	const rename = t.mock.method(fs, "renameSync", () => {
		throw new Error("read metadata unavailable");
	});
	const action = { type: ActionType.SessionIsReadChanged, isRead: true } as const;
	const sent = f.client.dispatch(f.session, action);
	await f.settle();
	assert.equal(f.metadata.sessions.get(f.id, "read"), false);
	assert.equal(f.initialHost.store.has(f.session), false);
	assert.equal(notify.mock.callCount(), 0);
	rename.mock.restore();
	const other = await f.connect();
	const replay = await other.reconnect({
		clientId: f.clientId,
		lastSeenServerSeq: seq,
		subscriptions: [f.session],
	});
	assert.ok(replay.type === ReconnectResultType.Replay);
	assert.equal(replay.actions.length, 1);
	const rejected = must(replay.actions[0]);
	assert.deepEqual(rejected.action, action);
	assert.deepEqual(rejected.origin, { clientId: f.clientId, clientSeq: sent.clientSeq });
	assert.match(rejected.rejectionReason ?? "", /read metadata unavailable/u);
	assert.equal((f.initialHost.store.get(f.session) as SessionState).status, SessionStatus.Idle);
});
