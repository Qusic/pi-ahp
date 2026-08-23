/**
 * Session lifecycle: create, ready, dispose, and the catalogue notifications
 * that keep every client's session list current.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/session-channel
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	ActionType,
	type ChatState,
	SessionLifecycle,
	type SessionState,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { type AhpClient, RpcError, type Subscription } from "@microsoft/agent-host-protocol/client";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { PI_PROVIDER } from "../src/pi/provider.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";
import { checkSchema } from "./support/schema.ts";

async function nextEvent(
	subscription: Subscription,
	predicate: (event: { type: string }) => boolean,
	timeoutMs = 2_000,
): Promise<{ type: string; params: unknown }> {
	const timer = new Promise<never>((_, reject) => {
		const handle = setTimeout(() => reject(new Error("timed out waiting for an event")), timeoutMs);
		handle.unref?.();
	});
	const next = (async () => {
		for await (const event of subscription) {
			if (predicate(event)) {
				return event as { type: string; params: unknown };
			}
		}
		throw new Error("subscription ended early");
	})();
	return Promise.race([next, timer]);
}

describe("session lifecycle", () => {
	let harness: Harness;
	let workspace: string;

	before(async () => {
		workspace = mkdtempSync(join(tmpdir(), "pi-ahp-session-"));
		harness = await startHarness({ sessions: true, workingDirectory: workspace });
	});

	after(async () => {
		await harness.dispose();
		rmSync(workspace, { recursive: true, force: true });
	});

	async function initialized(subscriptions: string[] = [ROOT_CHANNEL]): Promise<AhpClient> {
		const client = await harness.connect();
		await client.initialize({
			clientId: nextClientId(),
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: subscriptions,
		});
		return client;
	}

	it("creates a session at the client-chosen URI and reports it ready", async () => {
		const client = await initialized();
		const uri = sessionUri(randomUUID());

		await client.request("createSession", { channel: uri, provider: PI_PROVIDER } as never);

		const { result } = await client.subscribe(uri);
		const state = result.snapshot?.state as SessionState;
		assert.equal(state.provider, PI_PROVIDER);
		// Creation is asynchronous in the protocol, but this milestone has no
		// agent to start, so the session is already ready by the time a client
		// can observe it.
		assert.equal(state.lifecycle, SessionLifecycle.Ready);
		assert.deepEqual(state.workingDirectories, [`file://${workspace}`]);
		// Every session gets exactly one chat, and it is the default. The agent
		// declares no `multipleChats` capability, which is what tells a client not
		// to call `createChat`.
		assert.equal(state.chats.length, 1);
		assert.equal(state.defaultChat, state.chats[0]?.resource);
		assert.equal(checkSchema("state", "SessionState", state), undefined);
	});

	it("uses pi's session id as the URI's uuid", async () => {
		const client = await initialized();
		const id = randomUUID();
		await client.request("createSession", { channel: sessionUri(id) } as never);

		const live = harness.sessions?.get(sessionUri(id));
		assert.ok(live);
		// One identity space, so no persistent uuid → session-file mapping.
		assert.equal(live.sessionId, id);
		assert.equal(live.sessionManager.getSessionId(), id);
	});

	it("announces the new session on the root channel", async () => {
		const client = await initialized();
		const rootSubscription = client.attachSubscription(ROOT_CHANNEL);
		const uri = sessionUri(randomUUID());

		await client.request("createSession", { channel: uri } as never);

		const event = await nextEvent(rootSubscription, (candidate) => candidate.type === "sessionAdded");
		const params = event.params as { summary: { resource: string } };
		assert.equal(params.summary.resource, uri);
		assert.equal(checkSchema("state", "SessionSummary", params.summary), undefined);
	});

	it("rejects a duplicate session URI with SessionAlreadyExists", async () => {
		const client = await initialized();
		const uri = sessionUri(randomUUID());
		await client.request("createSession", { channel: uri } as never);

		const error = await client.request("createSession", { channel: uri } as never).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32003);
	});

	it("rejects an unknown provider with ProviderNotFound", async () => {
		const client = await initialized();
		const error = await client
			.request("createSession", { channel: sessionUri(randomUUID()), provider: "claude" } as never)
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32002);
	});

	it("honours a client-supplied working directory", async () => {
		const client = await initialized();
		const other = mkdtempSync(join(tmpdir(), "pi-ahp-cwd-"));
		try {
			const uri = sessionUri(randomUUID());
			await client.request("createSession", { channel: uri, workingDirectories: [`file://${other}`] } as never);

			const state = harness.host.store.get(uri) as SessionState;
			assert.deepEqual(state.workingDirectories, [`file://${other}`]);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("tracks the active session count in root state", async () => {
		const client = await initialized();
		const before = (harness.host.store.get(ROOT_CHANNEL) as { activeSessions?: number }).activeSessions ?? 0;

		await client.request("createSession", { channel: sessionUri(randomUUID()) } as never);

		const after = (harness.host.store.get(ROOT_CHANNEL) as { activeSessions?: number }).activeSessions ?? 0;
		assert.equal(after, before + 1);
	});

	it("disposes a session, drops its channel, and announces the removal", async () => {
		const client = await initialized();
		const rootSubscription = client.attachSubscription(ROOT_CHANNEL);
		const uri = sessionUri(randomUUID());
		await client.request("createSession", { channel: uri } as never);
		assert.ok(harness.host.store.has(uri));

		await client.request("disposeSession", { channel: uri } as never);

		const event = await nextEvent(rootSubscription, (candidate) => candidate.type === "sessionRemoved");
		assert.equal((event.params as { session: string }).session, uri);
		assert.equal(harness.host.store.has(uri), false);
		assert.equal(harness.sessions?.get(uri), undefined);
	});

	it("rejects disposing a session that does not exist", async () => {
		const client = await initialized();
		const error = await client.request("disposeSession", { channel: sessionUri("nope") } as never).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32001);
	});

	it("accepts session/titleChanged from a client", async () => {
		const client = await initialized();
		const uri = sessionUri(randomUUID());
		await client.request("createSession", { channel: uri } as never);
		await client.subscribe(uri);

		client.dispatch(uri, { type: ActionType.SessionTitleChanged, title: "Refactor auth" });

		// Wait for the echo so the reducer has run before asserting.
		const subscription = client.attachSubscription(uri);
		await nextEvent(subscription, (candidate) => candidate.type === "action");
		assert.equal((harness.host.store.get(uri) as SessionState).title, "Refactor auth");
	});

	it("declines VS Code's active client without blocking session creation", async () => {
		const clientId = nextClientId();
		const client = await harness.connect();
		await client.request("initialize", {
			clientId,
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			clientInfo: { name: "vscode-editor-window" },
		} as never);
		const id = randomUUID();
		const uri = sessionUri(id);
		const clientUri = `pi:/${id}`;
		const activeClient = { clientId, tools: [] };

		// VS Code supplies this eagerly. It is ignored rather than making an
		// otherwise usable session fail.
		await client.request("createSession", { channel: clientUri, activeClient } as never);
		await client.subscribe(clientUri);

		for (const action of [
			{ type: ActionType.SessionActiveClientSet, activeClient },
			{ type: ActionType.SessionActiveClientRemoved, clientId },
		] as const) {
			const events = client.attachSubscription(clientUri);
			client.dispatch(clientUri, action);
			const event = await nextEvent(events, (candidate) => candidate.type === "action");
			const envelope = event.params as { action?: { type?: string }; rejectionReason?: string };
			assert.equal(envelope.action?.type, action.type);
			assert.equal(envelope.rejectionReason, "This host does not accept active clients");
		}

		assert.deepEqual((harness.host.store.get(uri) as SessionState).activeClients, []);
	});
});

describe("renaming a session", () => {
	let harness: Harness;
	let workspace: string;

	before(async () => {
		workspace = mkdtempSync(join(tmpdir(), "pi-ahp-rename-"));
		harness = await startHarness({ sessions: true, workingDirectory: workspace });
	});

	after(async () => {
		await harness.dispose();
		rmSync(workspace, { recursive: true, force: true });
	});

	async function renamed(uri: string, title: string): Promise<void> {
		const client = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		await client.subscribe(uri);
		client.dispatch(uri, { type: ActionType.SessionTitleChanged, title } as never);
		await new Promise((resolve) => {
			const handle = setTimeout(resolve, 120);
			handle.unref?.();
		});
	}

	it("records the new name on the session", async () => {
		const client = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		const uri = sessionUri(randomUUID());
		await client.request("createSession", { channel: uri } as never);

		await renamed(uri, "Refactor auth middleware");

		// The same call pi's own `/resume` rename makes, so a session renamed
		// here reads the same from pi's CLI.
		assert.equal(harness.sessions?.get(uri)?.sessionManager.getSessionName(), "Refactor auth middleware");
	});

	it("does not create a file for a session that never got a reply", async () => {
		const client = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		const uri = sessionUri(randomUUID());
		await client.request("createSession", { channel: uri } as never);
		await renamed(uri, "Never answered");

		// pi withholds the file until a session has an assistant message
		// (`SessionManager._persist`), so an empty conversation leaves nothing
		// behind. The name is held in memory and flushed with everything else
		// once the first reply arrives — renaming does not change that policy,
		// and forcing a write here would litter the disk with empty sessions.
		const file = harness.sessions?.get(uri)?.sessionManager.getSessionFile();
		assert.ok(file);
		assert.equal(existsSync(file), false);
	});

	it("mirrors the name onto the chat and the catalogue entry", async () => {
		const client = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		const id = randomUUID();
		const uri = sessionUri(id);
		await client.request("createSession", { channel: uri } as never);
		await renamed(uri, "Ship the release");

		const session = harness.host.store.get(uri) as SessionState;
		const chat = harness.host.store.get(chatUri(id)) as ChatState;
		assert.equal(session.title, "Ship the release");
		// `ChatState` denormalises its summary fields, so both representations
		// have to move together or a client watching only the session drifts.
		assert.equal(chat.title, "Ship the release");
		assert.equal(session.chats[0]?.title, "Ship the release");
	});
});
