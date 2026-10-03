/** Loaded-session archive: validation, synchronous persistence, protocol commit and restart recovery. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { existsSync, readFileSync, statSync } from "node:fs";
import { it } from "node:test";
import {
	ActionType,
	type ChatState,
	MessageKind,
	ReconnectResultType,
	type SessionState,
	SessionStatus,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { nextClientId, startHarness } from "./harness.ts";
import { archiveSessionFixture as fixture, nextArchiveEvent as nextEvent } from "./support/archive-session.ts";
import { must } from "./support/assertions.ts";

it("persists ordered archive toggles without disturbing an active chat and restores them after restart", async (t) => {
	const f = await fixture(t);
	const idle = SessionStatus.Idle | SessionStatus.IsRead;
	const archivedStatus = idle | SessionStatus.IsArchived;
	const running = SessionStatus.InProgress | SessionStatus.IsRead;
	// Model already-running work without attaching an agent or writing Pi history.
	f.initialHost.dispatchServerAction(f.chat, {
		type: ActionType.ChatTurnStarted,
		turnId: "archive-active",
		startedAt: f.timestamp.toISOString(),
		message: { text: "Work in progress", origin: { kind: MessageKind.User } },
	});
	f.initialHost.dispatchServerAction(f.chat, { type: ActionType.ChatActivityChanged, activity: "Working" });
	// Drain both transports before attaching readers for the archive actions.
	await Promise.all([f.client.ping(), f.observer.ping()]);
	const chatBefore = structuredClone(must(f.initialHost.store.get(f.chat))) as ChatState;
	assert.equal(chatBefore.activeTurn?.id, "archive-active");
	assert.equal(chatBefore.status, SessionStatus.InProgress);
	const checkpoints: Array<{ phase: string; archived: boolean; status: number }> = [];
	const capture = (phase: string) => {
		checkpoints.push({
			phase,
			archived: f.metadata.sessions.get(f.id, "archive"),
			status: (f.initialHost.store.get(f.session) as SessionState).status,
		});
	};
	f.initialHost.addClientActionEffect((channel, action) => {
		if (channel === f.session && action.type === ActionType.SessionIsArchivedChanged) capture("persisted");
	});
	// Registered after the persistence effect: all validation must still run first.
	f.initialHost.addClientActionValidator((channel, action) => {
		if (channel === f.session && action.type === ActionType.SessionIsArchivedChanged) capture("validated");
		return undefined;
	});
	f.initialHost.onActionCommitted((channel, action) => {
		if (channel === f.session && action.type === ActionType.SessionIsArchivedChanged) capture("committed");
	});
	const actions = [true, false, true].map(
		(isArchived) => ({ type: ActionType.SessionIsArchivedChanged, isArchived }) as const,
	);
	const senderEvents = f.client.attachSubscription(f.session);
	const observerEvents = f.observer.attachSubscription(f.session);
	const rootEvents = f.client.attachSubscription(ROOT_CHANNEL);
	const dispatched = actions.map((action) => f.client.dispatch(f.session, action));
	let lastSeq = 0;
	for (const [index, action] of actions.entries()) {
		const sender = await nextEvent(senderEvents);
		const observer = await nextEvent(observerEvents);
		assert.ok(sender.type === "action");
		assert.ok(observer.type === "action");
		assert.equal(sender.params.channel, f.session);
		assert.deepEqual(sender.params.action, action);
		assert.deepEqual(sender.params.origin, { clientId: f.clientId, clientSeq: must(dispatched[index]).clientSeq });
		assert.equal(sender.params.rejectionReason, undefined);
		assert.ok(sender.params.serverSeq > lastSeq);
		lastSeq = sender.params.serverSeq;
		assert.deepEqual(observer.params, sender.params);
		const update = await nextEvent(rootEvents);
		assert.ok(update.type === "sessionSummaryChanged");
		assert.deepEqual(update.params, {
			channel: ROOT_CHANNEL,
			session: f.session,
			changes: { status: running | (action.isArchived ? SessionStatus.IsArchived : 0) },
		});
	}
	assert.deepEqual(checkpoints, [
		{ phase: "validated", archived: false, status: idle },
		{ phase: "persisted", archived: true, status: idle },
		{ phase: "committed", archived: true, status: archivedStatus },
		{ phase: "validated", archived: true, status: archivedStatus },
		{ phase: "persisted", archived: false, status: archivedStatus },
		{ phase: "committed", archived: false, status: idle },
		{ phase: "validated", archived: false, status: idle },
		{ phase: "persisted", archived: true, status: idle },
		{ phase: "committed", archived: true, status: archivedStatus },
	]);
	assert.deepEqual(f.initialHost.store.get(f.chat), chatBefore);
	const listed = await f.client.request("listSessions", { channel: ROOT_CHANNEL });
	assert.equal(listed.items.length, 1);
	assert.equal(listed.items[0]?.resource, f.session);
	assert.equal(listed.items[0]?.status, running | SessionStatus.IsArchived);
	assert.equal(listed.items[0]?.modifiedAt, f.timestamp.toISOString());

	const fresh = await f.restart();
	const cold = await fresh.request("listSessions", { channel: ROOT_CHANNEL });
	assert.equal(cold.items.length, 1);
	assert.equal(cold.items[0]?.resource, f.session);
	assert.equal(cold.items[0]?.status, idle | SessionStatus.IsArchived);
	const restored = await fresh.subscribe(f.session);
	const sessionSnapshot = must(restored.result.snapshot);
	assert.equal(sessionSnapshot.resource, f.session);
	assert.equal((sessionSnapshot.state as SessionState).status, idle | SessionStatus.IsArchived);
	const chat = await fresh.subscribe(f.chat);
	const chatSnapshot = must(chat.result.snapshot);
	assert.equal(chatSnapshot.resource, f.chat);
	assert.equal((chatSnapshot.state as ChatState).status, idle);
	assert.equal(f.createBackend.mock.callCount(), 0);
	assert.deepEqual(readFileSync(f.file), f.history);
	assert.equal(statSync(f.file).mtime.toISOString(), f.timestamp.toISOString());
});

it("a broken subscriber cannot reject a persisted archive or prevent other subscribers from seeing it", async (t) => {
	const f = await fixture(t);
	const broken = f.initialHost.accept({
		send(message) {
			if ("method" in message && message.method === "action") throw new Error("subscriber send failed");
		},
		close() {},
		onMessage() {},
		onClose() {},
	});
	broken.subscribe(f.session);
	// Connect after the broken transport to prove delivery continues past it.
	const downstream = await f.connect();
	await downstream.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	await downstream.subscribe(f.session);
	const senderEvents = f.client.attachSubscription(f.session);
	const observerEvents = f.observer.attachSubscription(f.session);
	const downstreamEvents = downstream.attachSubscription(f.session);
	const rootEvents = f.client.attachSubscription(ROOT_CHANNEL);
	const previousSeq = f.initialHost.serverSeq;
	const action = { type: ActionType.SessionIsArchivedChanged, isArchived: true } as const;
	const dispatched = f.client.dispatch(f.session, action);
	const sender = await nextEvent(senderEvents);
	const observer = await nextEvent(observerEvents);
	const delivered = await nextEvent(downstreamEvents);
	assert.ok(sender.type === "action");
	assert.ok(observer.type === "action");
	assert.ok(delivered.type === "action");
	assert.deepEqual(sender.params.action, action);
	assert.deepEqual(sender.params.origin, { clientId: f.clientId, clientSeq: dispatched.clientSeq });
	assert.equal(sender.params.rejectionReason, undefined);
	assert.equal(sender.params.serverSeq, previousSeq + 1);
	assert.deepEqual(observer.params, sender.params);
	assert.deepEqual(delivered.params, sender.params);
	const summary = await nextEvent(rootEvents);
	assert.ok(summary.type === "sessionSummaryChanged");
	assert.deepEqual(summary.params, {
		channel: ROOT_CHANNEL,
		session: f.session,
		changes: { status: SessionStatus.Idle | SessionStatus.IsRead | SessionStatus.IsArchived },
	});
	assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
	assert.equal(
		(f.initialHost.store.get(f.session) as SessionState).status & SessionStatus.IsArchived,
		SessionStatus.IsArchived,
	);
});

it("does not persist when a later validator refuses archive", async (t) => {
	const f = await fixture(t);
	const before = structuredClone(f.initialHost.store.get(f.session));
	const writes = t.mock.method(f.metadata.sessions, "set");
	const notify = t.mock.method(f.initialHost, "notify");
	const committed = t.mock.fn();
	const delivered = t.mock.fn();
	f.initialHost.onActionCommitted(committed);
	f.initialHost.onClientAction(delivered);
	f.initialHost.addClientActionValidator((channel, action) =>
		channel === f.session && action.type === ActionType.SessionIsArchivedChanged
			? "later validator refused archive"
			: undefined,
	);
	const events = f.client.attachSubscription(f.session);
	const action = { type: ActionType.SessionIsArchivedChanged, isArchived: true } as const;
	const dispatched = f.client.dispatch(f.session, action);
	const event = await nextEvent(events);
	assert.ok(event.type === "action");
	assert.deepEqual(event.params.action, action);
	assert.deepEqual(event.params.origin, { clientId: f.clientId, clientSeq: dispatched.clientSeq });
	assert.match(event.params.rejectionReason ?? "", /later validator refused archive/u);
	assert.equal(writes.mock.callCount(), 0);
	assert.equal(f.metadata.sessions.get(f.id, "archive"), false);
	assert.deepEqual(f.initialHost.store.get(f.session), before);
	assert.equal(committed.mock.callCount(), 0);
	assert.equal(delivered.mock.callCount(), 0);
	assert.equal(notify.mock.callCount(), 0);
});

it("rejects a failed overwrite without success effects and retains the rejection for replay", async (t) => {
	const f = await fixture(t);
	const events = f.client.attachSubscription(f.session);
	const observerEvents = f.observer.attachSubscription(f.session);
	f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
	const accepted = await nextEvent(events);
	const initialSeen = await nextEvent(observerEvents);
	assert.ok(accepted.type === "action");
	assert.ok(initialSeen.type === "action");
	assert.equal(accepted.params.rejectionReason, undefined);
	assert.deepEqual(initialSeen.params, accepted.params);
	const before = structuredClone(f.initialHost.store.get(f.session));
	const seqBefore = f.initialHost.serverSeq;
	const committed = t.mock.fn();
	const delivered = t.mock.fn();
	f.initialHost.onActionCommitted(committed);
	f.initialHost.onClientAction(delivered);
	const notify = t.mock.method(f.initialHost, "notify");
	const rename = t.mock.method(fs, "renameSync", () => {
		throw Object.assign(new Error("metadata overwrite unavailable"), { code: "EACCES" });
	});
	const dispatched = f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: false });
	const rejected = await nextEvent(events);
	const seen = await nextEvent(observerEvents);
	assert.ok(rejected.type === "action");
	assert.ok(seen.type === "action");
	assert.deepEqual(rejected.params.action, { type: ActionType.SessionIsArchivedChanged, isArchived: false });
	assert.deepEqual(rejected.params.origin, { clientId: f.clientId, clientSeq: dispatched.clientSeq });
	assert.match(rejected.params.rejectionReason ?? "", /metadata overwrite unavailable/u);
	assert.deepEqual(seen.params, rejected.params);
	assert.equal(rename.mock.callCount(), 1);
	assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
	assert.deepEqual(f.initialHost.store.get(f.session), before);
	assert.equal(committed.mock.callCount(), 0);
	assert.equal(delivered.mock.callCount(), 0);
	assert.equal(notify.mock.callCount(), 0);
	rename.mock.restore();
	const replayClient = await f.connect();
	const replay = await replayClient.reconnect({
		clientId: f.clientId,
		lastSeenServerSeq: seqBefore,
		subscriptions: [f.session],
	});
	assert.ok(replay.type === ReconnectResultType.Replay);
	assert.deepEqual(replay.actions, [rejected.params]);
});

it("archives a new live session before Pi has written its JSONL file", async (t) => {
	const harness = await startHarness({ sessions: true });
	t.after(() => harness.dispose());
	const client = await harness.connect();
	const clientId = nextClientId();
	await client.initialize({ clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	const id = randomUUID();
	const session = sessionUri(id);
	await client.request("createSession", { channel: session });
	const file = must(harness.sessions?.get(session)?.sessionManager.getSessionFile());
	assert.equal(existsSync(file), false);
	await client.subscribe(session);
	const events = client.attachSubscription(session);
	const action = { type: ActionType.SessionIsArchivedChanged, isArchived: true } as const;
	const dispatched = client.dispatch(session, action);
	const accepted = await nextEvent(events);
	assert.ok(accepted.type === "action");
	assert.deepEqual(accepted.params.action, action);
	assert.deepEqual(accepted.params.origin, { clientId, clientSeq: dispatched.clientSeq });
	assert.equal(accepted.params.rejectionReason, undefined);
	assert.equal(must(harness.metadata).sessions.get(id, "archive"), true);
	assert.equal(
		(harness.host.store.get(session) as SessionState).status & SessionStatus.IsArchived,
		SessionStatus.IsArchived,
	);
	const listed = await client.request("listSessions", { channel: ROOT_CHANNEL });
	const summary = must(listed.items.find((item) => item.resource === session));
	assert.equal(summary.status & SessionStatus.IsArchived, SessionStatus.IsArchived);
	assert.equal(existsSync(file), false, "archiving must not flush Pi history");
});
