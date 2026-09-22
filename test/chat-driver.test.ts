/**
 * The chat driver end-to-end: a client turn reaching a backend, streamed output
 * coming back as actions, and queued-message consumption.
 *
 * The backend is a scripted fake rather than a real agent — the point is the
 * host's turn arbitration, not the model.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	MessageAttachmentKind,
	MessageKind,
	PendingMessageKind,
	SessionLifecycle,
	type SessionState,
	SUPPORTED_PROTOCOL_VERSIONS,
	TurnState,
} from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { AhpClient as Client } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { serveWebSocket } from "../src/transport/websocket.ts";
import { must, turnError } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";
import { ONE_PIXEL_PNG } from "./support/images.ts";
import { inMemorySessionManagerFactory } from "./support/session-storage.ts";

/**
 * A backend that records prompts and replays a scripted event sequence for each
 * one, so a turn's shape is fully determined by the test.
 */
class ScriptedBackend implements PiBackend {
	readonly prompts: string[] = [];
	readonly promptImages: Array<ImageContent[] | undefined> = [];
	readonly steers: string[] = [];
	readonly steeringImages: Array<ImageContent[] | undefined> = [];
	promptCalls = 0;
	promptGate: Promise<void> | undefined;
	aborts = 0;
	selections = 0;
	selectionGate: Promise<void> | undefined;

	#listeners = new Set<(event: AgentSessionEvent) => void>();
	#script: (text: string) => AgentSessionEvent[];

	constructor(script: (text: string) => AgentSessionEvent[]) {
		this.#script = script;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	async prompt(text: string, images?: ImageContent[], signal?: AbortSignal): Promise<void> {
		this.promptCalls += 1;
		if (this.promptGate) await this.promptGate;
		if (signal?.aborted) return;
		this.prompts.push(text);
		this.promptImages.push(images);
		// Deliver asynchronously, like a real agent: the driver must not depend
		// on events arriving inside the prompt() call.
		await Promise.resolve();
		for (const event of this.#script(text)) this.emit(event);
	}

	async steer(text: string, images?: ImageContent[]): Promise<void> {
		this.steers.push(text);
		this.steeringImages.push(images);
	}

	async abort(): Promise<void> {
		this.aborts += 1;
	}

	async selectModel(): Promise<void> {
		this.selections += 1;
		await this.selectionGate;
	}
}

function embeddedText(text: string, label = "context.txt") {
	return {
		type: MessageAttachmentKind.EmbeddedResource,
		label,
		contentType: "text/plain",
		data: Buffer.from(text).toString("base64"),
	} as const;
}

function embeddedImage(label = "screenshot.png") {
	return {
		type: MessageAttachmentKind.EmbeddedResource,
		label,
		displayKind: "image",
		contentType: "image/png",
		data: ONE_PIXEL_PNG,
	} as const;
}

function turnShape(turn: ChatState["turns"][number]) {
	return { id: turn.id, text: turn.message.text, state: turn.state };
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
	readonly client: AhpClient;
	readonly host: AhpHost;
	readonly sessions: SessionRegistry;
	readonly backend: ScriptedBackend;
	readonly sessionChannel: string;
	readonly chatChannel: string;
	close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
	const host = new AhpHost({ serverInfo: { name: "pi-ahp", version: "test" } });
	installRootChannel(host, []);
	const backend = new ScriptedBackend((text) => (text === "long running" ? [] : say(`echo: ${text}`)));
	const sessions = new SessionRegistry({
		host,
		createBackend: () => backend,
		createSessionManager: inMemorySessionManagerFactory,
	});
	host.serve({
		sessions: {
			create: (params) => sessions.create(params),
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
	await client.request("createSession", { channel: sessionChannel });
	await client.subscribe(sessionChannel);
	await client.subscribe(chatChannel);

	return {
		client,
		host,
		sessions,
		backend,
		sessionChannel,
		chatChannel,
		async close() {
			await client.shutdown();
			await server.close();
		},
	};
}

describe("chat driver", () => {
	let fixture: Fixture;
	let backend: ScriptedBackend;

	beforeEach(async () => {
		fixture = await startFixture();
		backend = fixture.backend;
	});

	afterEach(async () => {
		await fixture.close();
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
			message: { text: "hello", origin: { kind: MessageKind.User } },
		});

		await eventually("the streamed turn to complete", () => {
			const state = fixture.host.store.get(fixture.chatChannel) as ChatState;
			return state.turns.length === 1;
		});

		assert.deepEqual(backend.prompts, ["hello"]);
		const state = fixture.host.store.get(fixture.chatChannel) as ChatState;
		assert.equal(state.turns[0]?.state, TurnState.Complete);
		assert.equal((must(state.turns[0]).responseParts[0] as { content: string }).content, "echo: hello");
	});

	it("adapts supported attachments into pi prompt text", async () => {
		const text = "inspect the path from the client";
		const expected = `${text}\n\n${fileURLToPath("file:///outside.ts")}\n\nselected context\n\nembedded context`;
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-path",
			startedAt: new Date().toISOString(),
			message: {
				text,
				origin: { kind: MessageKind.User },
				attachments: [
					{ type: MessageAttachmentKind.Resource, label: "outside.ts", uri: "file:///outside.ts" },
					{ type: MessageAttachmentKind.Simple, label: "selection", modelRepresentation: "selected context" },
					embeddedText("embedded context", "note.txt"),
					embeddedImage(),
				],
			},
		});

		await eventually("the attachment-expanded prompt to reach the backend", () => backend.prompts.includes(expected));
		assert.equal(backend.prompts.at(-1), expected);
		assert.deepEqual(backend.promptImages.at(-1), [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }]);
	});

	it("keeps the session catalog's chat summary in step", async () => {
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-summary",
			startedAt: new Date().toISOString(),
			message: { text: "update the summary", origin: { kind: MessageKind.User } },
		});
		await eventually(
			"the summary-driving turn to complete",
			() => (fixture.host.store.get(fixture.chatChannel) as ChatState).turns.length === 1,
		);

		const session = fixture.host.store.get(fixture.sessionChannel) as SessionState;
		const chat = fixture.host.store.get(fixture.chatChannel) as ChatState;
		assert.equal(session.chats[0]?.status, chat.status);
		assert.equal(session.chats[0]?.modifiedAt, chat.modifiedAt);
	});

	it("forwards steering text and images to the active backend", async () => {
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-steering",
			startedAt: new Date().toISOString(),
			message: { text: "long running", origin: { kind: MessageKind.User } },
		});
		await eventually("the steerable prompt to reach the backend", () => backend.prompts.length === 1);

		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Steering,
			id: "steer-1",
			message: {
				text: "focus on tests",
				origin: { kind: MessageKind.User },
				attachments: [
					{ type: MessageAttachmentKind.Simple, label: "context", modelRepresentation: "steering context" },
					embeddedImage("steering.png"),
				],
			},
		});

		await eventually("the steering message to reach the backend", () => backend.steers.length === 1);
		assert.deepEqual(backend.steers, ["focus on tests\n\nsteering context"]);
		assert.deepEqual(backend.steeringImages[0], [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }]);
	});

	it("consumes a queued message as its own turn once the chat goes idle", async () => {
		// Queued messages never reach pi: the protocol's own state is the queue,
		// and the host starts a fresh turn for the head entry when idle.
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Queued,
			id: "q-1",
			message: {
				text: "then do this",
				origin: { kind: MessageKind.User },
				attachments: [embeddedText("queued context", "queued.txt"), embeddedImage("queued.png")],
			},
		});

		await eventually("the queued prompt to reach the backend", () => backend.prompts.length === 1);

		const state = fixture.host.store.get(fixture.chatChannel) as ChatState;
		assert.equal(backend.prompts.at(-1), "then do this\n\nqueued context");
		assert.deepEqual(backend.promptImages.at(-1), [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }]);
		// The reducer removes the entry atomically with creating the turn, so a
		// client can never see it both queued and running.
		assert.equal(state.queuedMessages, undefined);
		assert.equal(state.turns.at(-1)?.state, TurnState.Complete);
	});

	it("holds a queued message until the active turn settles", async () => {
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-blocking",
			startedAt: new Date().toISOString(),
			message: { text: "long running", origin: { kind: MessageKind.User } },
		});
		await eventually("the active prompt to reach the backend", () => backend.prompts.length === 1);

		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Queued,
			id: "q-after-active",
			message: { text: "run after", origin: { kind: MessageKind.User } },
		});
		await fixture.client.ping();

		const waiting = fixture.host.store.get(fixture.chatChannel) as ChatState;
		assert.equal(backend.prompts.length, 1, "queued message prompted before the active turn settled");
		assert.equal(waiting.activeTurn?.id, "t-blocking");
		assert.equal(waiting.queuedMessages?.[0]?.id, "q-after-active");

		backend.emit({ type: "agent_settled" } as AgentSessionEvent);
		await eventually("the queued message to start after settlement", () => backend.prompts.length === 2);

		const completed = fixture.host.store.get(fixture.chatChannel) as ChatState;
		assert.equal(backend.prompts.at(-1), "run after");
		assert.equal(completed.queuedMessages, undefined);
		assert.equal(completed.turns.at(-1)?.message.text, "run after");
		assert.equal(completed.turns.at(-1)?.state, TurnState.Complete);
	});

	it("does not start a prompt cancelled during model selection", async () => {
		let releaseSelection!: () => void;
		backend.selectionGate = new Promise<void>((resolve) => {
			releaseSelection = resolve;
		});
		try {
			fixture.client.dispatch(fixture.chatChannel, {
				type: ActionType.ChatTurnStarted,
				turnId: "t-select-cancel",
				startedAt: new Date().toISOString(),
				message: {
					text: "do not run",
					origin: { kind: MessageKind.User },
					model: { id: "pi/test-model" },
				},
			});
			await eventually("model selection to start", () => backend.selections === 1);
			fixture.client.dispatch(fixture.chatChannel, {
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Queued,
				id: "after-select-cancel",
				message: { text: "run after selection cancellation", origin: { kind: MessageKind.User } },
			});
			fixture.client.dispatch(fixture.chatChannel, {
				type: ActionType.ChatTurnCancelled,
				turnId: "t-select-cancel",
				duration: 0,
			});
			await eventually("preflight cancellation to reach the backend", () => backend.aborts === 1);

			releaseSelection();
			await eventually(
				"queued work to complete after cancelled preflight settles",
				() => (fixture.host.store.get(fixture.chatChannel) as ChatState).turns.length === 2,
			);
			assert.deepEqual(backend.prompts, ["run after selection cancellation"]);
			const completed = fixture.host.store.get(fixture.chatChannel) as ChatState;
			assert.deepEqual(completed.turns.map(turnShape), [
				{ id: "t-select-cancel", text: "do not run", state: TurnState.Cancelled },
				{
					id: "turn-after-select-cancel",
					text: "run after selection cancellation",
					state: TurnState.Complete,
				},
			]);

			const before = completed.turns.map((turn) => turn.id);
			fixture.client.dispatch(fixture.chatChannel, {
				type: ActionType.ChatTruncated,
				turnId: "t-select-cancel",
			});
			await fixture.client.ping();
			assert.deepEqual(
				(fixture.host.store.get(fixture.chatChannel) as ChatState).turns.map((turn) => turn.id),
				before,
				"a turn cancelled before persistence must not acquire a truncation anchor",
			);
		} finally {
			releaseSelection();
		}
	});

	it("does not run a prompt cancelled during backend preflight", async () => {
		let releasePreflight!: () => void;
		backend.promptGate = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		try {
			fixture.client.dispatch(fixture.chatChannel, {
				type: ActionType.ChatTurnStarted,
				turnId: "t-preflight-cancel",
				startedAt: new Date().toISOString(),
				message: {
					text: "do not run",
					origin: { kind: MessageKind.User },
					attachments: [embeddedImage()],
				},
			});
			await eventually("backend preflight to start", () => backend.promptCalls === 1);
			fixture.client.dispatch(fixture.chatChannel, {
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Queued,
				id: "after-preflight-cancel",
				message: { text: "run after image preflight", origin: { kind: MessageKind.User } },
			});
			fixture.client.dispatch(fixture.chatChannel, {
				type: ActionType.ChatTurnCancelled,
				turnId: "t-preflight-cancel",
				duration: 0,
			});
			await eventually("preflight cancellation to reach the backend", () => backend.aborts === 1);

			releasePreflight();
			await eventually(
				"queued work to complete after backend preflight settles",
				() => (fixture.host.store.get(fixture.chatChannel) as ChatState).turns.length === 2,
			);
			assert.deepEqual(backend.prompts, ["run after image preflight"]);
			assert.deepEqual((fixture.host.store.get(fixture.chatChannel) as ChatState).turns.map(turnShape), [
				{ id: "t-preflight-cancel", text: "do not run", state: TurnState.Cancelled },
				{
					id: "turn-after-preflight-cancel",
					text: "run after image preflight",
					state: TurnState.Complete,
				},
			]);
		} finally {
			releasePreflight();
		}
	});

	it("anchors a cancelled turn before resuming queued work", async () => {
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-cancel",
			startedAt: new Date().toISOString(),
			message: { text: "long running", origin: { kind: MessageKind.User } },
		});
		await eventually("the cancellable prompt to reach the backend", () => backend.prompts.length === 1);
		assert.equal((fixture.host.store.get(fixture.chatChannel) as ChatState).activeTurn?.id, "t-cancel");

		const live = must(fixture.sessions.get(fixture.sessionChannel));
		// AgentSession notifies listeners, then records the same user message.
		const userMessage = { role: "user", content: "long running", timestamp: 0 } as const;
		backend.emit({ type: "message_start", message: userMessage } as AgentSessionEvent);
		backend.emit({ type: "message_end", message: userMessage } as AgentSessionEvent);
		live.sessionManager.appendMessage(userMessage);
		live.sessionManager.appendMessage(fauxAssistantMessage([], { stopReason: "aborted", timestamp: 0 }));

		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Queued,
			id: "after-cancel",
			message: { text: "run after cancel", origin: { kind: MessageKind.User } },
		});
		fixture.client.dispatch(fixture.chatChannel, {
			type: ActionType.ChatTurnCancelled,
			turnId: "t-cancel",
			duration: 0,
		});

		await eventually("cancellation to reach the backend", () => backend.aborts === 1);
		await eventually(
			"queued work to complete after backend cancellation",
			() => (fixture.host.store.get(fixture.chatChannel) as ChatState).turns.length === 2,
		);
		const chat = fixture.host.store.get(fixture.chatChannel) as ChatState;
		const session = fixture.host.store.get(fixture.sessionChannel) as SessionState;
		assert.equal(chat.turns.find((turn) => turn.id === "t-cancel")?.state, TurnState.Cancelled);
		assert.equal(chat.turns.at(-1)?.message.text, "run after cancel");
		assert.equal(chat.turns.at(-1)?.state, TurnState.Complete);
		assert.equal(session.chats[0]?.status, chat.status);

		fixture.client.dispatch(fixture.chatChannel, { type: ActionType.ChatTruncated, turnId: "t-cancel" });
		await fixture.client.ping();
		assert.deepEqual(
			(fixture.host.store.get(fixture.chatChannel) as ChatState).turns.map((turn) => turn.id),
			["t-cancel"],
			"a recorded cancelled turn must remain a valid truncation target",
		);
	});
});

describe("chat driver — backend failure", () => {
	it("marks the session failed when the backend cannot start", async () => {
		const host = new AhpHost();
		installRootChannel(host, []);
		const sessions = new SessionRegistry({
			host,
			createSessionManager: inMemorySessionManagerFactory,
			createBackend: () => {
				throw new Error("no credentials");
			},
		});

		const uri = sessionUri(randomUUID());
		sessions.create({ channel: uri });
		await eventually(
			"backend startup failure to reach session state",
			() => (host.store.get(uri) as SessionState).lifecycle !== SessionLifecycle.Creating,
		);

		const state = host.store.get(uri) as SessionState;
		assert.equal(state.lifecycle, SessionLifecycle.Failed);
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
		const sessions = new SessionRegistry({
			host,
			createBackend: () => backend,
			createSessionManager: inMemorySessionManagerFactory,
		});
		host.serve({
			sessions: {
				create: (params) => sessions.create(params),
				dispose: (channel) => sessions.dispose(channel),
			},
		});

		const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
		const client = new Client(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
		await client.initialize({ clientId: "failing-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

		try {
			const id = randomUUID();
			const session = sessionUri(id);
			const chat = chatUri(id);
			await client.request("createSession", { channel: session });
			await client.subscribe(chat);

			// Dispatched through the wire so the reducer creates the active turn
			// before the side effect runs — the same ordering production relies on.
			client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "t1",
				startedAt: new Date().toISOString(),
				message: { text: "hi", origin: { kind: MessageKind.User } },
			});

			// Nothing will ever emit `agent_settled`, so without explicit handling
			// the turn would stay active and the session stuck at InProgress.
			await eventually(
				"the rejected prompt to close its turn",
				() => (host.store.get(chat) as ChatState).turns.length === 1,
			);
			const state = host.store.get(chat) as ChatState;
			assert.equal(state.activeTurn, undefined);
			assert.equal(state.turns[0]?.state, TurnState.Error);
			assert.match(turnError(state.turns[0])?.message ?? "", /model unavailable/);
			assert.equal((host.store.get(session) as SessionState).chats[0]?.status, state.status);
			assert.equal(sessions.catalogueOverrides()[0]?.summary.status, state.status);
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

		const sessions = new SessionRegistry({
			host,
			createBackend: () => backend,
			createSessionManager: inMemorySessionManagerFactory,
		});
		host.serve({
			sessions: {
				create: (params) => sessions.create(params),
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
			await client.request("createSession", { channel: sessionUri(id) });
			await client.subscribe(chat);

			client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "t1",
				startedAt: new Date().toISOString(),
				message: { text: "go", origin: { kind: MessageKind.User } },
			});
			client.dispatch(chat, {
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Steering,
				id: "steer-1",
				message: { text: "focus on tests", origin: { kind: MessageKind.User } },
			});

			await eventually(
				"the steering message to enter protocol state",
				() => (host.store.get(chat) as ChatState).steeringMessage !== undefined,
			);

			// …and consumes it by shrinking the queue right before injecting.
			emit({ type: "queue_update", steering: [], followUp: [] });

			await eventually(
				"the consumed steering message to leave protocol state",
				() => (host.store.get(chat) as ChatState).steeringMessage === undefined,
			);

			// The text itself is not recorded here — pi delivers it as an
			// ordinary user message, and the mapper turns that into its own
			// turn. Only the pending slot is cleared by this path.
		} finally {
			await client.shutdown();
			await server.close();
		}
	});
});
