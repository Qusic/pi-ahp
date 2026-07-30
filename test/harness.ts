import assert from "node:assert/strict";
/**
 * Test harness: a live host over a real WebSocket, driven by the official
 * `@microsoft/agent-host-protocol` client.
 *
 * Using the published client (rather than hand-rolled frames) means these tests
 * exercise the same code path a real consumer — VS Code, AHPX — would.
 */

import type { AgentInfo } from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { AhpHost } from "../src/core/host.ts";
import { PI_PROVIDER } from "../src/pi/provider.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";

export const TEST_AGENT: AgentInfo = {
	provider: PI_PROVIDER,
	displayName: "pi",
	description: "pi coding agent",
	models: [{ id: "test-model", provider: PI_PROVIDER, name: "Test Model" }],
};

export interface Harness {
	readonly host: AhpHost;
	readonly server: RunningServer;
	readonly url: string;
	/** Present when the harness was started with `sessions: true`. */
	readonly sessions?: SessionRegistry;
	/** Files disposal asked to delete, so tests can assert without touching disk. */
	readonly deletedFiles: string[];
	/** Opens a connected, not-yet-initialized client. */
	connect(): Promise<AhpClient>;
	/** Connects with an explicit query string, for token-parameter tests. */
	connectWith(query: string): Promise<AhpClient>;
	dispose(): Promise<void>;
}

export async function startHarness(
	options: {
		agents?: AgentInfo[];
		token?: string;
		replayBufferCapacity?: number;
		/** Wire the session lifecycle handler and catalogue. */
		sessions?: boolean;
		/** Working directory for sessions created without one. */
		workingDirectory?: string;
		/** Root of the session catalogue; defaults to pi's real sessions directory. */
		catalogueRoot?: string;
	} = {},
): Promise<Harness> {
	const host = new AhpHost({
		serverInfo: { name: "pi-ahp", version: "0.0.1-test" },
		...(options.replayBufferCapacity !== undefined ? { replayBufferCapacity: options.replayBufferCapacity } : {}),
	});
	installRootChannel(host, options.agents ?? [TEST_AGENT]);

	const deletedFiles: string[] = [];
	let sessions: SessionRegistry | undefined;
	if (options.sessions) {
		sessions = new SessionRegistry({
			host,
			defaultWorkingDirectory: options.workingDirectory ?? process.cwd(),
			deleteFile: (path) => deletedFiles.push(path),
		});
		host.serve({ catalogue: new PiSessionCatalogue(options.catalogueRoot) });
		host.serve({
			sessions: {
				create: (params) => must(sessions).create(params as never),
				dispose: (channel) => must(sessions).dispose(channel),
			},
		});
	}

	const server = await serveWebSocket(host, {
		host: "127.0.0.1",
		port: 0,
		...(options.token ? { token: options.token } : {}),
	});
	const base = `ws://127.0.0.1:${server.port}`;
	const url = options.token ? `${base}?token=${options.token}` : base;
	const clients: AhpClient[] = [];

	return {
		host,
		server,
		url,
		...(sessions ? { sessions } : {}),
		deletedFiles,
		async connectWith(query: string) {
			const client = new AhpClient(await WebSocketTransport.connect(`${base}${query}`));
			client.connect();
			clients.push(client);
			return client;
		},
		async connect() {
			// `WebSocketTransport.connect` uses the global `WebSocket` (Node 21+),
			// so no `ws` shim is needed on the client side.
			const client = new AhpClient(await WebSocketTransport.connect(url));
			client.connect();
			clients.push(client);
			return client;
		},
		async dispose() {
			await Promise.allSettled(clients.map((client) => client.shutdown()));
			await server.close();
		},
	};
}

let clientCounter = 0;

export function nextClientId(): string {
	return `test-client-${++clientCounter}`;
}

/**
 * Narrows away `undefined` the way a test means it: as an assertion.
 *
 * `noUncheckedIndexedAccess` makes every `turns[0]` optional, and the protocol
 * marks plenty of fields optional that are certain in a given scenario. Writing
 * `turns[0]!` silences the type error but not the failure: when the value is
 * missing the test dies on a TypeError several lines later, naming a property
 * rather than the missing thing. This reports the missing thing.
 */
export function must<T>(value: T | undefined | null, what = "value"): T {
	if (value === undefined || value === null) {
		assert.fail(`expected ${what} to be present`);
	}
	return value;
}
