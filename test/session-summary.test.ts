/** Wire-level projections, using unmodified AHP reducers to check convergence. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
	type ActionEnvelope,
	ActionType,
	type ChatState,
	type ChatSummary,
	MessageKind,
	ResponsePartKind,
	SessionLifecycle,
	type SessionState,
	SessionStatus,
	type SessionSummaryChangedParams,
	SUPPORTED_PROTOCOL_VERSIONS,
	sessionReducer,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { chatSummaryOf } from "../src/channels/chat.ts";
import { aggregateSessionChats, sessionSummaryOf } from "../src/channels/session.ts";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import type { BackendFactory } from "../src/pi/session-registry.ts";
import { must, nextClientId, startHarness } from "./harness.ts";

const START = "2025-01-01T00:00:00.000Z";
const END = "2025-01-01T00:00:01.000Z";
function summary(resource: string, status = SessionStatus.Idle, modifiedAt = START): ChatSummary {
	return { resource, title: resource, status, modifiedAt };
}
function sessionState(chats: ChatSummary[] = []): SessionState {
	return {
		provider: "pi",
		title: "Session",
		status: SessionStatus.Idle,
		lifecycle: SessionLifecycle.Ready,
		activeClients: [],
		chats,
	};
}

describe("session chat aggregation", () => {
	it("passes through single-chat activity but preserves session-owned and unknown flags", () => {
		const flags = SessionStatus.IsRead | SessionStatus.IsArchived | (1 << 10);
		for (const status of [
			SessionStatus.Idle,
			SessionStatus.InProgress,
			SessionStatus.Error,
			SessionStatus.InputNeeded,
		]) {
			const state = {
				...sessionState([{ ...summary("chat", status), activity: "Working" }]),
				status: SessionStatus.Idle | flags,
			};
			const before = structuredClone(state);
			assert.deepEqual(aggregateSessionChats(state), {
				status: status | flags,
				activity: "Working",
				modifiedAt: START,
			});
			assert.deepEqual(state, before, "projection must not mutate source state");
		}
		const state = sessionState([summary("chat", SessionStatus.Idle | SessionStatus.IsRead)]);
		assert.equal(aggregateSessionChats(state).status, SessionStatus.Idle, "chat flags must not leak into the session");
	});

	it("uses default chat activity but the latest timestamp, comparing instants rather than strings", () => {
		const state = sessionState([
			{ ...summary("default", SessionStatus.Idle), activity: "Default" },
			{ ...summary("recent", SessionStatus.InProgress, "2024-12-31T19:01:00-05:00"), activity: "Recent" },
		]);
		assert.deepEqual(aggregateSessionChats({ ...state, defaultChat: "default" }), {
			status: SessionStatus.Idle,
			activity: "Default",
			modifiedAt: state.chats[1]?.modifiedAt,
		});
		for (const defaultChat of [undefined, "missing"]) {
			assert.deepEqual(aggregateSessionChats({ ...state, ...(defaultChat ? { defaultChat } : {}) }), {
				status: SessionStatus.InProgress,
				activity: "Recent",
				modifiedAt: state.chats[1]?.modifiedAt,
			});
		}
	});

	it("promotes Error and InputNeeded, preferring the most recent blocker of the winning kind", () => {
		const state = {
			...sessionState([summary("default"), { ...summary("error", SessionStatus.Error), activity: "Error" }]),
			defaultChat: "default",
		};
		assert.deepEqual(aggregateSessionChats(state), {
			status: SessionStatus.Error,
			activity: "Error",
			modifiedAt: START,
		});
		state.chats.push(summary("old-input", SessionStatus.InputNeeded), {
			...summary("input", SessionStatus.InputNeeded, END),
			activity: "Approval",
		});
		assert.deepEqual(aggregateSessionChats(state), {
			status: SessionStatus.InputNeeded,
			activity: "Approval",
			modifiedAt: END,
		});
	});

	it("handles an empty catalogue and chooses stable ties and valid timestamps", () => {
		const empty = { ...sessionState(), activity: "Starting" };
		assert.deepEqual(aggregateSessionChats(empty), { status: SessionStatus.Idle, activity: "Starting" });
		assert.equal(sessionSummaryOf("session", START, empty).modifiedAt, START);
		const state = sessionState([
			{ ...summary("invalid", SessionStatus.Idle, "invalid"), activity: "Invalid" },
			{ ...summary("first", SessionStatus.InProgress), activity: "First" },
			{ ...summary("tie", SessionStatus.Idle), activity: "Tie" },
		]);
		assert.deepEqual(aggregateSessionChats(state), {
			status: SessionStatus.InProgress,
			activity: "First",
			modifiedAt: START,
		});
	});
});

async function fixture(t: TestContext, createBackend?: BackendFactory) {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-summary-"));
	const harness = await startHarness({
		sessions: true,
		catalogueRoot: join(root, "sessions"),
		workingDirectory: root,
		createBackend:
			createBackend ??
			(() => ({
				subscribe: () => () => {},
				prompt: async () => {},
				steer: async () => {},
				abort: async () => {},
			})),
	});
	t.after(async () => {
		await harness.dispose();
		rmSync(root, { recursive: true, force: true });
	});
	const transport = await WebSocketTransport.connect(harness.url);
	const notifications: Array<{ method: string; params: unknown }> = [];
	// Record decoded wire frames before the client processes them. A ping reply
	// is then a barrier for negative assertions, without timers or stream races.
	const client = new AhpClient({
		send: (message) => transport.send(typeof message === "string" ? message : JSON.stringify(message)),
		close: () => transport.close(),
		async recv() {
			const frame = await transport.recv();
			if (frame?.kind === "text") {
				const message = JSON.parse(frame.text);
				if (message.method && message.id === undefined) notifications.push(message);
			}
			return frame;
		},
	});
	client.connect();
	t.after(() => client.shutdown());
	const clientId = nextClientId();
	await client.initialize({
		clientId,
		protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
		initialSubscriptions: [ROOT_CHANNEL],
	});
	const id = randomUUID();
	const session = sessionUri(id);
	const alias = `pi:/${id}`;
	const chat = chatUri(id);
	await client.request("createSession", { channel: alias } as never);
	const initial = (await client.subscribe(alias)).result.snapshot;
	await client.subscribe(chat);
	await client.ping();
	notifications.length = 0;
	const envelopes = () => notifications.filter((n) => n.method === "action").map((n) => n.params as ActionEnvelope);
	const changes = () =>
		notifications
			.filter((n) => n.method === "root/sessionSummaryChanged")
			.map((n) => n.params as SessionSummaryChangedParams);
	const start = async () => {
		client.dispatch(chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "turn",
			startedAt: START,
			message: { text: "go", origin: { kind: MessageKind.User } },
		});
		await client.ping();
	};
	const list = async () => {
		const result = await client.request("listSessions", { channel: ROOT_CHANNEL } as never);
		assert.equal(result.items.length, 1);
		return must(result.items[0]);
	};
	return {
		harness,
		client,
		clientId,
		session,
		alias,
		chat,
		initial: must(initial),
		notifications,
		envelopes,
		changes,
		start,
		list,
	};
}

describe("session summary over the wire", () => {
	it("projects an active turn closed by backend startup failure", async (t) => {
		const startup = Promise.withResolvers<PiBackend>();
		const f = await fixture(t, () => startup.promise);
		await f.start();
		f.notifications.length = 0;
		const attaching = must(f.harness.sessions?.get(f.session)?.attaching);
		startup.reject(new Error("backend unavailable"));
		await attaching;
		await f.client.ping();
		assert.deepEqual(f.changes(), [
			{ channel: ROOT_CHANNEL, session: f.alias, changes: { status: SessionStatus.Error } },
		]);
		const state = f.harness.host.store.get(f.session) as SessionState;
		assert.equal(state.lifecycle, SessionLifecycle.Failed);
		assert.equal(state.chats[0]?.status, SessionStatus.Error);
		assert.equal((await f.list()).status, SessionStatus.Error);
	});

	it("publishes exact start deltas and lists an unpersisted session for new clients", async (t) => {
		const f = await fixture(t);
		await f.start();
		assert.deepEqual(f.changes(), [
			{ channel: ROOT_CHANNEL, session: f.alias, changes: { status: SessionStatus.InProgress, modifiedAt: START } },
		]);
		const actions = f.envelopes();
		assert.equal(actions.length, 2);
		assert.equal(actions[0]?.action.type, ActionType.ChatTurnStarted);
		const update = must(actions[1]);
		assert.equal(update.channel, f.alias);
		const { resource: _resource, ...expected } = chatSummaryOf(f.harness.host.store.get(f.chat) as ChatState);
		assert.deepEqual(update.action, { type: ActionType.SessionChatUpdated, chat: f.chat, changes: expected });
		assert.equal(update.rejectionReason, undefined);
		assert.equal(update.origin, undefined);
		assert.equal(update.serverSeq, must(actions[0]).serverSeq + 1);
		assert.equal((f.harness.host.store.get(f.session) as SessionState).status, SessionStatus.Idle);
		assert.equal(existsSync(must(f.harness.sessions?.get(f.session)?.sessionManager.getSessionFile())), false);
		const live = await f.list();
		assert.equal(live.resource, f.alias);
		assert.equal(live.status, SessionStatus.InProgress);
		assert.equal(live.modifiedAt, START);
		assert.equal("activity" in live, false);
		const other = await f.harness.connect();
		await other.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		const result = await other.request("listSessions", { channel: ROOT_CHANNEL } as never);
		assert.deepEqual(result.items, [{ ...live, resource: f.session }]);
	});

	it("clears activity through a full upsert and sends no redundant root updates or delta projections", async (t) => {
		const f = await fixture(t);
		await f.start();
		const startActions = f.envelopes();
		f.notifications.length = 0;
		f.harness.host.dispatchServerAction(f.chat, { type: ActionType.ChatActivityChanged, activity: "Thinking" });
		f.harness.host.dispatchServerAction(f.chat, { type: ActionType.ChatActivityChanged });
		await f.client.ping();
		assert.deepEqual(f.changes(), [], "activity is not published on the root catalogue");
		const actions = f.envelopes();
		assert.deepEqual(
			actions.map((e) => e.action.type),
			[
				ActionType.ChatActivityChanged,
				ActionType.SessionChatUpdated,
				ActionType.SessionActivityChanged,
				ActionType.ChatActivityChanged,
				ActionType.SessionChatAdded,
				ActionType.SessionActivityChanged,
			],
		);
		let mirror = f.initial.state as SessionState;
		for (const envelope of [...startActions, ...actions].filter((e) => e.channel === f.alias))
			mirror = sessionReducer(mirror, envelope.action as never);
		assert.deepEqual(
			JSON.parse(JSON.stringify(mirror)),
			JSON.parse(JSON.stringify(f.harness.host.store.get(f.session))),
		);
		assert.equal(mirror.chats[0]?.activity, undefined);
		assert.equal(mirror.activity, undefined);
		f.harness.host.dispatchServerAction(f.chat, {
			type: ActionType.ChatResponsePart,
			turnId: "turn",
			part: { kind: ResponsePartKind.Markdown, id: "text", content: "a" },
		});
		await f.client.ping();
		f.notifications.length = 0;
		for (let i = 0; i < 20; i++)
			f.harness.host.dispatchServerAction(f.chat, {
				type: ActionType.ChatDelta,
				turnId: "turn",
				partId: "text",
				content: "b",
			});
		await f.client.ping();
		assert.equal(f.envelopes().length, 20);
		assert.ok(f.envelopes().every((e) => e.channel === f.chat && e.action.type === ActionType.ChatDelta));
		assert.deepEqual(f.changes(), []);
	});

	for (const outcome of ["complete", "cancel", "error", "truncate"] as const) {
		it(`projects ${outcome} and ignores rejected/no-op actions`, async (t) => {
			const f = await fixture(t);
			await f.start();
			f.notifications.length = 0;
			const before = structuredClone(f.harness.host.store.get(f.session));
			f.client.dispatch(f.chat, { type: ActionType.ChatTurnCancelled, turnId: "wrong", duration: 1000 });
			await f.client.ping();
			f.harness.host.dispatchServerAction(f.chat, {
				type: ActionType.ChatTurnComplete,
				turnId: "wrong",
				duration: 1000,
			});
			await f.client.ping();
			assert.ok(f.envelopes()[0]?.rejectionReason);
			assert.equal(f.envelopes().length, 2);
			assert.deepEqual(f.changes(), []);
			assert.deepEqual(f.harness.host.store.get(f.session), before);
			f.notifications.length = 0;
			if (outcome === "cancel")
				f.client.dispatch(f.chat, { type: ActionType.ChatTurnCancelled, turnId: "turn", duration: 1000 });
			else
				f.harness.host.dispatchServerAction(
					f.chat,
					outcome === "truncate"
						? { type: ActionType.ChatTruncated }
						: outcome === "error"
							? {
									type: ActionType.ChatError,
									turnId: "turn",
									duration: 1000,
									part: { kind: ResponsePartKind.Error, error: { errorType: "test", message: "failed" } },
								}
							: { type: ActionType.ChatTurnComplete, turnId: "turn", duration: 1000 },
				);
			await f.client.ping();
			const status = outcome === "error" ? SessionStatus.Error : SessionStatus.Idle;
			assert.deepEqual(f.changes(), [
				{
					channel: ROOT_CHANNEL,
					session: f.alias,
					changes: { status, ...(outcome === "truncate" ? {} : { modifiedAt: END }) },
				},
			]);
			const listed = await f.list();
			assert.equal(listed.status, status);
			assert.equal(listed.modifiedAt, outcome === "truncate" ? START : END);
			assert.equal((f.harness.host.store.get(f.session) as SessionState).chats[0]?.status, status);
		});
	}

	for (const running of [true, false]) {
		it(`replays ${running ? "running" : "completed"} session projections to the same state as snapshot fallback`, async (t) => {
			const f = await fixture(t);
			const baseline = f.harness.host.serverSeq;
			await f.client.shutdown();
			const host = f.harness.host;
			host.dispatchServerAction(f.chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "turn",
				startedAt: START,
				message: { text: "offline", origin: { kind: MessageKind.User } },
			});
			host.dispatchServerAction(f.chat, { type: ActionType.ChatActivityChanged, activity: "Working" });
			if (!running) {
				host.dispatchServerAction(f.chat, { type: ActionType.ChatActivityChanged });
				host.dispatchServerAction(f.chat, { type: ActionType.ChatTurnComplete, turnId: "turn", duration: 1000 });
			}
			const resumed = await f.harness.connect();
			const replay = await resumed.reconnect({
				clientId: f.clientId,
				lastSeenServerSeq: baseline,
				subscriptions: [f.alias, f.chat],
			});
			assert.equal(replay.type, "replay");
			if (replay.type !== "replay") assert.fail("expected replay");
			let mirror = f.initial.state as SessionState;
			for (const envelope of replay.actions.filter((e) => e.channel === f.alias))
				mirror = sessionReducer(mirror, envelope.action as never);
			const fresh = await f.harness.connect();
			const fallback = await fresh.reconnect({
				clientId: nextClientId(),
				lastSeenServerSeq: baseline,
				subscriptions: [f.alias],
			});
			assert.equal(fallback.type, "snapshot");
			if (fallback.type !== "snapshot") assert.fail("expected snapshot fallback");
			assert.deepEqual(JSON.parse(JSON.stringify(mirror)), must(fallback.snapshots[0]).state);
			assert.equal(mirror.status, SessionStatus.Idle);
			assert.equal(mirror.chats[0]?.modifiedAt, running ? START : END);
			assert.equal(mirror.chats[0]?.activity, running ? "Working" : undefined);
			// Root notifications are not replayed: a fresh list supplies the final status.
			const result = await fresh.request("listSessions", { channel: ROOT_CHANNEL } as never);
			assert.equal(result.items[0]?.status, running ? SessionStatus.InProgress : SessionStatus.Idle);
		});
	}
});
