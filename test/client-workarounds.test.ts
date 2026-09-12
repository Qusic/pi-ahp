/** Per-connection URI compatibility without leaking client dialects into core state. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
	ActionType,
	type ChatState,
	type SessionState,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { chatUri, ROOT_CHANNEL, sessionIdFromUri, sessionUri } from "../src/core/channels.ts";
import { ClientWorkarounds } from "../src/core/client-workarounds.ts";
import { PI_PROVIDER } from "../src/pi/provider.ts";
import type { RunningServer } from "../src/transport/websocket.ts";
import { must } from "./support/assertions.ts";
import { type HydratedSessionFixture, startHydratedSessionFixture } from "./support/hydrated-session.ts";
import { assertValid } from "./support/schema.ts";

async function initialSnapshotResources(
	server: RunningServer,
	clientId: string,
	initialSubscriptions: string[],
	clientInfo?: { name: string },
): Promise<string[]> {
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	try {
		const result = await client.request("initialize", {
			channel: ROOT_CHANNEL,
			clientId,
			protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
			initialSubscriptions,
			...(clientInfo ? { clientInfo } : {}),
		});
		return result.snapshots.map((snapshot) => snapshot.resource);
	} finally {
		await client.shutdown();
	}
}

describe("client URI dialects over the wire", () => {
	let fixture: HydratedSessionFixture;

	before(async () => {
		fixture = await startHydratedSessionFixture();
	});

	after(async () => {
		await fixture.close();
	});

	it("answers VS Code at the URIs it computes for itself", async () => {
		const client = await fixture.connectAsVSCode();
		const providerSession = `pi:/${fixture.sessionId}`;
		const derived = `ahp-chat://default/${Buffer.from(providerSession).toString("base64url")}`;

		const session = await client.subscribe(providerSession);
		const sessionState = session.result.snapshot?.state as SessionState;
		assert.equal(session.result.snapshot?.resource, providerSession);
		assert.equal(sessionState.defaultChat, derived);

		const { result } = await client.subscribe(derived);
		const state = must(result.snapshot).state as ChatState;
		assert.equal(result.snapshot?.resource, derived);
		assert.ok(state.turns.length > 0, "the transcript must come back, not an empty chat");
		assertValid("state", "ChatState", state);
	});

	for (const [name, clientInfo, usesDerivedChat] of [
		["VS Code", { name: "vscode-editor-window" }, true],
		["unnamed provider-alias client", undefined, false],
	] as const) {
		it(`applies the ${name} dialect to initialize-time subscriptions`, async () => {
			const providerSession = `pi:/${fixture.sessionId}`;
			const chat = usesDerivedChat
				? `ahp-chat://default/${Buffer.from(providerSession).toString("base64url")}`
				: chatUri(fixture.sessionId);
			const subscriptions = [providerSession, chat];

			assert.deepEqual(
				await initialSnapshotResources(fixture.server, `initial-subscriptions-${name}`, subscriptions, clientInfo),
				subscriptions,
			);
		});
	}
});

describe("session URI classification", () => {
	it("recognises only canonical or explicitly allowed session schemes", () => {
		const id = "9991C40A-74CC-4991-85CC-F37CD2BFF065";
		assert.equal(sessionIdFromUri(`pi:/${id}`, [PI_PROVIDER]), id);
		assert.equal(sessionIdFromUri("ahp-session:/abc"), "abc");
		assert.equal(sessionIdFromUri("copilot:/test-session"), undefined);
		assert.equal(sessionIdFromUri("copilot:/test-session", ["copilot"]), "test-session");
		assert.equal(sessionIdFromUri("pi://test-session", [PI_PROVIDER]), undefined);
	});

	it("does not infer sessions from other channel schemes", () => {
		for (const uri of ["ahp-chat:/c1", "ahp-terminal:/t1", "agenthost-terminal:/t1", "file:///etc/passwd"]) {
			assert.equal(sessionIdFromUri(uri, [PI_PROVIDER]), undefined, uri);
		}
	});

	it("retargets VS Code's chat-addressed rename to the owning session", () => {
		const id = "rename-me";
		const workarounds = new ClientWorkarounds();
		workarounds.identify({ name: "vscode-editor-window" });
		const message = {
			jsonrpc: "2.0" as const,
			method: "dispatchAction",
			params: {
				channel: `ahp-chat://default/${Buffer.from(`pi:/${id}`).toString("base64url")}`,
				clientSeq: 1,
				action: { type: ActionType.SessionTitleChanged, title: "Renamed" },
			},
		};

		workarounds.applyToIncoming(message);

		assert.equal(message.params.channel, sessionUri(id));
	});

	it("rewrites URI-bearing action and catalogue fields for VS Code", () => {
		const id = "nested-fields";
		const session = sessionUri(id);
		const chat = chatUri(id);
		const providerSession = `pi:/${id}`;
		const derivedChat = `ahp-chat://default/${Buffer.from(providerSession).toString("base64url")}`;
		const workarounds = new ClientWorkarounds();
		workarounds.identify({ name: "vscode-editor-window" });

		const removed = workarounds.applyToMessage({
			jsonrpc: "2.0",
			method: "root/sessionRemoved",
			params: { channel: ROOT_CHANNEL, session },
		});
		assert.deepEqual(removed, {
			jsonrpc: "2.0",
			method: "root/sessionRemoved",
			params: { channel: ROOT_CHANNEL, session: providerSession },
		});

		const updated = workarounds.applyToMessage({
			jsonrpc: "2.0",
			method: "action",
			params: {
				channel: session,
				action: { type: ActionType.SessionChatUpdated, chat, changes: { resource: chat } },
				serverSeq: 1,
			},
		});
		assert.deepEqual(updated, {
			jsonrpc: "2.0",
			method: "action",
			params: {
				channel: providerSession,
				action: {
					type: ActionType.SessionChatUpdated,
					chat: derivedChat,
					changes: { resource: derivedChat },
				},
				serverSeq: 1,
			},
		});
	});

	it("leaves VS Code's client-chosen terminal URI outside session translation", () => {
		const channel = "agenthost-terminal:/terminal-1";
		const workarounds = new ClientWorkarounds();
		workarounds.identify({ name: "vscode-editor-window" });

		const message = { jsonrpc: "2.0" as const, method: "action", params: { channel } };
		assert.deepEqual(workarounds.applyToMessage(message), message);
	});

	it("does not hydrate or dispose a durable session through VS Code's terminal URI", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			const client = await fixture.connectAsVSCode();
			const channel = `agenthost-terminal:/${fixture.sessionId}`;
			await assert.rejects(
				client.subscribe(channel),
				RpcError,
				"an uncreated terminal must not open a matching session",
			);
			await assert.rejects(
				client.request("disposeSession", { channel }),
				RpcError,
				"a terminal URI must not delete a matching session",
			);
			assert.equal(fixture.host.store.has(channel), false);
			assert.deepEqual(fixture.deletedFiles, []);
		} finally {
			await fixture.close();
		}
	});

	it("accepts the provider scheme but rejects an undeclared session scheme", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			await assert.rejects(fixture.client.request("createSession", { channel: `custom:/${randomUUID()}` }), RpcError);

			const id = randomUUID().toUpperCase();
			const uri = `pi:/${id}`;
			await fixture.client.request("createSession", { channel: uri });

			const { result } = await fixture.client.subscribe(uri);
			assert.ok(result.snapshot, "the session must exist at the URI the client chose");
			assert.equal(result.snapshot.resource, uri);
			assert.equal((result.snapshot.state as SessionState).defaultChat, chatUri(id));
			assert.equal(fixture.host.store.has(sessionUri(id)), true, "core state stays canonical");
			assert.equal(fixture.host.store.has(uri), false);

			await fixture.client.request("disposeSession", { channel: uri });
			assert.equal(fixture.host.store.has(sessionUri(id)), false);
		} finally {
			await fixture.close();
		}
	});
});
