/**
 * Reconnection: replay from the buffer, snapshot fallback, and unresumable
 * subscriptions.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/lifecycle
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	type ReconnectReplayResult,
	ReconnectResultType,
	type ReconnectSnapshotResult,
	ResponsePartKind,
	SUPPORTED_PROTOCOL_VERSIONS,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { initialSessionState } from "../src/channels/session.ts";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import { type Harness, must, startHarness } from "./harness.ts";

const CLIENT_ID = "reconnecting-client";

function bumpActiveSessions(harness: Harness, count: number): void {
	harness.host.dispatchServerAction(ROOT_CHANNEL, {
		type: ActionType.RootActiveSessionsChanged,
		activeSessions: count,
	});
}

function writeDurableSession(root: string, id: string, cwd: string): void {
	const manager = SessionManager.create(cwd, join(root, "fixture"), { id });
	manager.appendMessage({ role: "user", content: "before restart", timestamp: 0 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "persisted reply" }],
		timestamp: 0,
	} as never);
}

class RestartBackend implements PiBackend {
	readonly prompts: string[] = [];
	readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		for (const listener of this.#listeners) {
			listener({ type: "agent_start" } as AgentSessionEvent);
			listener({ type: "agent_settled" } as AgentSessionEvent);
		}
	}

	async steer(): Promise<void> {}
	async abort(): Promise<void> {}
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("condition never became true");
		}
		await new Promise((resolve) => {
			const handle = setTimeout(resolve, 5);
			handle.unref?.();
		});
	}
}

describe("reconnect", () => {
	let harness: Harness;

	before(async () => {
		// A tiny buffer makes the eviction path cheap to exercise.
		harness = await startHarness({ replayBufferCapacity: 4 });
	});

	after(async () => {
		await harness.dispose();
	});

	it("replays only the actions the client missed", async () => {
		const first = await harness.connect();
		const init = await first.initialize({
			clientId: CLIENT_ID,
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [ROOT_CHANNEL],
		});

		bumpActiveSessions(harness, 1);
		bumpActiveSessions(harness, 2);
		await first.shutdown();

		const resumed = await harness.connect();
		const result = (await resumed.reconnect({
			clientId: CLIENT_ID,
			lastSeenServerSeq: init.serverSeq,
			subscriptions: [ROOT_CHANNEL],
		})) as ReconnectReplayResult;

		assert.equal(result.type, ReconnectResultType.Replay);
		assert.equal(result.actions.length, 2);
		assert.deepEqual(
			result.actions.map((envelope) => envelope.serverSeq),
			[init.serverSeq + 1, init.serverSeq + 2],
		);
		assert.deepEqual(result.missing, []);
	});

	it("falls back to snapshots when the gap predates the replay buffer", async () => {
		const client = await harness.connect();
		await client.initialize({
			clientId: `${CLIENT_ID}-gap`,
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [ROOT_CHANNEL],
		});

		const staleSeq = harness.host.serverSeq;
		// Overflow the 4-entry buffer so `staleSeq + 1` is evicted.
		for (let i = 0; i < 6; i++) {
			bumpActiveSessions(harness, i);
		}

		const result = (await client.reconnect({
			clientId: `${CLIENT_ID}-gap`,
			lastSeenServerSeq: staleSeq,
			subscriptions: [ROOT_CHANNEL],
		})) as ReconnectSnapshotResult;

		assert.equal(result.type, ReconnectResultType.Snapshot);
		assert.equal(result.snapshots.length, 1);
		assert.equal(must(result.snapshots[0]).resource, ROOT_CHANNEL);
		assert.equal(must(result.snapshots[0]).fromSeq, harness.host.serverSeq);
	});

	it("reports subscriptions it cannot resume as missing", async () => {
		const client = await harness.connect();
		const init = await client.initialize({
			clientId: `${CLIENT_ID}-missing`,
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [ROOT_CHANNEL],
		});

		const disposed = sessionUri("already-gone");
		const result = (await client.reconnect({
			clientId: `${CLIENT_ID}-missing`,
			lastSeenServerSeq: init.serverSeq,
			subscriptions: [ROOT_CHANNEL, disposed],
		})) as ReconnectReplayResult;

		assert.equal(result.type, ReconnectResultType.Replay);
		assert.deepEqual(result.missing, [disposed]);
	});

	it("returns an empty replay for a client that is already current", async () => {
		const client = await harness.connect();
		await client.initialize({
			clientId: `${CLIENT_ID}-current`,
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [ROOT_CHANNEL],
		});

		const result = (await client.reconnect({
			clientId: `${CLIENT_ID}-current`,
			lastSeenServerSeq: harness.host.serverSeq,
			subscriptions: [ROOT_CHANNEL],
		})) as ReconnectReplayResult;

		assert.equal(result.type, ReconnectResultType.Replay);
		assert.deepEqual(result.actions, []);
	});

	it("replaces a half-open connection that reuses a clientId", async () => {
		const clientId = `${CLIENT_ID}-duplicate`;
		const subscribersBefore = harness.host.subscriberCount(ROOT_CHANNEL);
		const first = await harness.connect();
		await first.initialize({ clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		await first.subscribe(ROOT_CHANNEL);
		assert.equal(harness.host.subscriberCount(ROOT_CHANNEL), subscribersBefore + 1);

		const replacement = await harness.connect();
		await replacement.initialize({ clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		await replacement.subscribe(ROOT_CHANNEL);

		assert.equal(harness.host.subscriberCount(ROOT_CHANNEL), subscribersBefore + 1);
	});

	it("retains clientInfo when a replacement initialize omits it", async () => {
		const clientId = `${CLIENT_ID}-reinitialize`;
		const id = "vscode-reinitialize";
		const uri = sessionUri(id);
		const clientUri = `pi:/${id}`;
		harness.host.store.create(uri, initialSessionState("pi", "Reinitialize", "/tmp"), "session");

		const first = await harness.connect();
		await first.request("initialize", {
			clientId,
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			clientInfo: { name: "vscode-editor-window" },
		} as never);
		await first.shutdown();

		const replacement = await harness.connect();
		await replacement.initialize({ clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		assert.equal((await replacement.subscribe(clientUri)).result.snapshot?.resource, clientUri);
	});

	it("retains VS Code's URI dialect across connections", async () => {
		const clientId = `${CLIENT_ID}-vscode`;
		const id = "vscode-reconnect";
		const uri = sessionUri(id);
		const clientUri = `pi:/${id}`;
		harness.host.store.create(uri, initialSessionState("pi", "Reconnect", "/tmp"), "session");

		const first = await harness.connect();
		await first.request("initialize", {
			clientId,
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			clientInfo: { name: "vscode-editor-window" },
		} as never);
		assert.equal((await first.subscribe(clientUri)).result.snapshot?.resource, clientUri);
		const staleSeq = harness.host.serverSeq;
		await first.shutdown();

		for (let i = 0; i < 6; i++) bumpActiveSessions(harness, i);

		const resumed = await harness.connect();
		const result = (await resumed.reconnect({
			clientId,
			lastSeenServerSeq: staleSeq,
			subscriptions: [clientUri],
		})) as ReconnectSnapshotResult;

		assert.equal(result.type, ReconnectResultType.Snapshot);
		assert.deepEqual(
			result.snapshots.map((snapshot) => snapshot.resource),
			[clientUri],
		);
	});
});

describe("reconnect after host restart", () => {
	it("hydrates a VS Code session, returns snapshots, and accepts a new turn", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-restart-sessions-"));
		const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-restart-cwd-"));
		const id = randomUUID();
		writeDurableSession(root, id, workspace);
		const backend = new RestartBackend();
		const harness = await startHarness({
			sessions: true,
			catalogueRoot: root,
			workingDirectory: workspace,
			createBackend: () => backend,
		});

		try {
			const clientSession = `pi:/${id}`;
			const clientChat = `ahp-chat://default/${Buffer.from(clientSession).toString("base64url")}`;
			const client = await harness.connect();
			const result = (await client.reconnect({
				clientId: "vscode-from-previous-host",
				lastSeenServerSeq: 42,
				subscriptions: [clientSession, clientChat],
			})) as ReconnectSnapshotResult;

			assert.equal(result.type, ReconnectResultType.Snapshot);
			assert.deepEqual(
				result.snapshots.map((snapshot) => snapshot.resource).sort(),
				[clientSession, clientChat].sort(),
			);
			const chatSnapshot = result.snapshots.find((snapshot) => snapshot.resource === clientChat);
			assert.ok(chatSnapshot);
			const restoredTurn = (chatSnapshot.state as ChatState).turns[0];
			assert.equal(restoredTurn?.message.text, "before restart");
			assert.equal(
				restoredTurn?.responseParts.find((part) => part.kind === ResponsePartKind.Markdown)?.content,
				"persisted reply",
			);
			assert.equal(restoredTurn?.state, TurnState.Complete);
			assert.equal(harness.host.store.has(sessionUri(id)), true);
			assert.equal(harness.host.store.has(chatUri(id)), true);

			client.dispatch(clientChat, {
				type: ActionType.ChatTurnStarted,
				turnId: "after-restart",
				startedAt: new Date().toISOString(),
				message: { text: "continue after restart", origin: { kind: "user" } },
			} as never);
			await waitFor(() => backend.prompts.length === 1);
			assert.deepEqual(backend.prompts, ["continue after restart"]);
			const state = harness.host.store.get(chatUri(id)) as ChatState;
			assert.equal(state.activeTurn, undefined);
			assert.equal(state.turns.at(-1)?.message.text, "continue after restart");
			assert.equal(state.turns.at(-1)?.state, TurnState.Complete);
		} finally {
			await harness.dispose();
			rmSync(root, { recursive: true, force: true });
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
