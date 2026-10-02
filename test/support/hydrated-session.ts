import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
import { MetadataStore } from "../../src/pi/metadata-store.ts";
import { PiSessionCatalogue } from "../../src/pi/session-catalogue.ts";
import { SessionHydrator } from "../../src/pi/session-hydrator.ts";
import { type SessionFileDeletionResult, SessionRegistry } from "../../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../../src/transport/websocket.ts";
import { writeSessionFixture } from "./session-files.ts";
import { persistentSessionManagerFactory } from "./session-storage.ts";

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
	readonly metadata: MetadataStore;
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
	writeSessionFixture(root, sessionId, workspace, options.includeImage);

	const host = new AhpHost();
	installRootChannel(host, []);
	const metadata = new MetadataStore(join(root, "ahp"));
	const catalogue = new PiSessionCatalogue(root, metadata);
	const deletedFiles: string[] = [];
	const backend = new RecordingBackend();
	const sessions = new SessionRegistry({
		host,
		metadata,
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
			metadata,
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
		metadata,
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
