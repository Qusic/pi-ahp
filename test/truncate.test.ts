/**
 * Truncating a conversation must move both the protocol view and pi's session
 * leaf. Sessions are append-only trees, so later messages form a new branch
 * instead of deleting the abandoned entries.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	MessageKind,
	SUPPORTED_PROTOCOL_VERSIONS,
	type Turn,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import { CLEAR_ALL_ANCHOR, rebuildHistory } from "../src/pi/history.ts";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";
import { MetadataStore } from "../src/pi/metadata-store.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { SessionHydrator } from "../src/pi/session-hydrator.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { must } from "./support/assertions.ts";
import { fixtureSessionDirectory } from "./support/session-files.ts";
import { persistentSessionManagerFactory } from "./support/session-storage.ts";

/** Complete turns on one Pi branch, with stable entry ids for paging tests. */
function writeSession(root: string, id: string, cwd: string, turnCount = 2, lastUserOnly = false): string[] {
	const directory = fixtureSessionDirectory(root, cwd);
	const at = "2026-01-01T00:00:00.000Z";
	const lines = [JSON.stringify({ type: "session", id, parentId: null, timestamp: at, version: 3, cwd })];
	let parentId: string | null = null;
	const push = (message: Record<string, unknown>): string => {
		const entryId = randomUUID();
		lines.push(JSON.stringify({ type: "message", id: entryId, parentId, timestamp: at, message }));
		parentId = entryId;
		return entryId;
	};
	const userIds: string[] = [];
	for (let index = 0; index < turnCount; index += 1) {
		const label = index === 0 ? "first" : index === 1 ? "second" : String(index + 1);
		userIds.push(push({ role: "user", content: `${label} question`, timestamp: 0 }));
		if (!lastUserOnly || index < turnCount - 1) {
			push({ role: "assistant", content: [{ type: "text", text: `${label} answer` }], timestamp: 0 });
		}
	}
	writeFileSync(join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${lines.join("\n")}\n`);
	return userIds;
}

describe("truncation anchors", () => {
	it("anchors a turn on its last entry, not its first", () => {
		// `navigateTree` is inclusive for a non-user entry and exclusive for a
		// user one, so pointing at the turn's *last* entry is what expresses
		// "keep turns up to and including this one".
		const at = "2026-01-01T00:00:00.000Z";
		const entry = (id: string, role: string, text: string) =>
			({
				type: "message",
				id,
				parentId: null,
				timestamp: at,
				message: { role, content: text },
			}) as unknown as SessionEntry;
		const { turns, anchors } = rebuildHistory(
			[
				entry("u1", "user", "q1"),
				entry("a1", "assistant", "a1"),
				entry("u2", "user", "q2"),
				entry("a2", "assistant", "a2"),
			],
			{ turnIdPrefix: "s" },
		);

		assert.equal(turns.length, 2);
		assert.equal(anchors.get(must(turns[0]).id), "a1");
		assert.equal(anchors.get(must(turns[1]).id), "a2");
	});

	it("anchors 'clear everything' on the first user entry", () => {
		// Navigating to a user entry lands the leaf on its parent — and the
		// first one's parent is null, which is how pi expresses an empty branch.
		const at = "2026-01-01T00:00:00.000Z";
		const { anchors } = rebuildHistory(
			[
				{ type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: "q" } },
				{ type: "message", id: "a1", parentId: "u1", timestamp: at, message: { role: "assistant", content: "a" } },
			] as unknown as SessionEntry[],
			{ turnIdPrefix: "s" },
		);

		assert.equal(anchors.get(CLEAR_ALL_ANCHOR), "u1");
	});
});

interface Fixture {
	host: AhpHost;
	client: AhpClient;
	server: RunningServer;
	sessionId: string;
	userIds: string[];
	readonly sessionManager: SessionManager;
	truncated: string[];
	truncateStarted: Promise<void>;
	readonly backendCreations: number;
	close(): Promise<void>;
}

async function startFixture(
	options: {
		acceptTruncate?: boolean;
		truncateError?: Error;
		gate?: Promise<void>;
		turnCount?: number;
		lastUserOnly?: boolean;
	} = {},
): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-trunc-"));
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-trunc-cwd-"));
	const sessionId = randomUUID();
	const userIds = writeSession(root, sessionId, workspace, options.turnCount, options.lastUserOnly);

	const host = new AhpHost();
	installRootChannel(host, []);
	const metadata = new MetadataStore(join(root, "ahp"));
	const catalogue = new PiSessionCatalogue(root, metadata);
	host.serve({ catalogue });

	const truncated: string[] = [];
	const truncateStarted = Promise.withResolvers<void>();
	let backendCreations = 0;
	const sessions = new SessionRegistry({
		host,
		metadata,
		defaultWorkingDirectory: workspace,
		createBackend: (session): PiBackend => {
			backendCreations += 1;
			return {
				subscribe: () => () => {},
				prompt: async () => {},
				steer: async () => {},
				abort: async () => {},
				truncate: async (entryId) => {
					truncated.push(entryId);
					truncateStarted.resolve();
					await options.gate;
					if (options.truncateError) throw options.truncateError;
					if (options.acceptTruncate === false) return false;
					const manager = session.sessionManager;
					const target = manager.getEntry(entryId);
					if (!target) throw new Error(`Missing entry ${entryId}`);
					const leaf = target.type === "message" && target.message.role === "user" ? target.parentId : entryId;
					// Mirror Pi's no-op when the target is already its current leaf.
					if (entryId !== manager.getLeafId()) {
						if (leaf === null) manager.resetLeaf();
						else manager.branch(leaf);
					}
					return manager.getLeafId() === leaf;
				},
			};
		},
		createSessionManager: persistentSessionManagerFactory(root),
	});
	host.serve({
		sessions: {
			create: (params) => sessions.create(params),
			dispose: (channel) => sessions.dispose(channel),
		},
	});
	host.serve({
		hydrator: new SessionHydrator({
			host,
			catalogue,
			metadata,
			operations: sessions.operations,
			isLive: (uri) => sessions.has(uri),
			isDisposing: (uri) => sessions.isDisposing(uri),
			adopt: (session) => void sessions.adopt(session),
		}),
	});

	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	await client.initialize({ clientId: "trunc-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

	return {
		host,
		client,
		server,
		sessionId,
		userIds,
		get sessionManager() {
			return must(sessions.get(sessionUri(sessionId))).sessionManager;
		},
		truncated,
		truncateStarted: truncateStarted.promise,
		get backendCreations() {
			return backendCreations;
		},
		async close() {
			await client.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true });
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}

describe("in-process pi navigation", () => {
	it("does not report success when pi no-ops on a user leaf", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-ahp-trunc-agent-"));
		const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-trunc-sdk-cwd-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		let backend: InProcessPiBackend | undefined;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const manager = SessionManager.inMemory(workspace);
			backend = await InProcessPiBackend.create({ cwd: workspace, sessionManager: manager });
			const user = manager.appendMessage({ role: "user", content: "pending", timestamp: 0 });
			assert.equal(manager.getLeafId(), user);
			assert.equal(await backend.truncate(user), false);
			assert.equal(manager.getLeafId(), user);

			const reply = manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "answered" }],
				stopReason: "stop",
				timestamp: 0,
			} as never);
			manager.appendMessage({ role: "user", content: "next", timestamp: 0 });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "later" }],
				stopReason: "stop",
				timestamp: 0,
			} as never);
			assert.equal(await backend.truncate(reply), true);
			assert.equal(manager.getLeafId(), reply);
		} finally {
			try {
				backend?.dispose();
			} finally {
				if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previous;
				rmSync(agentDir, { recursive: true, force: true });
				rmSync(workspace, { recursive: true, force: true });
			}
		}
	});
});

describe("chat/truncated", () => {
	let fixture: Fixture;

	before(async () => {
		fixture = await startFixture();
	});

	after(async () => {
		await fixture.close();
	});

	it("moves pi's leaf to the named turn, not just the client's view", async () => {
		const chat = chatUri(fixture.sessionId);
		const { result } = await fixture.client.subscribe(chat);
		const turns = (must(result.snapshot).state as ChatState).turns;
		assert.equal(turns.length, 2);

		const subscription = fixture.client.attachSubscription(chat);
		fixture.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: must(turns[0]).id });
		const echo = must((await subscription.next()).value);
		assert.equal(echo.type, "action");
		assert.equal(echo.params.action.type, ActionType.ChatTruncated);
		assert.equal(echo.params.rejectionReason, undefined);

		// Both halves have to move: the reducer drops the later turn, and pi is
		// told to branch from the kept one.
		assert.equal((fixture.host.store.get(chat) as ChatState).turns.length, 1);
		assert.equal(fixture.truncated.length, 1);
		assert.equal(fixture.sessionManager.getLeafId(), fixture.truncated[0]);
	});

	it("reuses one attached backend for successive truncations", async () => {
		const fresh = await startFixture();
		try {
			const chat = chatUri(fresh.sessionId);
			const { result } = await fresh.client.subscribe(chat);
			const first = must((must(result.snapshot).state as ChatState).turns[0]);
			const subscription = fresh.client.attachSubscription(chat);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: first.id });
			const kept = must((await subscription.next()).value);
			assert.equal(kept.type, "action");
			assert.equal(kept.params.rejectionReason, undefined);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated });
			const cleared = must((await subscription.next()).value);
			assert.equal(cleared.type, "action");
			assert.equal(cleared.params.rejectionReason, undefined);
			assert.equal(fresh.backendCreations, 1);
			assert.equal(fresh.sessionManager.getLeafId(), null);
			assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, 0);
		} finally {
			await fresh.close();
		}
	});

	it("maps 'clear everything' onto the first entry", async () => {
		const fresh = await startFixture();
		try {
			const chat = chatUri(fresh.sessionId);
			await fresh.client.subscribe(chat);

			const subscription = fresh.client.attachSubscription(chat);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated });
			const echo = must((await subscription.next()).value);
			assert.equal(echo.type, "action");
			assert.equal(echo.params.action.type, ActionType.ChatTruncated);
			assert.equal(echo.params.rejectionReason, undefined);

			assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, 0);
			assert.equal(fresh.truncated.length, 1);
			assert.equal(fresh.sessionManager.getLeafId(), null);
		} finally {
			await fresh.close();
		}
	});

	it("refuses clear-all when pi's user-only leaf would make navigation a no-op", async () => {
		const fresh = await startFixture({ turnCount: 1, lastUserOnly: true });
		try {
			const chat = chatUri(fresh.sessionId);
			await fresh.client.subscribe(chat);
			const leaf = fresh.sessionManager.getLeafId();
			const subscription = fresh.client.attachSubscription(chat);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated });

			const { value } = await subscription.next();
			assert.equal(value?.type, "action");
			assert.match(value.params.rejectionReason ?? "", /refused truncation/i);
			assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, 1);
			assert.equal(fresh.sessionManager.getLeafId(), leaf);
		} finally {
			await fresh.close();
		}
	});

	it("rejects a backend veto or failure before reducing the client action", async () => {
		for (const options of [{ acceptTruncate: false }, { truncateError: new Error("extension veto") }]) {
			const fresh = await startFixture(options);
			try {
				const chat = chatUri(fresh.sessionId);
				const { result } = await fresh.client.subscribe(chat);
				const initial = must(result.snapshot).state as ChatState;
				const leaf = fresh.sessionManager.getLeafId();
				const subscription = fresh.client.attachSubscription(chat);
				fresh.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: must(initial.turns[0]).id });
				fresh.client.dispatch(chat, {
					type: ActionType.ChatDraftChanged,
					draft: { text: "still here", origin: { kind: MessageKind.User } },
				});

				const { value } = await subscription.next();
				assert.equal(value?.type, "action");
				assert.match(value.params.rejectionReason ?? "", /refused truncation/i);
				const next = must((await subscription.next()).value);
				assert.equal(next.type, "action");
				assert.equal(next.params.action.type, ActionType.ChatDraftChanged);
				assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, 2);
				assert.equal((fresh.host.store.get(chat) as ChatState).draft?.text, "still here");
				assert.equal(fresh.sessionManager.getLeafId(), leaf);
				assert.equal(fresh.truncated.length, 1);
			} finally {
				await fresh.close();
			}
		}
	});

	it("runs synchronous effects before navigating pi", async () => {
		const fresh = await startFixture();
		const chat = chatUri(fresh.sessionId);
		const removeEffect = fresh.host.addClientActionEffect((channel, action) => {
			if (channel === chat && action.type === ActionType.ChatTruncated) throw new Error("effect denied");
			return undefined;
		});
		try {
			const { result } = await fresh.client.subscribe(chat);
			const first = must((must(result.snapshot).state as ChatState).turns[0]);
			const leaf = fresh.sessionManager.getLeafId();
			const subscription = fresh.client.attachSubscription(chat);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: first.id });

			const { value } = await subscription.next();
			assert.equal(value?.type, "action");
			assert.match(value.params.rejectionReason ?? "", /effect denied/);
			assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, 2);
			assert.equal(fresh.sessionManager.getLeafId(), leaf);
			assert.equal(fresh.backendCreations, 0);
			assert.deepEqual(fresh.truncated, []);
		} finally {
			removeEffect();
			await fresh.close();
		}
	});

	it("orders later client actions behind an unresolved navigation", async () => {
		const gate = Promise.withResolvers<void>();
		const fresh = await startFixture({ gate: gate.promise });
		try {
			const chat = chatUri(fresh.sessionId);
			const { result } = await fresh.client.subscribe(chat);
			const first = must((must(result.snapshot).state as ChatState).turns[0]);
			const subscription = fresh.client.attachSubscription(chat);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: first.id });
			await fresh.truncateStarted;
			fresh.client.dispatch(chat, {
				type: ActionType.ChatDraftChanged,
				draft: { text: "later draft", origin: { kind: MessageKind.User } },
			});
			await fresh.client.ping();
			assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, 2);
			assert.equal((fresh.host.store.get(chat) as ChatState).draft, undefined);

			gate.resolve();
			const firstEcho = must((await subscription.next()).value);
			const secondEcho = must((await subscription.next()).value);
			assert.equal(firstEcho.type, "action");
			assert.equal(secondEcho.type, "action");
			assert.equal(firstEcho.params.action.type, ActionType.ChatTruncated);
			assert.equal(secondEcho.params.action.type, ActionType.ChatDraftChanged);
			assert.ok(secondEcho.params.serverSeq > firstEcho.params.serverSeq);
			assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, 1);
			assert.equal((fresh.host.store.get(chat) as ChatState).draft?.text, "later draft");
		} finally {
			gate.resolve();
			await fresh.close();
		}
	});

	it("loads bounded pages before truncating to an older turn", async () => {
		const fresh = await startFixture({ turnCount: 45 });
		try {
			const chat = chatUri(fresh.sessionId);
			const { result } = await fresh.client.subscribe(chat);
			const initial = must(result.snapshot).state as ChatState;
			assert.equal(initial.turns.length, 20);
			assert.ok(initial.turnsNextCursor);
			const target = `${fresh.sessionId}-${must(fresh.userIds[0])}`;
			const subscription = fresh.client.attachSubscription(chat);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: target });

			const firstPage = must((await subscription.next()).value);
			const secondPage = must((await subscription.next()).value);
			const committed = must((await subscription.next()).value);
			for (const [page, start, end] of [
				[firstPage, 5, 25],
				[secondPage, 0, 5],
			] as const) {
				assert.equal(page.type, "action");
				if (page.params.action.type !== ActionType.ChatTurnsLoaded) throw new Error("expected history page");
				assert.deepEqual(
					page.params.action.turns.map((turn: Turn) => turn.id),
					fresh.userIds.slice(start, end).map((id) => `${fresh.sessionId}-${id}`),
				);
			}
			assert.equal(committed.type, "action");
			assert.equal(committed.params.action.type, ActionType.ChatTruncated);
			assert.equal(committed.params.rejectionReason, undefined);
			assert.deepEqual(
				(fresh.host.store.get(chat) as ChatState).turns.map((turn) => turn.id),
				[target],
			);
			assert.equal(fresh.sessionManager.getBranch().length, 2);
		} finally {
			await fresh.close();
		}
	});

	it("refuses truncation while a turn is active", async () => {
		const fresh = await startFixture();
		try {
			const chat = chatUri(fresh.sessionId);
			await fresh.client.subscribe(chat);
			fresh.host.dispatchServerAction(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "ongoing",
				startedAt: new Date().toISOString(),
				message: { text: "working", origin: { kind: MessageKind.User } },
			});
			const subscription = fresh.client.attachSubscription(chat);
			const started = must((await subscription.next()).value);
			assert.equal(started.type, "action");
			assert.equal(started.params.action.type, ActionType.ChatTurnStarted);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated });

			const { value } = await subscription.next();
			assert.equal(value?.type, "action");
			assert.match(value.params.rejectionReason ?? "", /turn is active/);
			assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, 2);
			assert.equal((fresh.host.store.get(chat) as ChatState).activeTurn?.id, "ongoing");
			assert.deepEqual(fresh.truncated, []);
		} finally {
			await fresh.close();
		}
	});

	it("rejects a stale turn id after truncating to an earlier turn", async () => {
		const fresh = await startFixture();
		try {
			const chat = chatUri(fresh.sessionId);
			const { result } = await fresh.client.subscribe(chat);
			const turns = (must(result.snapshot).state as ChatState).turns;
			const subscription = fresh.client.attachSubscription(chat);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: must(turns[0]).id });
			const accepted = must((await subscription.next()).value);
			assert.equal(accepted.type, "action");
			assert.equal(accepted.params.rejectionReason, undefined);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: must(turns[1]).id });
			const rejected = must((await subscription.next()).value);
			assert.equal(rejected.type, "action");
			assert.match(rejected.params.rejectionReason ?? "", /Cannot truncate/);
			assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, 1);
			assert.equal(fresh.truncated.length, 1);
		} finally {
			await fresh.close();
		}
	});

	it("refuses empty and unknown turn IDs without navigating pi", async () => {
		const fresh = await startFixture();
		try {
			const chat = chatUri(fresh.sessionId);
			const { result } = await fresh.client.subscribe(chat);
			const before = (must(result.snapshot).state as ChatState).turns.length;
			const subscription = fresh.client.attachSubscription(chat);

			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: "" });
			const empty = must((await subscription.next()).value);
			assert.equal(empty.type, "action");
			assert.match(empty.params.rejectionReason ?? "", /non-empty/);
			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: "no-such-turn" });

			// Refused before the reducer runs: accepting would truncate the
			// client's view while pi kept everything.
			const { value } = await subscription.next();
			assert.equal(value?.type, "action");
			assert.match(value.params.rejectionReason ?? "", /Cannot truncate/);
			assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, before);
			assert.deepEqual(fresh.truncated, []);
		} finally {
			await fresh.close();
		}
	});
});
