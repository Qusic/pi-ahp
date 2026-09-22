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
	JsonRpcErrorCodes,
	MessageKind,
	type ReconnectReplayResult,
	ReconnectResultType,
	type ReconnectSnapshotResult,
	ResponsePartKind,
	type SessionState,
	SUPPORTED_PROTOCOL_VERSIONS,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { initialSessionState } from "../src/channels/session.ts";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import { type Harness, startHarness } from "./harness.ts";
import { expectRpcError, must } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";

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

describe("reconnect", () => {
	let harness: Harness;

	before(async () => {
		// A tiny buffer makes the eviction path cheap to exercise.
		harness = await startHarness({ replayBufferCapacity: 4 });
	});

	after(async () => {
		await harness.dispose();
	});

	it("keeps non-VS Code and explicitly misrouted reconnects strict", async () => {
		const client = await harness.connect();
		for (const [context, params] of [
			[
				"non-VS Code reconnect without a channel",
				{
					clientId: `${CLIENT_ID}-missing-channel`,
					lastSeenServerSeq: 0,
					subscriptions: [ROOT_CHANNEL],
				},
			],
			[
				"VS Code reconnect with the wrong channel",
				{
					channel: sessionUri("wrong-channel"),
					clientId: `${CLIENT_ID}-wrong-channel`,
					lastSeenServerSeq: 0,
					subscriptions: [ROOT_CHANNEL],
					_meta: { "vscode.telemetryLevel": "off" },
				},
			],
		] as const) {
			const error = await expectRpcError(
				client.request("reconnect", params as never),
				JsonRpcErrorCodes.InvalidParams,
				context,
			);
			assert.match(error.message, /reconnect requires channel ahp-root:\/\/$/u, context);
		}
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

		await client.shutdown();
		const resumed = await harness.connect();
		const result = (await resumed.reconnect({
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
		await client.shutdown();
		const resumed = await harness.connect();
		const result = (await resumed.reconnect({
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

		await client.shutdown();
		const resumed = await harness.connect();
		const result = (await resumed.reconnect({
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
			channel: ROOT_CHANNEL,
			clientId,
			protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
			clientInfo: { name: "vscode-editor-window" },
		});
		await first.shutdown();

		const replacement = await harness.connect();
		await replacement.initialize({ clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		assert.equal((await replacement.subscribe(clientUri)).result.snapshot?.resource, clientUri);
	});

	it("infers the provider URI dialect without clientInfo", async () => {
		const clientId = `${CLIENT_ID}-provider-alias`;
		const id = "provider-alias-reconnect";
		const canonical = sessionUri(id);
		const alias = `pi:/${id}`;
		harness.host.store.create(canonical, initialSessionState("pi", "Reconnect", "/tmp"), "session");

		const first = await harness.connect();
		await first.initialize({ clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		assert.equal((await first.subscribe(alias)).result.snapshot?.resource, alias);
		const staleSeq = harness.host.serverSeq;
		await first.shutdown();
		for (let i = 0; i < 6; i++) bumpActiveSessions(harness, i);

		const resumed = await harness.connect();
		const result = (await resumed.reconnect({
			clientId,
			lastSeenServerSeq: staleSeq,
			subscriptions: [alias],
		})) as ReconnectSnapshotResult;

		assert.equal(result.type, ReconnectResultType.Snapshot);
		assert.deepEqual(
			result.snapshots.map((snapshot) => snapshot.resource),
			[alias],
		);
		assert.equal(harness.host.store.has(canonical), true);
		assert.equal(harness.host.store.has(alias), false);
	});

	it("retains VS Code's URI dialect across connections", async () => {
		const clientId = `${CLIENT_ID}-vscode`;
		const id = "vscode-reconnect";
		const uri = sessionUri(id);
		const clientUri = `pi:/${id}`;
		harness.host.store.create(uri, initialSessionState("pi", "Reconnect", "/tmp"), "session");

		const first = await harness.connect();
		await first.request("initialize", {
			channel: ROOT_CHANNEL,
			clientId,
			protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
			clientInfo: { name: "vscode-editor-window" },
		});
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
	it("repairs VS Code's channel-less reconnect and restores a durable session", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-restart-sessions-"));
		const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-restart-cwd-"));
		const id = randomUUID();
		writeDurableSession(root, id, workspace);
		const backend = new RestartBackend();
		const harness = await startHarness({
			sessions: true,
			sessionRoot: root,
			workingDirectory: workspace,
			createBackend: () => backend,
		});

		try {
			const clientSession = `pi:/${id}`;
			const clientChat = `ahp-chat://default/${Buffer.from(clientSession).toString("base64url")}`;
			const client = await harness.connect();
			const result = (await client.request("reconnect", {
				clientId: "vscode-from-previous-host",
				lastSeenServerSeq: 42,
				subscriptions: [ROOT_CHANNEL, clientSession],
				_meta: { "vscode.telemetryLevel": "off" },
			} as never)) as ReconnectSnapshotResult;

			assert.equal(result.type, ReconnectResultType.Snapshot);
			assert.deepEqual(
				result.snapshots.map((snapshot) => snapshot.resource).sort(),
				[ROOT_CHANNEL, clientSession].sort(),
			);
			const sessionSnapshot = must(
				result.snapshots.find((snapshot) => snapshot.resource === clientSession),
				"VS Code session snapshot",
			);
			assert.equal((sessionSnapshot.state as SessionState).defaultChat, clientChat);

			const disposalError = await expectRpcError(
				client.request("disposeSession", { channel: clientSession }),
				JsonRpcErrorCodes.InvalidRequest,
			);
			assert.match(disposalError.message, /VS Code provisional-session lifecycle bug/u);
			assert.equal(harness.host.store.has(sessionUri(id)), true);

			const subscribed = await client.subscribe(clientChat);
			const chatSnapshot = must(subscribed.result.snapshot);
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
				message: { text: "continue after restart", origin: { kind: MessageKind.User } },
			});
			await eventually("the post-restart prompt to reach the backend", () => backend.prompts.length === 1);
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
