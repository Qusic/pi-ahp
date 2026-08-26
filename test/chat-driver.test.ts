import { must } from "./harness.ts";
/**
 * The chat driver end-to-end: a client turn reaching a backend, streamed output
 * coming back as actions, and queued-message consumption.
 *
 * The backend is a scripted fake rather than a real agent — the point is the
 * host's turn arbitration, not the model.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	PendingMessageKind,
	SessionLifecycle,
	type SessionState,
	SUPPORTED_PROTOCOL_VERSIONS,
	TurnState,
} from "@microsoft/agent-host-protocol";
import type { AhpClient, Subscription } from "@microsoft/agent-host-protocol/client";
import { AhpClient as Client } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";

/**
 * A backend that records prompts and replays a scripted event sequence for each
 * one, so a turn's shape is fully determined by the test.
 */
class ScriptedBackend implements PiBackend {
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	aborts = 0;

	#listeners = new Set<(event: AgentSessionEvent) => void>();
	#script: (text: string) => AgentSessionEvent[];

	constructor(script: (text: string) => AgentSessionEvent[]) {
		this.#script = script;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		// Deliver asynchronously, like a real agent: the driver must not depend
		// on events arriving inside the prompt() call.
		await Promise.resolve();
		for (const event of this.#script(text)) {
			for (const listener of this.#listeners) {
				listener(event);
			}
		}
	}

	async steer(text: string): Promise<void> {
		this.steers.push(text);
	}

	async abort(): Promise<void> {
		this.aborts += 1;
	}
}

function say(text: string): AgentSessionEvent[] {
	const event = (value: object): AgentSessionEvent => value as unknown as AgentSessionEvent;
	return [
		event({ type: "agent_start" }),
		event({ type: "message_start", message: { role: "assistant" } }),
		event({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
		}),
		event({ type: "message_end", message: { role: "assistant" } }),
		event({ type: "agent_end", messages: [], willRetry: false }),
		event({ type: "agent_settled" }),
	];
}

interface Fixture {
	client: AhpClient;
	host: AhpHost;
	backend: ScriptedBackend;
	sessionChannel: string;
	chatChannel: string;
	subscription: Subscription;
	server: RunningServer;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("condition never became true");
		}
		await new Promise((resolve) => {
			const handle = setTimeout(resolve, 5);
			handle.unref?.();
		});
	}
}

describe("chat driver", () => {
	let fixture: Fixture;
	let backend: ScriptedBackend;

	before(async () => {
		const host = new AhpHost({ serverInfo: { name: "pi-ahp", version: "test" } });
		installRootChannel(host, []);
		backend = new ScriptedBackend((text) => (text === "long running" ? [] : say(`echo: ${text}`)));
		const sessions = new SessionRegistry({ host, createBackend: () => backend });
		host.serve({
			sessions: {
				create: (params) => sessions.create(params as never),
				dispose: (channel) => sessions.dispose(channel),
			},
		});

		const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
		const client = new Client(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
		await client.initialize({ clientId: "driver-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

		const id = randomUUID();
		const sessionChannel = sessionUri(id);
		const chatChannel = chatUri(id);
		await client.request("createSession", { channel: sessionChannel } as never);
		await client.subscribe(sessionChannel);
		const { subscription } = await client.subscribe(chatChannel);

		fixture = { client, host, backend, sessionChannel, chatChannel, subscription, server };
	});

	after(async () => {
		await fixture.client.shutdown();
		await fixture.server.close();
	});

	it("creates the session's default chat and points defaultChat at it", async () => {
		const session = fixture.host.store.get(fixture.sessionChannel) as SessionState;

		assert.equal(session.lifecycle, SessionLifecycle.Ready);
		assert.equal(session.chats.length, 1);
		assert.equal(session.chats[0]?.resource, fixture.chatChannel);
		assert.equal(session.defaultChat, fixture.chatChannel);
	});

	it("runs a client turn through the backend and streams the reply back", async () => {
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "t1",
			startedAt: new Date().toISOString(),
			message: { text: "hello", origin: { kind: "user" } },
		} as never);

		await waitFor(() => {
			const state = fixture.host.store.get(fixture.chatChannel) as ChatState;
			return state.turns.length === 1;
		});

		assert.deepEqual(backend.prompts, ["hello"]);
		const state = fixture.host.store.get(fixture.chatChannel) as ChatState;
		assert.equal(state.turns[0]?.state, TurnState.Complete);
		assert.equal((must(state.turns[0]).responseParts[0] as { content: string }).content, "echo: hello");
	});

	it("keeps the session catalog's chat summary in step", async () => {
		const session = fixture.host.store.get(fixture.sessionChannel) as SessionState;
		const chat = fixture.host.store.get(fixture.chatChannel) as ChatState;

		// `ChatState` denormalises every summary field, so the two drift unless
		// the host republishes them.
		assert.equal(session.chats[0]?.status, chat.status);
		assert.equal(session.chats[0]?.modifiedAt, chat.modifiedAt);
	});

	it("forwards a steering message to the backend but keeps queued ones in state", async () => {
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Steering,
			id: "steer-1",
			message: { text: "focus on tests", origin: { kind: "user" } },
		} as never);

		await waitFor(() => backend.steers.length === 1);
		assert.deepEqual(backend.steers, ["focus on tests"]);
	});

	it("consumes a queued message as its own turn once the chat goes idle", async () => {
		const promptsBefore = backend.prompts.length;

		// Queued messages never reach pi: the protocol's own state is the queue,
		// and the host starts a fresh turn for the head entry when idle.
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Queued,
			id: "q-1",
			message: { text: "then do this", origin: { kind: "user" } },
		} as never);

		await waitFor(() => backend.prompts.length === promptsBefore + 1);

		const state = fixture.host.store.get(fixture.chatChannel) as ChatState;
		assert.equal(backend.prompts.at(-1), "then do this");
		// The reducer removes the entry atomically with creating the turn, so a
		// client can never see it both queued and running.
		assert.equal(state.queuedMessages, undefined);
		assert.equal(state.turns.at(-1)?.state, TurnState.Complete);
	});

	it("aborts the backend when a client cancels the active turn", async () => {
		const abortsBefore = backend.aborts;
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-cancel",
			startedAt: new Date().toISOString(),
			message: { text: "long running", origin: { kind: "user" } },
		} as never);
		await waitFor(() => backend.prompts.includes("long running"));
		assert.equal((fixture.host.store.get(fixture.chatChannel) as ChatState).activeTurn?.id, "t-cancel");

		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatTurnCancelled,
			turnId: "t-cancel",
			duration: 0,
		} as never);

		await waitFor(() => backend.aborts === abortsBefore + 1);
	});
});

describe("chat driver — backend failure", () => {
	it("marks the session creationFailed when the backend cannot start", async () => {
		const host = new AhpHost();
		installRootChannel(host, []);
		const sessions = new SessionRegistry({
			host,
			createBackend: () => {
				throw new Error("no credentials");
			},
		});

		const uri = sessionUri(randomUUID());
		sessions.create({ channel: uri });
		await waitFor(() => (host.store.get(uri) as SessionState).lifecycle !== SessionLifecycle.Creating);

		const state = host.store.get(uri) as SessionState;
		assert.equal(state.lifecycle, SessionLifecycle.CreationFailed);
		assert.match(state.creationError?.message ?? "", /no credentials/);
	});

	it("closes the turn when prompt() rejects before any agent event", async () => {
		const host = new AhpHost();
		installRootChannel(host, []);
		const backend: PiBackend = {
			subscribe: () => () => {},
			prompt: () => Promise.reject(new Error("model unavailable")),
			steer: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		};
		const sessions = new SessionRegistry({ host, createBackend: () => backend });
		host.serve({
			sessions: {
				create: (params) => sessions.create(params as never),
				dispose: (channel) => sessions.dispose(channel),
			},
		});

		const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
		const client = new Client(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
		await client.initialize({ clientId: "failing-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

		try {
			const id = randomUUID();
			const chat = chatUri(id);
			await client.request("createSession", { channel: sessionUri(id) } as never);
			await client.subscribe(chat);

			// Dispatched through the wire so the reducer creates the active turn
			// before the side effect runs — the same ordering production relies on.
			client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "t1",
				startedAt: new Date().toISOString(),
				message: { text: "hi", origin: { kind: "user" } },
			} as never);

			// Nothing will ever emit `agent_settled`, so without explicit handling
			// the turn would stay active and the session stuck at InProgress.
			await waitFor(() => (host.store.get(chat) as ChatState).turns.length === 1);
			const state = host.store.get(chat) as ChatState;
			assert.equal(state.activeTurn, undefined);
			assert.equal(state.turns[0]?.state, TurnState.Error);
			assert.match(state.turns[0]?.error?.message ?? "", /model unavailable/);
		} finally {
			await client.shutdown();
			await server.close();
		}
	});
});

describe("steering message lifetime", () => {
	it("clears the pending message once pi consumes it", async () => {
		// The failure this covers looks like a hang: pi injects the steering
		// message into the run, but `ChatState.steeringMessage` never clears, so
		// the client shows it as forever unsent even though the model got it.
		const host = new AhpHost();
		installRootChannel(host, []);

		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const emit = (event: object): void => {
			for (const listener of listeners) {
				listener(event as unknown as AgentSessionEvent);
			}
		};
		const backend: PiBackend = {
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async () => {
				await Promise.resolve();
				emit({ type: "agent_start" });
			},
			steer: async () => {
				// pi acknowledges the message by growing its queue…
				emit({ type: "queue_update", steering: ["focus on tests"], followUp: [] });
			},
			abort: async () => {},
		};

		const sessions = new SessionRegistry({ host, createBackend: () => backend });
		host.serve({
			sessions: {
				create: (params) => sessions.create(params as never),
				dispose: (channel) => sessions.dispose(channel),
			},
		});
		const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
		const client = new Client(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
		await client.initialize({ clientId: "steer-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

		try {
			const id = randomUUID();
			const chat = chatUri(id);
			await client.request("createSession", { channel: sessionUri(id) } as never);
			await client.subscribe(chat);

			client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "t1",
				startedAt: new Date().toISOString(),
				message: { text: "go", origin: { kind: "user" } },
			} as never);
			client.dispatch(chat, {
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Steering,
				id: "steer-1",
				message: { text: "focus on tests", origin: { kind: "user" } },
			} as never);

			await waitFor(() => (host.store.get(chat) as ChatState).steeringMessage !== undefined);

			// …and consumes it by shrinking the queue right before injecting.
			emit({ type: "queue_update", steering: [], followUp: [] });

			await waitFor(() => (host.store.get(chat) as ChatState).steeringMessage === undefined);

			// The text itself is not recorded here — pi delivers it as an
			// ordinary user message, and the mapper turns that into its own
			// turn. Only the pending slot is cleared by this path.
		} finally {
			await client.shutdown();
			await server.close();
		}
	});
});
