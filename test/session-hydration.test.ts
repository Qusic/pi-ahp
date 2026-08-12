import { must } from "./harness.ts";
/**
 * Opening a session that only exists on disk.
 *
 * A client lists sessions and then subscribes to one. Everything this host
 * created is in memory, but the catalogue is backed by pi's session files —
 * most of which no live host has ever touched. Without lazy loading, every
 * session the catalogue advertises answers `NotFound` on subscribe.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	MessageKind,
	ResponsePartKind,
	SessionLifecycle,
	type SessionState,
	SessionStatus,
	SUPPORTED_PROTOCOL_VERSIONS,
	ToolCallStatus,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { chatUri, permissiveSessionId, sessionUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { SessionHydrator } from "../src/pi/session-hydrator.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { checkSchema } from "./support/schema.ts";

/** Writes a pi session file containing one full turn with a tool call. */
function writeSession(root: string, id: string, cwd: string): string {
	const directory = join(root, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(directory, { recursive: true });

	const at = "2026-01-01T00:00:00.000Z";
	let parentId: string | null = null;
	const lines: string[] = [JSON.stringify({ type: "session", id, parentId: null, timestamp: at, version: 3, cwd })];
	const push = (entry: Record<string, unknown>): string => {
		const entryId = randomUUID();
		lines.push(JSON.stringify({ ...entry, id: entryId, parentId, timestamp: at }));
		parentId = entryId;
		return entryId;
	};

	push({ type: "message", message: { role: "user", content: "Read note.txt", timestamp: 0 } });
	push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I should read it." },
				{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "note.txt" } },
			],
			usage: { input: 10, output: 5, cacheRead: 0 },
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
		message: { role: "assistant", content: [{ type: "text", text: "It says ALPHA." }], timestamp: 0 },
	});
	push({ type: "message", message: { role: "user", content: "Thanks", timestamp: 0 } });

	const path = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

interface Fixture {
	host: AhpHost;
	client: AhpClient;
	/** Opens a second client whose handshake claims to be VS Code. */
	asVSCode: () => Promise<AhpClient>;
	server: RunningServer;
	sessionId: string;
	root: string;
	deletedFiles: string[];
	backend: RecordingBackend;
	close(): Promise<void>;
}

/** Records what a resumed session actually asks the agent to do. */
class RecordingBackend implements PiBackend {
	readonly prompts: string[] = [];
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
}

async function startFixture(): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-hydrate-"));
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-hydrate-cwd-"));
	const sessionId = randomUUID();
	writeSession(root, sessionId, workspace);

	const host = new AhpHost();
	installRootChannel(host, []);
	const catalogue = new PiSessionCatalogue(root);
	host.serve({ catalogue });
	host.serve({
		hydrator: new SessionHydrator({
			host,
			catalogue,
			// Nothing is live in this fixture; every session comes from disk.
			isLive: (session) => sessions.has(session),
			// `createPiHost` wires this the same way; without it a resumed
			// session has no agent and silently swallows messages.
			adopt: (session) => void sessions.adopt(session),
			fallbackSelection: () => ({ id: "fallback-model", config: { thinkingLevel: "medium" } }),
		}),
	});

	const deletedFiles: string[] = [];
	const backend = new RecordingBackend();
	const sessions = new SessionRegistry({
		host,
		defaultWorkingDirectory: workspace,
		createBackend: () => backend,
		deleteFile: (path) => {
			deletedFiles.push(path);
			rmSync(path, { force: true });
		},
		findSessionFile: (id) => catalogue.findSessionFile(id),
	});
	host.serve({
		sessions: {
			create: (params) => sessions.create(params as never),
			dispose: (channel) => sessions.dispose(channel),
		},
	});

	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	await client.initialize({ clientId: "hydrate-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

	const asVSCode = async () => {
		const other = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		other.connect();
		// Raw, because the client facade does not expose `clientInfo`, which is
		// what the host reads to decide whether the workarounds apply.
		await other.request("initialize", {
			clientId: "vscode-client",
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			clientInfo: { name: "vscode-editor-window", title: "VS Code" },
		} as never);
		return other;
	};

	return {
		host,
		client,
		asVSCode,
		server,
		sessionId,
		root,
		deletedFiles,
		backend,
		async close() {
			await client.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true });
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}

describe("opening a session from the catalogue", () => {
	let fixture: Fixture;

	before(async () => {
		fixture = await startFixture();
	});

	after(async () => {
		await fixture.close();
	});

	it("subscribes to a session no live host created", async () => {
		// The regression this exists for: `listSessions` advertised it, so
		// `subscribe` answering NotFound makes the catalogue useless.
		const { result } = await fixture.client.subscribe(sessionUri(fixture.sessionId));
		const state = result.snapshot?.state as SessionState;

		assert.equal(state.lifecycle, SessionLifecycle.Ready);
		assert.equal(state.chats.length, 1);
		assert.equal(state.defaultChat, chatUri(fixture.sessionId));
		assert.equal(checkSchema("state", "SessionState", state), undefined);
	});

	it("answers VS Code at the URIs it computes for itself", async () => {
		const client = await fixture.asVSCode();

		// Both built the way VS Code builds them; see
		// src/core/client-workarounds.ts.
		const providerSession = `pi:/${fixture.sessionId}`;
		const derived = `ahp-chat://default/${Buffer.from(providerSession).toString("base64url")}`;

		const session = await client.subscribe(providerSession);
		const sessionState = session.result.snapshot?.state as SessionState;
		assert.equal(session.result.snapshot?.resource, providerSession, "answered under the scheme this client uses");
		assert.equal(sessionState.defaultChat, derived, "the session must name its chat the way this client will");

		const { result } = await client.subscribe(derived);
		const state = result.snapshot?.state as ChatState;
		assert.equal(result.snapshot?.resource, derived, "the snapshot answers on the URI the client used");
		assert.ok(state.turns.length > 0, "the transcript must come back, not an empty chat");
		assert.equal(checkSchema("state", "ChatState", state), undefined);
	});

	it("rebuilds the transcript onto the chat channel", async () => {
		const { result } = await fixture.client.subscribe(chatUri(fixture.sessionId));
		const chat = must(result.snapshot).state as ChatState;

		// Turn boundaries come from user messages, as in the live mapper.
		assert.equal(chat.turns.length, 2);
		assert.equal(chat.turns[0]?.message.text, "Read note.txt");
		assert.equal(chat.turns[0]?.state, TurnState.Complete);
		assert.equal(checkSchema("state", "ChatState", chat), undefined);
	});

	it("pairs each tool call with the result that followed it", async () => {
		const { result } = await fixture.client.subscribe(chatUri(fixture.sessionId));
		const parts = must((must(result.snapshot).state as ChatState).turns[0]).responseParts;

		assert.deepEqual(
			parts.map((part) => part.kind),
			[ResponsePartKind.Reasoning, ResponsePartKind.ToolCall, ResponsePartKind.Markdown],
		);
		const toolCall = (
			parts[1] as {
				toolCall: { status: string; toolName?: string; content?: { type: string; text?: string }[] };
			}
		).toolCall;
		// A stored transcript has no partial state: the call is finished, with
		// the output that came back. Pairing is the point of this test, so the
		// result has to be the one recorded against *this* call — a rebuild that
		// attaches some other tool's output would still leave content here.
		assert.equal(toolCall.status, ToolCallStatus.Completed);
		assert.equal(toolCall.toolName, "read");
		assert.deepEqual(toolCall.content, [{ type: "text", text: "ALPHA" }]);
	});

	it("still answers NotFound for a session that really does not exist", async () => {
		const error = await fixture.client.subscribe(sessionUri(randomUUID())).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32008);
	});

	it("hydrates from either half of the pair", async () => {
		// A client may hold a chat URI from a previous connection and subscribe
		// to it directly, without touching the session first.
		const fresh = await startFixture();
		try {
			const { result } = await fresh.client.subscribe(chatUri(fresh.sessionId));
			assert.ok(result.snapshot);
			assert.ok(fresh.host.store.has(sessionUri(fresh.sessionId)), "the session must load alongside its chat");
		} finally {
			await fresh.close();
		}
	});
});

describe("read and unread", () => {
	let fixture: Fixture;

	before(async () => {
		fixture = await startFixture();
	});

	after(async () => {
		await fixture.close();
	});

	it("reports every catalogue entry as read", async () => {
		// Read/unread is deliberately not modelled. pi has no such concept, so
		// tracking it would mean this host inventing durable state of its own —
		// and without archiving to pair with it, a list where everything is
		// permanently unread is worse than one that stays quiet.
		const list = await fixture.client.request("listSessions", { channel: "ahp-root://" } as never);
		assert.ok((must(list.items[0]).status & SessionStatus.IsRead) !== 0);
	});

	it("reports a hydrated session as read", async () => {
		const { result } = await fixture.client.subscribe(sessionUri(fixture.sessionId));
		const state = result.snapshot?.state as SessionState;
		assert.ok((state.status & SessionStatus.IsRead) !== 0);
	});

	it("still lets a starting turn mark a chat unread", async () => {
		// This falls out of the reducer rather than being host behaviour, and it
		// is the one part of read/unread worth keeping.
		const chat = chatUri(fixture.sessionId);
		await fixture.client.subscribe(chat);
		const before = (fixture.host.store.get(chat) as ChatState).status;
		assert.ok((before & SessionStatus.IsRead) !== 0);

		fixture.client.dispatch(chat, {
			type: "chat/turnStarted",
			turnId: "t-unread",
			startedAt: new Date().toISOString(),
			message: { text: "hi", origin: { kind: "user" } },
		} as never);
		await new Promise((resolve) => {
			const handle = setTimeout(resolve, 100);
			handle.unref?.();
		});

		assert.equal((fixture.host.store.get(chat) as ChatState).status & SessionStatus.IsRead, 0);
	});
});

describe("non-standard session URIs", () => {
	it("accepts a provider-scheme URI on createSession", () => {
		// The spec says `ahp-session:/<uuid>`, but the reference host lets its
		// provider mint the URI and only logs a mismatch with what the client
		// asked for. Clients written against it still send `<provider>:/<uuid>`.
		assert.equal(
			permissiveSessionId("pi:/9991C40A-74CC-4991-85CC-F37CD2BFF065"),
			"9991C40A-74CC-4991-85CC-F37CD2BFF065",
		);
		assert.equal(permissiveSessionId("copilot:/test-session"), "test-session");
	});

	it("still reads the canonical form", () => {
		assert.equal(permissiveSessionId("ahp-session:/abc"), "abc");
	});

	it("refuses URIs that name some other channel type", () => {
		// Guessing wrong here would build a channel with the wrong reducer.
		for (const uri of ["ahp-chat:/c1", "ahp-root://", "ahp-terminal:/t1", "file:///etc/passwd"]) {
			assert.equal(permissiveSessionId(uri), undefined, uri);
		}
	});

	it("creates and disposes a session at a provider-scheme URI", async () => {
		const fixture = await startFixture();
		try {
			const uri = `pi:/${randomUUID().toUpperCase()}`;
			await fixture.client.request("createSession", { channel: uri } as never);

			const { result } = await fixture.client.subscribe(uri);
			assert.ok(result.snapshot, "the session must exist at the URI the client chose");
			assert.equal(result.snapshot.resource, uri);

			await fixture.client.request("disposeSession", { channel: uri } as never);
			assert.equal(fixture.host.store.has(uri), false);
		} finally {
			await fixture.close();
		}
	});
});

describe("disposing a session that was never live here", () => {
	it("removes it from the catalogue and deletes the file", async () => {
		// Almost every session a client can see was written by pi and has never
		// run in this host; refusing to dispose those would make the delete
		// affordance fail on nearly everything the list shows.
		const fixture = await startFixture();
		try {
			const uri = sessionUri(fixture.sessionId);
			await fixture.client.subscribe(uri);
			await fixture.client.request("disposeSession", { channel: uri } as never);

			assert.equal(fixture.host.store.has(uri), false);
			assert.deepEqual(fixture.deletedFiles.length, 1);

			const list = await fixture.client.request("listSessions", { channel: "ahp-root://" } as never);
			assert.equal(list.items.length, 0, "a disposed session must not come back on the next listing");
		} finally {
			await fixture.close();
		}
	});
});

describe("resuming a hydrated session", () => {
	it("starts an agent on the first turn and prompts it", async () => {
		// The failure this covers is silent: the turn reduces into state and
		// echoes back, so the client shows the message as sent, but with no
		// agent attached no reply ever arrives and nothing is logged.
		const fixture = await startFixture();
		try {
			const chat = chatUri(fixture.sessionId);
			await fixture.client.subscribe(chat);
			assert.deepEqual(fixture.backend.prompts, [], "browsing history must not start an agent");

			fixture.client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "t-resume",
				startedAt: new Date().toISOString(),
				message: { text: "continue please", origin: { kind: MessageKind.User } },
			} as never);

			await waitFor(() => fixture.backend.prompts.length === 1);
			assert.deepEqual(fixture.backend.prompts, ["continue please"]);

			// The turn must also close, rather than sitting active forever.
			await waitFor(() => {
				const state = fixture.host.store.get(chat) as ChatState;
				return state.activeTurn === undefined;
			});
		} finally {
			await fixture.close();
		}
	});

	it("resumes onto the existing transcript rather than a fresh one", async () => {
		const fixture = await startFixture();
		try {
			const chat = chatUri(fixture.sessionId);
			await fixture.client.subscribe(chat);
			const before = (fixture.host.store.get(chat) as ChatState).turns.length;

			fixture.client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "t-append",
				startedAt: new Date().toISOString(),
				message: { text: "and again", origin: { kind: MessageKind.User } },
			} as never);
			await waitFor(() => fixture.backend.prompts.length === 1);
			await waitFor(() => (fixture.host.store.get(chat) as ChatState).turns.length === before + 1);

			// History from disk stays put; the new turn lands after it.
			const turns = (fixture.host.store.get(chat) as ChatState).turns;
			assert.equal(turns[0]?.message.text, "Read note.txt");
			assert.equal(turns.at(-1)?.message.text, "and again");
		} finally {
			await fixture.close();
		}
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("condition never became true");
		}
		await new Promise((resolve) => {
			const handle = setTimeout(resolve, 10);
			handle.unref?.();
		});
	}
}

describe("model selection on a hydrated session", () => {
	it("seeds the picker from the model the session was using", async () => {
		// The agent starts only on the first new turn, so nothing else can
		// answer "which model is selected" — an empty picker blocks sending.
		const fixture = await startFixture();
		try {
			const { result } = await fixture.client.subscribe(chatUri(fixture.sessionId));
			const draft = (must(result.snapshot).state as ChatState).draft;
			assert.ok(draft?.model, "a hydrated chat must publish a model selection");
		} finally {
			await fixture.close();
		}
	});
});

describe("renaming a session loaded from disk", () => {
	it("persists the name into the session file", async () => {
		// A hydrated session has an assistant message by construction, so pi
		// writes eagerly — this is the path where a rename really has to land
		// on disk to survive a restart.
		const fixture = await startFixture();
		try {
			const uri = sessionUri(fixture.sessionId);
			await fixture.client.subscribe(uri);
			fixture.client.dispatch(uri, { type: "session/titleChanged", title: "Archived work" } as never);
			await waitFor(() => {
				const file = fixture.host.store.get(uri) as { title?: string };
				return file.title === "Archived work";
			});
			await new Promise((resolve) => {
				const handle = setTimeout(resolve, 100);
				handle.unref?.();
			});

			const file = await new PiSessionCatalogue(fixture.root).findSessionFile(fixture.sessionId);
			assert.ok(file);
			assert.equal(SessionManager.open(file).getSessionName(), "Archived work");
		} finally {
			await fixture.close();
		}
	});
});
