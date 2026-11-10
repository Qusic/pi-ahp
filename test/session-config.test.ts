/** Pre-creation session configuration and per-message model selection. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { type AgentSessionEvent, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	JsonRpcErrorCodes,
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
import { MetadataStore } from "../src/pi/metadata-store.ts";
import { THINKING_CONFIG_KEY } from "../src/pi/models.ts";
import { PROJECT_TRUST_KEY, SessionConfigService } from "../src/pi/session-config.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { ProtocolError } from "../src/protocol/errors.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { must } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";
import { assertValid } from "./support/schema.ts";
import { inMemorySessionManagerFactory } from "./support/session-storage.ts";

describe("resolveSessionConfig", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;
	let bare: string;
	let parent: string;
	let withResources: string;
	let service: SessionConfigService;

	before(() => {
		// pi's trust store and settings live here, away from the user's profile.
		agentDir = mkdtempSync(join(tmpdir(), "pi-ahp-cfg-agent-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		bare = mkdtempSync(join(tmpdir(), "pi-ahp-cfg-bare-"));
		parent = mkdtempSync(join(tmpdir(), "pi-ahp-cfg-parent-"));
		withResources = join(parent, "repo");
		mkdirSync(join(withResources, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(withResources, ".pi", "extensions", "ext.ts"), "export default () => {};\n");
		service = new SessionConfigService({ defaultWorkingDirectory: bare });
	});

	beforeEach(() => {
		rmSync(join(agentDir, "trust.json"), { force: true });
	});

	after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const dir of [agentDir, bare, parent]) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const resolveFor = (directory: string, config?: Record<string, unknown>) =>
		service.resolve({ channel: "ahp-root://", workingDirectory: `file://${directory}`, ...(config ? { config } : {}) });
	const trustProperty = (result: ReturnType<typeof resolveFor>) => must(result.schema.properties[PROJECT_TRUST_KEY]);

	it("returns schema-conforming results", () => {
		// The default directory has nothing to gate; the other folder is editable.
		for (const result of [service.resolve({ channel: "ahp-root://" }), resolveFor(withResources)]) {
			assertValid("commands", "ResolveSessionConfigResult", result);
		}
	});

	it("shows a folder with nothing to gate as trusted and read-only", () => {
		const result = resolveFor(bare);
		assert.equal(result.values[PROJECT_TRUST_KEY], true);
		assert.equal(trustProperty(result).readOnly, true);
		assert.equal(trustProperty(result).description, "This folder has no trust-gated project resources.");
	});

	it("asks about a gated folder, preset to pi's default answer", () => {
		const result = resolveFor(withResources);
		const property = trustProperty(result);
		assert.equal(result.values[PROJECT_TRUST_KEY], false);
		assert.notEqual(property.readOnly, true);
		// Resources load when the session is created; the answer cannot change later.
		assert.notEqual(property.sessionMutable, true);
		assert.match(must(property.description), /^No saved decision; pi's defaultProjectTrust is "ask"\. /);
	});

	it("names the folder a saved decision belongs to", () => {
		const trust = new ProjectTrustStore(agentDir);
		for (const [folder, trusted] of [
			[parent, true],
			[withResources, false],
		] as const) {
			trust.set(folder, trusted);
			const result = resolveFor(withResources);
			assert.equal(result.values[PROJECT_TRUST_KEY], trusted);
			const description = must(trustProperty(result).description);
			assert.ok(description.startsWith(`Saved decision for ${realpathSync(folder)}. `), description);
		}
	});

	it("echoes the user's answer where the folder has a choice to make", () => {
		assert.equal(resolveFor(withResources, { [PROJECT_TRUST_KEY]: true }).values[PROJECT_TRUST_KEY], true);
	});

	it("keeps the folder's answer where there is no choice or the answer is not a boolean", () => {
		assert.equal(resolveFor(bare, { [PROJECT_TRUST_KEY]: false }).values[PROJECT_TRUST_KEY], true);
		assert.equal(resolveFor(withResources, { [PROJECT_TRUST_KEY]: "yes" }).values[PROJECT_TRUST_KEY], false);
	});

	it("refuses an answer that is not a boolean", () => {
		assert.throws(() => service.applyAtCreation(withResources, { [PROJECT_TRUST_KEY]: "yes" }), {
			code: JsonRpcErrorCodes.InvalidParams,
			message: "projectTrust must be true or false.",
		});
		assert.equal(existsSync(join(agentDir, "trust.json")), false);
	});

	it("refuses creation when pi's trust store fails", () => {
		writeFileSync(join(agentDir, "trust.json"), "not json");
		assert.throws(
			() => service.applyAtCreation(withResources, { [PROJECT_TRUST_KEY]: true }),
			(error) =>
				error instanceof ProtocolError &&
				error.code === JsonRpcErrorCodes.InternalError &&
				error.message.startsWith(`Could not save the project trust decision for ${withResources}: `),
		);
	});
});

/** A backend that records, in order, the models it was given and the prompts it ran. */
class SelectionRecordingBackend implements PiBackend {
	readonly calls: Array<{ select: ModelSelection } | { prompt: string }> = [];
	current: ModelSelection = { id: "default-model", config: { [THINKING_CONFIG_KEY]: "medium" } };

	#listeners = new Set<(event: AgentSessionEvent) => void>();

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.calls.push({ prompt: text });
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
		this.calls.push({ select: selection });
		this.current = selection;
	}

	currentSelection(): ModelSelection {
		return this.current;
	}
}

describe("model selection", () => {
	let metadataDir: string;
	let metadata: MetadataStore;
	let host: AhpHost;
	let client: AhpClient;
	let server: RunningServer;
	let backend: SelectionRecordingBackend;
	let chat: string;

	before(async () => {
		metadataDir = mkdtempSync(join(tmpdir(), "pi-ahp-selection-metadata-"));
		metadata = new MetadataStore(metadataDir);
		host = new AhpHost();
		installRootChannel(host, []);
		backend = new SelectionRecordingBackend();
		const sessions = new SessionRegistry({
			host,
			metadata,
			createBackend: () => backend,
			createSessionManager: inMemorySessionManagerFactory,
			// The backend is authoritative once it starts, including config values.
			defaultSelection: () => ({ id: "default-model", config: { [THINKING_CONFIG_KEY]: "low" } }),
		});
		host.serve({
			sessions: {
				create: (params) => sessions.create(params),
				dispose: (channel) => sessions.dispose(channel),
			},
		});

		server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
		client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
		await client.initialize({ clientId: "model-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

		const id = randomUUID();
		chat = chatUri(id);
		await client.request("createSession", { channel: sessionUri(id) });
		await client.subscribe(chat);
		await eventually(
			"the backend model to reach the chat draft",
			() => (host.store.get(chat) as ChatState).draft?.model?.id === "default-model",
		);
	});

	after(async () => {
		await client.shutdown();
		await server.close();
		rmSync(metadataDir, { recursive: true, force: true });
	});

	it("has a model selected before the agent has even started", () => {
		// Starting an agent takes seconds. A client that subscribes in the
		// meantime would otherwise find an empty picker and be unable to send.
		const host2 = new AhpHost();
		installRootChannel(host2, []);
		const registry = new SessionRegistry({
			host: host2,
			metadata,
			createSessionManager: inMemorySessionManagerFactory,
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
		const before = backend.calls.length;
		client.dispatch(chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-model",
			startedAt: new Date().toISOString(),
			message: {
				text: "hi",
				origin: { kind: MessageKind.User },
				model: { id: "picked-model", config: { [THINKING_CONFIG_KEY]: "high" } },
			},
		});
		await eventually("the prompt to reach the backend", () =>
			backend.calls.some((call) => "prompt" in call && call.prompt === "hi"),
		);

		// Selecting after the prompt would run the turn on whatever the previous one used.
		assert.deepEqual(backend.calls.slice(before), [
			{ select: { id: "picked-model", config: { [THINKING_CONFIG_KEY]: "high" } } },
			{ prompt: "hi" },
		]);
	});

	it("runs on the current model when the message carries no selection", async () => {
		const before = backend.calls.length;
		client.dispatch(chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-plain",
			startedAt: new Date().toISOString(),
			message: { text: "again", origin: { kind: MessageKind.User } },
		});
		await eventually("the prompt to reach the backend", () =>
			backend.calls.some((call) => "prompt" in call && call.prompt === "again"),
		);

		assert.deepEqual(backend.calls.slice(before), [{ prompt: "again" }]);
	});
});
