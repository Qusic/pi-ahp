import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../../src/channels/root.ts";
import { ROOT_CHANNEL } from "../../src/core/channels.ts";
import { AhpHost } from "../../src/core/host.ts";
import type { PiBackend } from "../../src/pi/chat-driver.ts";
import { PiSessionCatalogue } from "../../src/pi/session-catalogue.ts";
import { SessionHydrator } from "../../src/pi/session-hydrator.ts";
import { type SessionFileDeletionResult, SessionRegistry } from "../../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../../src/transport/websocket.ts";
import { ONE_PIXEL_PNG } from "./images.ts";
import { fixtureSessionDirectory } from "./session-files.ts";
import { persistentSessionManagerFactory } from "./session-storage.ts";

/** Writes a pi session file containing one full turn with a tool call. */
function writeSession(root: string, id: string, cwd: string, includeImage: boolean): void {
	const directory = fixtureSessionDirectory(root, cwd);

	const at = "2026-01-01T00:00:00.000Z";
	let parentId: string | null = null;
	const lines: string[] = [JSON.stringify({ type: "session", id, parentId: null, timestamp: at, version: 3, cwd })];
	const push = (entry: Record<string, unknown>): void => {
		const entryId = randomUUID();
		lines.push(JSON.stringify({ ...entry, id: entryId, parentId, timestamp: at }));
		parentId = entryId;
	};

	push({
		type: "message",
		message: {
			role: "user",
			content: includeImage
				? [
						{ type: "text", text: "Read note.txt" },
						{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
					]
				: "Read note.txt",
			timestamp: 0,
		},
	});
	push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I should read it." },
				{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "note.txt" } },
			],
			usage: { input: 10, output: 5, cacheRead: 0 },
			provider: "fixture",
			model: "test-model",
			timestamp: 0,
		},
	});
	push({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "ALPHA" }],
			timestamp: 0,
		},
	});
	push({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "It says ALPHA." }],
			provider: "fixture",
			model: "test-model",
			timestamp: 0,
		},
	});
	push({ type: "message", message: { role: "user", content: "Thanks", timestamp: 0 } });

	writeFileSync(join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${lines.join("\n")}\n`);
}

/** Records what a resumed session actually asks the agent to do. */
export class RecordingBackend implements PiBackend {
	readonly prompts: string[] = [];
	readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		await Promise.resolve();
		for (const event of [{ type: "agent_start" }, { type: "agent_settled" }]) {
			for (const listener of this.#listeners) listener(event as unknown as AgentSessionEvent);
		}
	}

	async steer(): Promise<void> {}
	async abort(): Promise<void> {}
}

export interface HydratedSessionFixture {
	readonly host: AhpHost;
	readonly client: AhpClient;
	readonly server: RunningServer;
	readonly sessionId: string;
	readonly root: string;
	readonly workspace: string;
	readonly deletedFiles: string[];
	readonly backend: RecordingBackend;
	connectAsVSCode(): Promise<AhpClient>;
	close(): Promise<void>;
}

export async function startHydratedSessionFixture(
	options: {
		deleteFile?: (path: string) => SessionFileDeletionResult | Promise<SessionFileDeletionResult>;
		includeImage?: boolean;
	} = {},
): Promise<HydratedSessionFixture> {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-hydrate-"));
	const workspace = mkdtempSync(join(tmpdir(), "pi ahp hydrate cwd-"));
	const sessionId = randomUUID();
	writeSession(root, sessionId, workspace, options.includeImage ?? false);

	const host = new AhpHost();
	installRootChannel(host, []);
	const catalogue = new PiSessionCatalogue(root);
	const deletedFiles: string[] = [];
	const backend = new RecordingBackend();
	const sessions = new SessionRegistry({
		host,
		defaultWorkingDirectory: workspace,
		createBackend: () => backend,
		createSessionManager: persistentSessionManagerFactory(root),
		deleteFile: async (path) => {
			deletedFiles.push(path);
			if (options.deleteFile) {
				return options.deleteFile(path);
			}
			rmSync(path, { force: true });
			return { ok: true };
		},
		findSessionFile: (id) => catalogue.findSessionFile(id),
	});
	host.serve({
		catalogue: {
			list: (limit, cursor) => catalogue.list(limit, cursor, () => sessions.catalogueOverrides()),
		},
		hydrator: new SessionHydrator({
			host,
			catalogue,
			isLive: (session) => sessions.has(session),
			isDisposing: (session) => sessions.isDisposing(session),
			adopt: (session) => void sessions.adopt(session),
			fallbackSelection: () => ({ id: "fallback-model", config: { thinkingLevel: "medium" } }),
		}),
		sessions: {
			create: (params) => sessions.create(params),
			dispose: (channel) => sessions.dispose(channel),
		},
	});

	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const clients: AhpClient[] = [];
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	clients.push(client);
	await client.initialize({ clientId: "hydrate-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

	return {
		host,
		client,
		server,
		sessionId,
		root,
		workspace,
		deletedFiles,
		backend,
		async connectAsVSCode() {
			const other = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
			other.connect();
			clients.push(other);
			await other.request("initialize", {
				channel: ROOT_CHANNEL,
				clientId: `vscode-client-${clients.length}`,
				protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
				clientInfo: { name: "vscode-editor-window", title: "VS Code" },
			});
			return other;
		},
		async close() {
			await Promise.allSettled(clients.map((candidate) => candidate.shutdown()));
			await server.close();
			rmSync(root, { recursive: true, force: true });
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}
