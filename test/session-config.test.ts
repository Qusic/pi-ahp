import { must } from "./harness.ts";
/**
 * Session configuration and model selection.
 *
 * Both exist because a client asked for them and got nothing back: a missing
 * `resolveSessionConfig` is a hard error before a session can even be created,
 * and a model chosen in the client had no effect because `Message.model` was
 * being dropped.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	MessageKind,
	type ModelSelection,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import { THINKING_CONFIG_KEY } from "../src/pi/models.ts";
import { PROJECT_TRUST_KEY, SessionConfigService } from "../src/pi/session-config.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { checkSchema } from "./support/schema.ts";

async function settle(ms = 80): Promise<void> {
	await new Promise((resolve) => {
		const handle = setTimeout(resolve, ms);
		handle.unref?.();
	});
}

describe("resolveSessionConfig", () => {
	let bare: string;
	let withResources: string;
	let service: SessionConfigService;

	before(() => {
		bare = mkdtempSync(join(tmpdir(), "pi-ahp-cfg-bare-"));
		withResources = mkdtempSync(join(tmpdir(), "pi-ahp-cfg-proj-"));
		mkdirSync(join(withResources, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(withResources, ".pi", "extensions", "ext.ts"), "export default () => {};\n");
		service = new SessionConfigService({ defaultWorkingDirectory: bare });
	});

	after(() => {
		rmSync(bare, { recursive: true, force: true });
		rmSync(withResources, { recursive: true, force: true });
	});

	it("returns a schema-conforming result", () => {
		const result = service.resolve({ channel: "ahp-root://" });
		assert.equal(checkSchema("commands", "ResolveSessionConfigResult", result), undefined);
	});

	it("reports what a directory with no project resources would do", () => {
		const result = service.resolve({ channel: "ahp-root://", workingDirectory: `file://${bare}` });
		assert.equal(result.values[PROJECT_TRUST_KEY], true);
		assert.match(must(result.schema.properties[PROJECT_TRUST_KEY]).description ?? "", /no project-level/);
	});

	it("re-resolves against whatever directory the client is asking about", () => {
		// The exchange is iterative: the answer changes as the user picks a
		// directory, which is the whole reason the command exists.
		const result = service.resolve({ channel: "ahp-root://", workingDirectory: `file://${withResources}` });
		assert.equal(result.values[PROJECT_TRUST_KEY], true);
		assert.match(must(result.schema.properties[PROJECT_TRUST_KEY]).description ?? "", /\.pi directory/);
	});

	it("offers no dynamic completions", () => {
		const result = service.completions({ channel: "ahp-root://", property: PROJECT_TRUST_KEY });
		assert.deepEqual(result.items, []);
	});
});

/** A backend that records the model selection each turn ran with. */
class SelectionRecordingBackend implements PiBackend {
	readonly selections: ModelSelection[] = [];
	readonly prompts: string[] = [];
	current: ModelSelection = { id: "default-model", config: { [THINKING_CONFIG_KEY]: "medium" } };

	#listeners = new Set<(event: AgentSessionEvent) => void>();

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		await Promise.resolve();
		for (const event of [{ type: "agent_start" }, { type: "agent_settled" }]) {
			for (const listener of this.#listeners) {
				listener(event as unknown as AgentSessionEvent);
			}
		}
	}

	async steer(): Promise<void> {}
	async abort(): Promise<void> {}

	async selectModel(selection: ModelSelection): Promise<void> {
		this.selections.push(selection);
		this.current = selection;
	}

	currentSelection(): ModelSelection {
		return this.current;
	}
}

describe("model selection", () => {
	let host: AhpHost;
	let client: AhpClient;
	let server: RunningServer;
	let backend: SelectionRecordingBackend;
	let chat: string;

	before(async () => {
		host = new AhpHost();
		installRootChannel(host, []);
		backend = new SelectionRecordingBackend();
		const sessions = new SessionRegistry({
			host,
			createBackend: () => backend,
			// The backend is authoritative once it starts, including config values.
			defaultSelection: () => ({ id: "default-model", config: { [THINKING_CONFIG_KEY]: "low" } }),
		});
		host.serve({
			sessions: {
				create: (params) => sessions.create(params as never),
				dispose: (channel) => sessions.dispose(channel),
			},
		});

		server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
		client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
		await client.initialize({ clientId: "model-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

		const id = randomUUID();
		chat = chatUri(id);
		await client.request("createSession", { channel: sessionUri(id) } as never);
		await client.subscribe(chat);
		await settle();
	});

	after(async () => {
		await client.shutdown();
		await server.close();
	});

	it("has a model selected before the agent has even started", () => {
		// Starting an agent takes seconds. A client that subscribes in the
		// meantime would otherwise find an empty picker and be unable to send.
		const host2 = new AhpHost();
		installRootChannel(host2, []);
		const registry = new SessionRegistry({
			host: host2,
			defaultSelection: () => ({ id: "seeded-model", config: { [THINKING_CONFIG_KEY]: "medium" } }),
		});
		const id = randomUUID();
		registry.create({ channel: sessionUri(id) });

		const state = host2.store.get(chatUri(id)) as ChatState;
		assert.equal(state.draft?.model?.id, "seeded-model");
	});

	it("publishes the model and config actually in effect as the chat draft", () => {
		// There is no protocol field for "the default model"; a client
		// initialises its input from `draft`, so this is how a host answers. The
		// backend must also correct a stale config for the same model id.
		const state = host.store.get(chat) as ChatState;
		assert.equal(state.draft?.model?.id, "default-model");
		assert.equal(state.draft?.model?.config?.[THINKING_CONFIG_KEY], "medium");
	});

	it("applies the model a client picked, before the prompt runs", async () => {
		client.dispatch(chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-model",
			startedAt: new Date().toISOString(),
			message: {
				text: "hi",
				origin: { kind: MessageKind.User },
				model: { id: "picked-model", config: { [THINKING_CONFIG_KEY]: "high" } },
			},
		} as never);
		await settle(200);

		assert.deepEqual(backend.selections.at(-1), {
			id: "picked-model",
			config: { [THINKING_CONFIG_KEY]: "high" },
		});
		// Ordering matters: selecting after the prompt would run the turn on
		// whatever the previous one used.
		assert.equal(backend.prompts.length, 1);
	});

	it("runs on the current model when the message carries no selection", async () => {
		const before = backend.selections.length;
		client.dispatch(chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-plain",
			startedAt: new Date().toISOString(),
			message: { text: "again", origin: { kind: MessageKind.User } },
		} as never);
		await settle(200);

		assert.equal(backend.selections.length, before, "no selection means no switch");
		assert.equal(backend.prompts.length, 2);
	});
});
