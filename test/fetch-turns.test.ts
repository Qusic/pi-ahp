/**
 * Paging older turns into a chat.
 *
 * A hydrated chat starts with the latest complete turns. Older turns can be
 * paged in regardless of where pi compacted its model context.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	type ChatState,
	JsonRpcErrorCodes,
	ResponsePartKind,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import { MetadataStore } from "../src/pi/metadata-store.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { SessionHydrator } from "../src/pi/session-hydrator.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { must } from "./support/assertions.ts";
import { assertValid } from "./support/schema.ts";
import { fixtureSessionDirectory } from "./support/session-files.ts";
import { persistentSessionManagerFactory } from "./support/session-storage.ts";

/**
 * Writes `before` exchanges, optionally a compaction, then `after` exchanges.
 * A compaction is a notice in the user transcript, not its paging boundary.
 */
function writePagedSession(root: string, id: string, cwd: string, before: number, after: number): void {
	const directory = fixtureSessionDirectory(root, cwd);
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

	let lastUserId: string | undefined;
	for (let i = 0; i < before; i++) {
		lastUserId = exchange(i);
	}
	if (lastUserId) {
		// Pi keeps the most recent exchange in model context without erasing earlier chat history.
		push({ type: "compaction", summary: "earlier work", firstKeptEntryId: lastUserId, tokensBefore: 1000 });
	}
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
	writePagedSession(root, sessionId, workspace, before, after);

	const host = new AhpHost();
	installRootChannel(host, []);
	const metadata = new MetadataStore(join(root, "ahp"));
	const catalogue = new PiSessionCatalogue(root, metadata);
	host.serve({ catalogue });
	const sessions = new SessionRegistry({
		host,
		metadata,
		defaultWorkingDirectory: workspace,
		createSessionManager: persistentSessionManagerFactory(root),
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
		// 47 turns, so a 20-turn initial window leaves two older pages.
		fixture = await startFixture(45, 2);
		await fixture.client.subscribe(chatUri(fixture.sessionId));
	});

	after(async () => {
		await fixture.close();
	});

	it("pages backward while preserving a complete oldest-first transcript", async () => {
		const channel = chatUri(fixture.sessionId);
		const initial = state(fixture);

		// Its presence is the protocol's signal that `turns` is a tail window.
		assert.ok(initial.turnsNextCursor, "earlier complete turns must be pageable");
		assertValid("state", "ChatState", initial);
		assert.equal(initial.turns.length, 20);
		assert.equal(initial.turns[0]?.message.text, "question 27");
		assert.equal(
			initial.turns.find((turn) => turn.message.text === "question 44")?.responseParts.at(-1)?.kind,
			ResponsePartKind.SystemNotification,
		);
		const newestTurn = initial.turns.at(-1)?.id;
		const initialCount = initial.turns.length;

		await fixture.client.request("fetchTurns", { channel, cursor: initial.turnsNextCursor });
		let current = state(fixture);
		assert.ok(current.turns.length > initialCount);
		assert.equal(current.turns.at(-1)?.id, newestTurn, "paging must preserve the visible tail");
		assert.match(must(current.turns[0]).message.text, /question \d+/);

		while (current.turnsNextCursor) {
			await fixture.client.request("fetchTurns", { channel, cursor: current.turnsNextCursor });
			current = state(fixture);
		}

		const numbered = current.turns
			.map((turn) => /question (\d+)/.exec(turn.message.text)?.[1])
			.filter((value): value is string => value !== undefined)
			.map(Number);
		assert.deepEqual(
			numbered,
			Array.from({ length: 47 }, (_, i) => i),
			"all turns appear exactly once",
		);
		assert.equal(current.turns.length, 47, "compaction must not create an extra user turn");
		assert.equal(
			current.turns
				.flatMap((turn) => turn.responseParts)
				.filter((part) => part.kind === ResponsePartKind.SystemNotification).length,
			1,
			"compaction is one in-turn notice, not a duplicated turn",
		);
		// Without this the client would keep asking for pages that do not exist.
		assert.equal(current.turnsNextCursor, undefined);
	});

	it("rejects a session channel for this chat-scoped command", async () => {
		await assert.rejects(
			fixture.client.request("fetchTurns", { channel: sessionUri(fixture.sessionId) }),
			(error: unknown) => error instanceof RpcError && error.code === JsonRpcErrorCodes.InvalidParams,
		);
	});

	it("rejects a cursor it did not issue", async () => {
		const error = await fixture.client
			.request("fetchTurns", { channel: chatUri(fixture.sessionId), cursor: "made-up" })
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32602);
	});
});

describe("fetchTurns — window boundaries", () => {
	it("offers no cursor when every turn fits in the initial window", async () => {
		const fixture = await startFixture(0, 3);
		try {
			const { result } = await fixture.client.subscribe(chatUri(fixture.sessionId));
			assert.equal((must(result.snapshot).state as ChatState).turnsNextCursor, undefined);
		} finally {
			await fixture.close();
		}
	});

	it("pages a long session without any compaction", async () => {
		const fixture = await startFixture(0, 22);
		try {
			const channel = chatUri(fixture.sessionId);
			const { result } = await fixture.client.subscribe(channel);
			const initial = must(result.snapshot).state as ChatState;
			assert.equal(initial.turns.length, 20);
			assert.equal(initial.turns[0]?.message.text, "question 2");
			assert.ok(initial.turnsNextCursor);

			await fixture.client.request("fetchTurns", { channel, cursor: initial.turnsNextCursor });
			const current = state(fixture);
			assert.equal(current.turns.length, 22);
			assert.equal(current.turns[0]?.message.text, "question 0");
			assert.equal(current.turnsNextCursor, undefined);
		} finally {
			await fixture.close();
		}
	});
});
