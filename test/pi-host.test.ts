/** The production composition root wires its independently tested services together. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	ActionType,
	type ChatState,
	CompletionItemKind,
	SessionLifecycle,
	type SessionState,
	SessionStatus,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { createPiHost } from "../src/host/pi-host.ts";
import { MetadataStore } from "../src/pi/metadata-store.ts";
import { PROJECT_TRUST_KEY } from "../src/pi/session-config.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { must } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";
import { writeSessionFixture } from "./support/session-files.ts";
import { persistentSessionStorage } from "./support/session-storage.ts";

it("wires product services through createPiHost", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-composition-"));
	const sessionRoot = mkdtempSync(join(tmpdir(), "pi-ahp-composition-sessions-"));
	writeFileSync(join(workspace, "notes.md"), "# Notes\n");
	const metadata = new MetadataStore(join(sessionRoot, "ahp"));
	const built = await createPiHost({
		serverInfo: { name: "pi-ahp", version: "composition-test" },
		workingDirectory: workspace,
		modelRuntime: { getAvailable: async () => [] },
		sessionStorage: persistentSessionStorage(sessionRoot, metadata),
		metadata,
		createBackend: () => ({
			subscribe: () => () => {},
			prompt: async () => {},
			steer: async () => {},
			abort: async () => {},
		}),
		deleteFile: () => ({ ok: true }),
	});
	const server = await serveWebSocket(built.host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();

	try {
		const initialized = await client.initialize({
			clientId: "composition-client",
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [ROOT_CHANNEL],
		});
		assert.deepEqual(initialized.completionTriggerCharacters, ["@"]);

		const resource = await client.resourceRead({ uri: pathToFileURL(join(workspace, "notes.md")).toString() });
		assert.equal(resource.data, "# Notes\n");

		const config = await client.request("resolveSessionConfig", {
			channel: ROOT_CHANNEL,
			workingDirectory: pathToFileURL(workspace).toString(),
		});
		assert.ok(config.schema.properties[PROJECT_TRUST_KEY]);

		const id = randomUUID();
		const session = sessionUri(id);
		const chat = chatUri(id);
		await client.request("createSession", { channel: session });
		await client.subscribe(chat);
		await eventually(
			"the composed session backend to become ready",
			() => (built.host.store.get(session) as SessionState).lifecycle === SessionLifecycle.Ready,
		);

		const completions = await client.completions({
			kind: CompletionItemKind.UserMessage,
			channel: chat,
			text: "see @not",
			offset: 8,
		});
		assert.deepEqual(
			completions.items.map((item) => item.insertText),
			["@notes.md"],
		);
	} finally {
		await client.shutdown();
		await server.close();
		built.terminals.shutdown();
		await Promise.all([built.changesets.dispose(), built.watches.dispose()]);
		rmSync(workspace, { recursive: true, force: true });
		rmSync(sessionRoot, { recursive: true, force: true });
	}
});

it("restores persisted archive in cold and live summaries without archiving the chat or touching Pi history", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-archive-read-"));
	let built: Awaited<ReturnType<typeof createPiHost>> | undefined;
	let server: RunningServer | undefined;
	let client: AhpClient | undefined;
	t.after(async () => {
		try {
			await client?.shutdown();
			await server?.close();
			built?.terminals.shutdown();
			if (built) await Promise.all([built.changesets.dispose(), built.watches.dispose()]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	const workspace = join(root, "workspace");
	const sessionRoot = join(root, "sessions");
	mkdirSync(workspace);
	const id = randomUUID();
	const file = writeSessionFixture(sessionRoot, id, workspace);
	const history = readFileSync(file);
	const timestamp = new Date("2025-06-01T12:00:00.000Z");
	utimesSync(file, timestamp, timestamp);
	const modifiedAt = timestamp.toISOString();
	const ahpDir = join(root, "ahp");
	new MetadataStore(ahpDir).sessions.set(id, "archive", true);
	const metadata = new MetadataStore(ahpDir);
	const createBackend = t.mock.fn(() => {
		throw new Error("reading history must not start an agent");
	});
	built = await createPiHost({
		workingDirectory: workspace,
		modelRuntime: { getAvailable: async () => [] },
		sessionStorage: persistentSessionStorage(sessionRoot, metadata),
		metadata,
		createBackend,
	});
	server = await serveWebSocket(built.host, { host: "127.0.0.1", port: 0 });
	client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	await client.initialize({ clientId: "archive-read-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

	const session = sessionUri(id);
	const chat = chatUri(id);
	const archivedStatus = SessionStatus.Idle | SessionStatus.IsRead | SessionStatus.IsArchived;
	const cold = await client.request("listSessions", { channel: ROOT_CHANNEL });
	assert.equal(cold.items.length, 1);
	assert.equal(cold.items[0]?.resource, session);
	assert.equal(cold.items[0]?.status, archivedStatus);
	assert.equal(cold.items[0]?.modifiedAt, modifiedAt);
	assert.equal(built.host.store.has(session), false, "listing must not hydrate the session");
	assert.equal(built.host.store.has(chat), false);

	const subscribed = await client.subscribe(session);
	const state = must(subscribed.result.snapshot).state as SessionState;
	assert.equal(state.status, archivedStatus);
	assert.equal(state.chats[0]?.status, SessionStatus.Idle | SessionStatus.IsRead);
	const chatState = must((await client.subscribe(chat)).result.snapshot).state as ChatState;
	assert.equal(chatState.status, SessionStatus.Idle | SessionStatus.IsRead);
	const live = await client.request("listSessions", { channel: ROOT_CHANNEL });
	assert.equal(live.items.length, 1);
	assert.equal(live.items[0]?.status, archivedStatus);
	assert.equal(live.items[0]?.modifiedAt, modifiedAt);
	client.dispatch(session, { type: ActionType.SessionIsArchivedChanged, isArchived: false });
	await client.ping();
	assert.equal(metadata.sessions.get(id, "archive"), false, "the composed writer must use the same sidecar");
	assert.equal((built.host.store.get(session) as SessionState).status & SessionStatus.IsArchived, 0);
	const unarchived = await client.request("listSessions", { channel: ROOT_CHANNEL });
	assert.equal(unarchived.items[0]?.status, SessionStatus.Idle | SessionStatus.IsRead);
	assert.equal(unarchived.items[0]?.modifiedAt, modifiedAt);
	assert.equal(createBackend.mock.callCount(), 0, "browsing and archiving must not start an agent");
	assert.deepEqual(readFileSync(file), history);
	assert.equal(statSync(file).mtime.toISOString(), modifiedAt);
});
