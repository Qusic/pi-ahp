import { must } from "./harness.ts";
/**
 * Paging older turns into a chat.
 *
 * A hydrated chat shows the window pi itself renders — back to the most recent
 * compaction. Everything before that is on disk but was unreachable, so a long,
 * repeatedly-compacted session looked like it only ever had its last few
 * exchanges.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type ChatState, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { chatUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { SessionHydrator } from "../src/pi/session-hydrator.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { checkSchema } from "./support/schema.ts";

/**
 * Writes a session with `before` exchanges, then a compaction, then `after`.
 *
 * The compaction is what makes the earlier turns invisible to the default
 * window, which is exactly the case paging exists for.
 */
function writeCompactedSession(root: string, id: string, cwd: string, before: number, after: number): void {
	const directory = join(root, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(directory, { recursive: true });
	const at = "2026-01-01T00:00:00.000Z";
	const lines = [JSON.stringify({ type: "session", id, parentId: null, timestamp: at, version: 3, cwd })];
	let parentId: string | null = null;
	const push = (entry: Record<string, unknown>): string => {
		const entryId = randomUUID();
		lines.push(JSON.stringify({ ...entry, id: entryId, parentId, timestamp: at }));
		parentId = entryId;
		return entryId;
	};
	const exchange = (n: number): string => {
		const userId = push({ type: "message", message: { role: "user", content: `question ${n}`, timestamp: 0 } });
		push({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }], timestamp: 0 },
		});
		return userId;
	};

	for (let i = 0; i < before; i++) {
		exchange(i);
	}
	// The compaction keeps nothing before itself: `firstKeptEntryId` points at
	// the entry that follows it, so the window starts here.
	push({ type: "compaction", summary: "earlier work", firstKeptEntryId: "none", tokensBefore: 1000 });
	for (let i = 0; i < after; i++) {
		exchange(before + i);
	}
	writeFileSync(join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${lines.join("\n")}\n`);
}

interface Fixture {
	host: AhpHost;
	client: AhpClient;
	server: RunningServer;
	sessionId: string;
	close(): Promise<void>;
}

async function startFixture(before: number, after: number): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-paging-"));
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-paging-cwd-"));
	const sessionId = randomUUID();
	writeCompactedSession(root, sessionId, workspace, before, after);

	const host = new AhpHost();
	installRootChannel(host, []);
	const catalogue = new PiSessionCatalogue(root);
	host.serve({ catalogue });
	const sessions = new SessionRegistry({ host, defaultWorkingDirectory: workspace });
	host.serve({
		hydrator: new SessionHydrator({
			host,
			catalogue,
			isLive: (uri) => sessions.has(uri),
			adopt: (session) => void sessions.adopt(session),
		}),
	});
	host.serve({
		turnPaging: {
			async fetchTurns(params) {
				await sessions.fetchTurns(params.channel, params.cursor);
				return {};
			},
		},
	});

	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	await client.initialize({ clientId: "paging-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

	return {
		host,
		client,
		server,
		sessionId,
		async close() {
			await client.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true });
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}

const state = (fixture: Fixture): ChatState => fixture.host.store.get(chatUri(fixture.sessionId)) as ChatState;

describe("fetchTurns", () => {
	let fixture: Fixture;

	before(async () => {
		// 25 pre-compaction exchanges, so a 20-turn page leaves a second one.
		fixture = await startFixture(25, 2);
	});

	after(async () => {
		await fixture.close();
	});

	it("advertises a cursor when history precedes the window", async () => {
		const { result } = await fixture.client.subscribe(chatUri(fixture.sessionId));
		const chat = must(result.snapshot).state as ChatState;

		// Its presence is the protocol's signal that `turns` is a tail window.
		assert.ok(chat.turnsNextCursor, "a compacted session must offer more history");
		assert.equal(checkSchema("state", "ChatState", chat), undefined);
	});

	it("prepends a page of older turns", async () => {
		const chat = chatUri(fixture.sessionId);
		const before = state(fixture);
		const beforeCount = before.turns.length;

		await fixture.client.request("fetchTurns", { channel: chat, cursor: before.turnsNextCursor } as never);

		const after = state(fixture);
		assert.ok(after.turns.length > beforeCount);
		// Older turns go in front, and the previously-visible ones stay put.
		assert.equal(after.turns.at(-1)?.id, before.turns.at(-1)?.id);
		assert.match(must(after.turns[0]).message.text, /question \d+/);
	});

	it("keeps the state ordered oldest-first across pages", async () => {
		const chat = chatUri(fixture.sessionId);
		let current = state(fixture);
		while (current.turnsNextCursor) {
			await fixture.client.request("fetchTurns", { channel: chat, cursor: current.turnsNextCursor } as never);
			current = state(fixture);
		}

		const numbered = current.turns
			.map((turn) => /question (\d+)/.exec(turn.message.text)?.[1])
			.filter((value): value is string => value !== undefined)
			.map(Number);
		assert.deepEqual(
			numbered,
			[...numbered].sort((a, b) => a - b),
		);
	});

	it("clears the cursor once the beginning is reached", () => {
		// Without this the client would keep asking for pages that do not exist.
		assert.equal(state(fixture).turnsNextCursor, undefined);
	});

	it("rejects a cursor it did not issue", async () => {
		const error = await fixture.client
			.request("fetchTurns", { channel: chatUri(fixture.sessionId), cursor: "made-up" } as never)
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32602);
	});
});

describe("fetchTurns — nothing older", () => {
	it("offers no cursor for a session that was never compacted", async () => {
		const fixture = await startFixture(0, 3);
		try {
			const { result } = await fixture.client.subscribe(chatUri(fixture.sessionId));
			assert.equal((must(result.snapshot).state as ChatState).turnsNextCursor, undefined);
		} finally {
			await fixture.close();
		}
	});
});
