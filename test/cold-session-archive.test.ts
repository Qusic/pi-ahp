/** Durable-only archive routing and its shared identity/lifecycle ordering. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { existsSync, readFileSync, statSync } from "node:fs";
import { it } from "node:test";
import {
	ActionType,
	AhpErrorCodes,
	JsonRpcErrorCodes,
	ReconnectResultType,
	type RootState,
	type SessionState,
	SessionStatus,
} from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { archiveSessionFixture, nextArchiveEvent, withArchiveTimeout } from "./support/archive-session.ts";
import { expectRpcError, must } from "./support/assertions.ts";
import { writeSessionFixture } from "./support/session-files.ts";

const IDLE = SessionStatus.Idle | SessionStatus.IsRead;
const ARCHIVED = IDLE | SessionStatus.IsArchived;

it("archives and unarchives cold history without materializing it, and suppresses no-op summary updates", async (t) => {
	const f = await archiveSessionFixture(t, { loaded: false });
	const roots = f.client.attachSubscription(ROOT_CHANNEL);
	const notify = t.mock.method(f.initialHost, "notify");
	const writes = t.mock.method(f.metadata.sessions, "set");
	for (const isArchived of [true, false, true]) {
		if (isArchived) f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived });
		else f.observer.dispatch(`pi:/${f.id}`, { type: ActionType.SessionIsArchivedChanged, isArchived });
		const event = await nextArchiveEvent(roots);
		assert.ok(event.type === "sessionSummaryChanged");
		assert.deepEqual(event.params, {
			channel: ROOT_CHANNEL,
			session: f.session,
			changes: { status: isArchived ? ARCHIVED : IDLE },
		});
		await f.settle();
		assert.equal(f.metadata.sessions.get(f.id, "archive"), isArchived);
		const page = await f.client.request("listSessions", { channel: ROOT_CHANNEL });
		assert.equal(page.items.length, 1);
		assert.equal(page.items[0]?.resource, f.session);
		assert.equal(page.items[0]?.status, isArchived ? ARCHIVED : IDLE);
		assert.equal(page.items[0]?.modifiedAt, f.timestamp.toISOString());
	}
	const seq = f.initialHost.serverSeq;
	const repeated = f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
	await f.settle();
	assert.equal(f.initialHost.serverSeq, seq + 1, "even a repeated value is accepted in server order");
	assert.equal(writes.mock.callCount(), 4);
	assert.equal(
		notify.mock.calls.filter((call) => call.arguments[1] === "root/sessionSummaryChanged").length,
		3,
		"an unchanged value must not publish a redundant summary",
	);
	assert.equal(f.initialHost.store.has(f.session), false);
	assert.equal(f.initialHost.store.has(f.chat), false);
	assert.equal((f.initialHost.store.get(ROOT_CHANNEL) as RootState).activeSessions, 0);
	assert.equal(f.createBackend.mock.callCount(), 0);
	assert.deepEqual(readFileSync(f.file), f.history);
	assert.equal(statSync(f.file).mtime.toISOString(), f.timestamp.toISOString());

	const connection = await f.connect();
	const replay = await connection.reconnect({
		clientId: f.clientId,
		lastSeenServerSeq: seq,
		subscriptions: [f.session],
	});
	assert.ok(replay.type === ReconnectResultType.Replay);
	assert.equal(replay.actions.length, 1);
	const accepted = must(replay.actions[0]);
	assert.equal(accepted.channel, f.session);
	assert.deepEqual(accepted.action, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
	assert.deepEqual(accepted.origin, { clientId: f.clientId, clientSeq: repeated.clientSeq });
	assert.equal(accepted.rejectionReason, undefined);
	assert.equal((f.initialHost.store.get(f.session) as SessionState).status, ARCHIVED);
});

it("does not reject an accepted cold action again when its summary publication fails", async (t) => {
	const f = await archiveSessionFixture(t, { loaded: false });
	t.mock.method(f.initialHost, "notify", () => {
		throw new Error("summary delivery unavailable");
	});
	const seq = f.initialHost.serverSeq;
	f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
	await f.settle();
	assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
	assert.equal(f.initialHost.serverSeq, seq + 1, "publication failure must not append a contradictory rejection");
	assert.equal(f.initialHost.store.has(f.session), false);
	const page = await f.client.request("listSessions", { channel: ROOT_CHANNEL });
	assert.equal(page.items[0]?.status, ARCHIVED);
});

it("does not mistake an orphan sidecar or a URI shape for a real session", async (t) => {
	const f = await archiveSessionFixture(t, { loaded: false });
	const orphan = randomUUID();
	const missing = randomUUID();
	f.metadata.sessions.set(orphan, "archive", true);
	const writes = t.mock.method(f.metadata.sessions, "set");
	const notify = t.mock.method(f.initialHost, "notify");
	const seq = f.initialHost.serverSeq;
	for (const id of [orphan, missing]) {
		f.client.dispatch(sessionUri(id), { type: ActionType.SessionIsArchivedChanged, isArchived: false });
		await f.settle(id);
	}
	f.client.dispatch(`unsupported:/${f.id}`, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
	await f.client.ping();
	assert.equal(f.initialHost.serverSeq, seq, "unknown targets are ignored, not echoed as rejections");
	assert.equal(writes.mock.callCount(), 0);
	assert.equal(notify.mock.callCount(), 0);
	assert.equal(f.metadata.sessions.get(orphan, "archive"), true);
	assert.equal(f.metadata.sessions.get(missing, "archive"), false);
	assert.equal(f.initialHost.store.has(f.session), false);
});

it("rejects malformed cold actions and validator refusals or exceptions before any write", async (t) => {
	const f = await archiveSessionFixture(t, { loaded: false });
	const seq = f.initialHost.serverSeq;
	const writes = t.mock.method(f.metadata.sessions, "set");
	const notify = t.mock.method(f.initialHost, "notify");
	const invalid = { type: ActionType.SessionIsArchivedChanged, isArchived: "yes" } as never;
	const malformed = f.client.dispatch(f.session, invalid);
	await f.settle();
	const removeValidator = f.initialHost.addClientActionValidator((channel, action) =>
		channel === f.session && action.type === ActionType.SessionIsArchivedChanged ? "cold validation veto" : undefined,
	);
	const valid = { type: ActionType.SessionIsArchivedChanged, isArchived: true } as const;
	const refused = f.client.dispatch(f.session, valid);
	await f.settle();
	removeValidator();
	const removeThrowingValidator = f.initialHost.addClientActionValidator((channel, action) => {
		if (channel === f.session && action.type === ActionType.SessionIsArchivedChanged) {
			throw new Error("cold validator unavailable");
		}
		return undefined;
	});
	const threw = f.client.dispatch(f.session, valid);
	await f.settle();
	removeThrowingValidator();
	assert.equal(writes.mock.callCount(), 0);
	assert.equal(notify.mock.callCount(), 0);
	assert.equal(f.initialHost.store.has(f.session), false);
	assert.equal(f.initialHost.store.has(f.chat), false);
	const connection = await f.connect();
	const replay = await connection.reconnect({
		clientId: f.clientId,
		lastSeenServerSeq: seq,
		subscriptions: [f.session],
	});
	assert.ok(replay.type === ReconnectResultType.Replay);
	assert.equal(replay.actions.length, 3);
	const first = must(replay.actions[0]);
	const second = must(replay.actions[1]);
	const third = must(replay.actions[2]);
	assert.deepEqual(first.action, invalid);
	assert.deepEqual(first.origin, { clientId: f.clientId, clientSeq: malformed.clientSeq });
	assert.match(first.rejectionReason ?? "", /archive flag must be a boolean/u);
	assert.deepEqual(second.action, valid);
	assert.deepEqual(second.origin, { clientId: f.clientId, clientSeq: refused.clientSeq });
	assert.match(second.rejectionReason ?? "", /cold validation veto/u);
	assert.deepEqual(third.action, valid);
	assert.deepEqual(third.origin, { clientId: f.clientId, clientSeq: threw.clientSeq });
	assert.match(third.rejectionReason ?? "", /Could not validate .*cold validator unavailable/u);
});

it("orders cold and later-live updates across clients and hydration without blocking another ID", async (t) => {
	const f = await archiveSessionFixture(t, { loaded: false });
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const find = f.catalogue.findSessionFile.bind(f.catalogue);
	let first = true;
	t.mock.method(f.catalogue, "findSessionFile", async (id: string) => {
		if (id === f.id && first) {
			first = false;
			started.resolve();
			await release.promise;
		}
		return find(id);
	});
	const writes = t.mock.method(f.metadata.sessions, "set");
	const notify = t.mock.method(f.initialHost, "notify");
	let hydration: ReturnType<typeof f.observer.subscribe> | undefined;
	try {
		f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
		await withArchiveTimeout(started.promise, "cold lookup to start");
		const other = randomUUID();
		writeSessionFixture(f.sessionRoot, other, f.workspace);
		f.client.dispatch(sessionUri(other), { type: ActionType.SessionIsArchivedChanged, isArchived: true });
		await withArchiveTimeout(f.settle(other), "unrelated session archive");
		assert.equal(f.metadata.sessions.get(other, "archive"), true);
		assert.equal(f.metadata.sessions.get(f.id, "archive"), false);

		f.observer.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: false });
		await f.observer.ping();
		let hydrated = false;
		hydration = f.observer.subscribe(f.session).then((result) => {
			hydrated = true;
			return result;
		});
		await f.observer.ping();
		assert.equal(hydrated, false, "materialization must wait behind the earlier archive");
		f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
		await f.client.ping();
		release.resolve();
		const restored = await withArchiveTimeout(hydration, "queued hydration");
		assert.equal(must(restored.result.snapshot).resource, f.session);
		await withArchiveTimeout(f.settle(), "ordered archive actions");
		assert.deepEqual(
			writes.mock.calls.filter((call) => call.arguments[0] === f.id).map((call) => call.arguments),
			[
				[f.id, "archive", true],
				[f.id, "archive", false],
				[f.id, "archive", true],
			],
		);
		assert.deepEqual(
			notify.mock.calls
				.filter(
					(call) =>
						call.arguments[1] === "root/sessionSummaryChanged" &&
						(call.arguments[2] as { session?: string }).session === f.session,
				)
				.map((call) => call.arguments[2]),
			[
				{ session: f.session, changes: { status: ARCHIVED } },
				{ session: f.session, changes: { status: IDLE } },
				{ session: f.session, changes: { status: ARCHIVED } },
			],
		);
		assert.equal((f.initialHost.store.get(f.session) as SessionState).status, ARCHIVED);
		assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
		assert.equal(f.createBackend.mock.callCount(), 0);
	} finally {
		release.resolve();
		if (hydration)
			await withArchiveTimeout(
				hydration.catch(() => undefined),
				"hydration cleanup",
			);
	}
});

it("fences a pending cold lookup and queued hydration when deletion is requested", async (t) => {
	const f = await archiveSessionFixture(t, { loaded: false });
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const find = f.catalogue.findSessionFile.bind(f.catalogue);
	let first = true;
	t.mock.method(f.catalogue, "findSessionFile", async (id: string) => {
		if (id === f.id && first) {
			first = false;
			started.resolve();
			await release.promise;
		}
		return find(id);
	});
	const writes = t.mock.method(f.metadata.sessions, "set");
	const notify = t.mock.method(f.initialHost, "notify");
	let hydration: ReturnType<typeof f.observer.subscribe> | undefined;
	let deletion: ReturnType<typeof f.client.request<"disposeSession">> | undefined;
	try {
		f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
		await withArchiveTimeout(started.promise, "cold lookup to start");
		hydration = f.observer.subscribe(f.session);
		void hydration.catch(() => undefined);
		await f.observer.ping();
		deletion = f.client.request("disposeSession", { channel: f.session });
		void deletion.catch(() => undefined);
		await f.client.ping();
		assert.equal(f.sessions.isDisposing(f.session), true);
		await expectRpcError(
			withArchiveTimeout(f.client.request("createSession", { channel: f.session }), "create rejection during deletion"),
			AhpErrorCodes.SessionAlreadyExists,
		);
		release.resolve();
		await expectRpcError(withArchiveTimeout(hydration, "queued hydration rejection"), AhpErrorCodes.NotFound);
		await withArchiveTimeout(deletion, "session deletion");
		await withArchiveTimeout(f.settle(), "archive queue after deletion");
		assert.equal(writes.mock.callCount(), 0);
		assert.equal(existsSync(f.file), false);
		assert.equal(f.metadata.sessions.get(f.id, "archive"), false);
		assert.equal(f.initialHost.store.has(f.session), false);
		assert.equal(f.initialHost.store.has(f.chat), false);
		assert.equal(notify.mock.calls.filter((call) => call.arguments[1] === "root/sessionSummaryChanged").length, 0);
		assert.equal(f.createBackend.mock.callCount(), 0);
	} finally {
		release.resolve();
		await withArchiveTimeout(
			Promise.allSettled([hydration, deletion].filter((value) => value !== undefined)),
			"hydration and deletion cleanup",
		);
	}
});

it("finishes Pi deletion despite cleanup failure without blocking ID reuse", async (t) => {
	const f = await archiveSessionFixture(t, { loaded: false });
	f.metadata.sessions.set(f.id, "archive", true);
	t.mock.method(f.metadata.sessions, "deleteId", () => {
		throw Object.assign(new Error("sidecar cleanup unavailable"), { code: "EACCES" });
	});
	await f.client.request("disposeSession", { channel: f.session });
	assert.equal(existsSync(f.file), false);
	assert.equal(f.initialHost.store.has(f.session), false);
	assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
	const lookup = t.mock.method(f.catalogue, "findSessionFile");
	await f.client.request("createSession", { channel: f.session });
	assert.equal(lookup.mock.callCount(), 0, "creating a new session must not scan the whole corpus for sidecar cleanup");
	assert.equal((f.initialHost.store.get(f.session) as SessionState).status & SessionStatus.IsArchived, 0);
	assert.equal(f.metadata.sessions.get(f.id, "archive"), true, "stale low-value metadata may remain until replaced");
});

it("cleans a loaded session's sidecar after successful disposal and gives its reused ID a fresh state", async (t) => {
	const f = await archiveSessionFixture(t);
	const control = randomUUID();
	f.metadata.sessions.set(control, "archive", true);
	const events = f.client.attachSubscription(f.session);
	f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
	const accepted = await nextArchiveEvent(events);
	assert.ok(accepted.type === "action");
	assert.equal(accepted.params.rejectionReason, undefined);
	assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
	await f.client.request("disposeSession", { channel: f.session });
	assert.equal(existsSync(f.file), false);
	assert.equal(f.metadata.sessions.get(f.id, "archive"), false);
	assert.equal(f.metadata.sessions.get(control, "archive"), true);
	assert.equal(f.initialHost.store.has(f.session), false);
	assert.equal(f.initialHost.store.has(f.chat), false);
	assert.equal(f.createBackend.mock.callCount(), 0);
	await f.client.request("createSession", { channel: f.session });
	assert.equal(f.metadata.sessions.get(f.id, "archive"), false);
	assert.equal((f.initialHost.store.get(f.session) as SessionState).status & SessionStatus.IsArchived, 0);
	assert.equal(f.metadata.sessions.get(control, "archive"), true);
});

it("preserves archive when Pi deletion fails and lets subsequent updates proceed", async (t) => {
	const f = await archiveSessionFixture(t, {
		loaded: false,
		deleteFile: () => ({ ok: false, error: "Pi removal unavailable" }),
	});
	f.metadata.sessions.set(f.id, "archive", true);
	const cleanup = t.mock.method(f.metadata.sessions, "deleteId");
	const error = await expectRpcError(
		f.client.request("disposeSession", { channel: f.session }),
		JsonRpcErrorCodes.InternalError,
	);
	assert.match(error.message, /Pi removal unavailable/u);
	assert.equal(cleanup.mock.callCount(), 0);
	assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
	assert.deepEqual(readFileSync(f.file), f.history);
	assert.equal(f.sessions.isDisposing(f.session), false);
	const roots = f.client.attachSubscription(ROOT_CHANNEL);
	f.client.dispatch(f.session, { type: ActionType.SessionIsArchivedChanged, isArchived: false });
	const update = await nextArchiveEvent(roots);
	assert.ok(update.type === "sessionSummaryChanged");
	assert.deepEqual(update.params, { channel: ROOT_CHANNEL, session: f.session, changes: { status: IDLE } });
	await f.settle();
	assert.equal(f.metadata.sessions.get(f.id, "archive"), false);
});

it("rejects cold write failure without materialization and replays the rejection on later subscription", async (t) => {
	const f = await archiveSessionFixture(t, { loaded: false });
	f.metadata.sessions.set(f.id, "archive", true);
	const seq = f.initialHost.serverSeq;
	const notify = t.mock.method(f.initialHost, "notify");
	const rename = t.mock.method(fs, "renameSync", () => {
		throw new Error("cold overwrite unavailable");
	});
	const action = { type: ActionType.SessionIsArchivedChanged, isArchived: false } as const;
	const dispatched = f.client.dispatch(f.session, action);
	await f.settle();
	assert.equal(f.initialHost.store.has(f.session), false);
	assert.equal(f.initialHost.store.has(f.chat), false);
	assert.equal(f.metadata.sessions.get(f.id, "archive"), true);
	assert.equal(f.initialHost.serverSeq, seq + 1);
	assert.equal(notify.mock.callCount(), 0);
	rename.mock.restore();
	const connection = await f.connect();
	const replay = await connection.reconnect({
		clientId: f.clientId,
		lastSeenServerSeq: seq,
		subscriptions: [f.session],
	});
	assert.ok(replay.type === ReconnectResultType.Replay);
	assert.equal(replay.actions.length, 1);
	const rejected = must(replay.actions[0]);
	assert.equal(rejected.channel, f.session);
	assert.deepEqual(rejected.action, action);
	assert.deepEqual(rejected.origin, { clientId: f.clientId, clientSeq: dispatched.clientSeq });
	assert.match(rejected.rejectionReason ?? "", /cold overwrite unavailable/u);
	assert.equal((f.initialHost.store.get(f.session) as SessionState).status, ARCHIVED);
	assert.equal(f.createBackend.mock.callCount(), 0);
});
