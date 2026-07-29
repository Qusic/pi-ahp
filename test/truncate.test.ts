import { must } from "./harness.ts";
/**
 * Truncating a conversation.
 *
 * The failure this replaces was silent: the reducer dropped turns from the
 * client's view while pi kept the whole history, so every later turn ran on
 * context the user believed was gone — and nothing reported the mismatch.
 *
 * pi's sessions are append-only trees, so truncation is a leaf move rather
 * than a delete: `navigateTree` repoints the leaf and later messages form a new
 * branch, which is exactly what the protocol means.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ActionType, type ChatState, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { chatUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import { CLEAR_ALL_ANCHOR, rebuildHistory } from "../src/pi/history.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { SessionHydrator } from "../src/pi/session-hydrator.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";

/** Two complete turns, so there is something to truncate back to. */
function writeSession(root: string, id: string, cwd: string): void {
	const directory = join(root, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(directory, { recursive: true });
	const at = "2026-01-01T00:00:00.000Z";
	const lines = [JSON.stringify({ type: "session", id, parentId: null, timestamp: at, version: 3, cwd })];
	let parentId: string | null = null;
	const push = (message: Record<string, unknown>): void => {
		const entryId = randomUUID();
		lines.push(JSON.stringify({ type: "message", id: entryId, parentId, timestamp: at, message }));
		parentId = entryId;
	};
	push({ role: "user", content: "first question", timestamp: 0 });
	push({ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 0 });
	push({ role: "user", content: "second question", timestamp: 0 });
	push({ role: "assistant", content: [{ type: "text", text: "second answer" }], timestamp: 0 });
	writeFileSync(join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${lines.join("\n")}\n`);
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
	truncated: string[];
	close(): Promise<void>;
}

async function startFixture(options: { acceptTruncate?: boolean } = {}): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-trunc-"));
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-trunc-cwd-"));
	const sessionId = randomUUID();
	writeSession(root, sessionId, workspace);

	const host = new AhpHost();
	installRootChannel(host, []);
	const catalogue = new PiSessionCatalogue(root);
	host.serve({ catalogue });

	const truncated: string[] = [];
	const backend: PiBackend = {
		subscribe: () => () => {},
		prompt: async () => {},
		steer: async () => {},
		abort: async () => {},
		truncate: async (entryId) => {
			truncated.push(entryId);
			return options.acceptTruncate ?? true;
		},
	};
	const sessions = new SessionRegistry({ host, defaultWorkingDirectory: workspace, createBackend: () => backend });
	host.serve({
		sessions: {
			create: (params) => sessions.create(params as never),
			dispose: (channel) => sessions.dispose(channel),
		},
	});
	host.serve({
		hydrator: new SessionHydrator({
			host,
			catalogue,
			isLive: (uri) => sessions.has(uri),
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
		truncated,
		async close() {
			await client.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true });
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}

async function settle(ms = 150): Promise<void> {
	await new Promise((resolve) => {
		const handle = setTimeout(resolve, ms);
		handle.unref?.();
	});
}

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

		fixture.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: must(turns[0]).id } as never);
		await settle();

		// Both halves have to move: the reducer drops the later turn, and pi is
		// told to branch from the kept one.
		assert.equal((fixture.host.store.get(chat) as ChatState).turns.length, 1);
		assert.equal(fixture.truncated.length, 1);
	});

	it("maps 'clear everything' onto the first entry", async () => {
		const fresh = await startFixture();
		try {
			const chat = chatUri(fresh.sessionId);
			await fresh.client.subscribe(chat);

			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated } as never);
			await settle();

			assert.equal((fresh.host.store.get(chat) as ChatState).turns.length, 0);
			assert.equal(fresh.truncated.length, 1);
		} finally {
			await fresh.close();
		}
	});

	it("refuses a turn it cannot anchor, instead of diverging", async () => {
		const fresh = await startFixture();
		try {
			const chat = chatUri(fresh.sessionId);
			const { result } = await fresh.client.subscribe(chat);
			const before = (must(result.snapshot).state as ChatState).turns.length;
			const subscription = fresh.client.attachSubscription(chat);

			fresh.client.dispatch(chat, { type: ActionType.ChatTruncated, turnId: "no-such-turn" } as never);

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
