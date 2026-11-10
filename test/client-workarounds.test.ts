/** VS Code's remaining protocol departures, repaired per connection without touching URIs. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
	ActionType,
	JsonRpcErrorCodes,
	MessageKind,
	type ResolveSessionConfigResult,
	type SessionState,
} from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { chatIdFromUri, chatUri, ROOT_CHANNEL, sessionIdFromUri, sessionUri } from "../src/core/channels.ts";
import { ClientWorkarounds } from "../src/core/client-workarounds.ts";
import { expectRpcError, expectVscodeDisposalRefusal, must } from "./support/assertions.ts";
import { type HydratedSessionFixture, startHydratedSessionFixture } from "./support/hydrated-session.ts";

describe("VS Code over the wire", () => {
	let fixture: HydratedSessionFixture;

	before(async () => {
		fixture = await startHydratedSessionFixture();
	});

	after(async () => {
		await fixture.close();
	});

	it("serves VS Code the standard session and chat URIs it addresses them by", async () => {
		// VS Code keeps the URI a host advertises; translating it gave one
		// session two identities (Qusic/pi-ahp#7).
		const client = await fixture.connectAsVSCode();
		const session = sessionUri(fixture.sessionId);
		const chat = chatUri(fixture.sessionId);

		const snapshot = must((await client.subscribe(session)).result.snapshot);
		assert.equal(snapshot.resource, session);
		assert.equal((snapshot.state as SessionState).defaultChat, chat);
		const listed = await client.request("listSessions", { channel: ROOT_CHANNEL });
		assert.equal(must(listed.items.find((item) => item.resource === session)).defaultChat, chat);

		assert.equal((await client.subscribe(chat)).result.snapshot?.resource, chat);
	});
});

describe("VS Code session configuration", () => {
	it("shows VS Code the properties that apply only at creation as read-only", () => {
		for (const [name, locked] of [
			["vscode-editor-window", true],
			["other-client", false],
		] as const) {
			const workarounds = new ClientWorkarounds();
			workarounds.applyToIncoming({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name } } });
			workarounds.applyToIncoming({ jsonrpc: "2.0", id: 2, method: "resolveSessionConfig", params: {} });
			const result: ResolveSessionConfigResult = {
				schema: {
					type: "object",
					properties: {
						atCreation: { type: "boolean", title: "At creation" },
						mutable: { type: "boolean", title: "Mutable", sessionMutable: true },
					},
				},
				values: {},
			};
			workarounds.applyToOutgoing({ jsonrpc: "2.0", id: 2, result });
			assert.equal(result.schema.properties.atCreation?.readOnly, locked ? true : undefined, name);
			assert.equal(result.schema.properties.mutable?.readOnly, undefined, name);
		}
	});
});

describe("VS Code session disposal workaround", () => {
	it("protects a durable session that this connection did not create", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			const client = await fixture.connectAsVSCode();
			const resource = sessionUri(fixture.sessionId);

			await expectVscodeDisposalRefusal(client.request("disposeSession", { channel: resource }));

			assert.deepEqual(fixture.deletedFiles, []);
			const listed = await client.request("listSessions", { channel: ROOT_CHANNEL });
			assert.equal(
				listed.items.some((item) => item.resource === resource),
				true,
			);
		} finally {
			await fixture.close();
		}
	});

	it("still disposes an empty session created by this VS Code connection", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			const client = await fixture.connectAsVSCode();
			const resource = sessionUri(randomUUID());
			await client.request("createSession", { channel: resource });

			await client.request("disposeSession", { channel: resource });

			assert.equal(fixture.host.store.has(resource), false);
		} finally {
			await fixture.close();
		}
	});

	it("restores an empty session after disposal fails so VS Code can retry", async () => {
		let attempts = 0;
		const fixture = await startHydratedSessionFixture({
			deleteFile: () => {
				attempts += 1;
				return attempts === 1 ? { ok: false, error: "temporary failure" } : { ok: true };
			},
		});
		try {
			const client = await fixture.connectAsVSCode();
			const resource = sessionUri(randomUUID());
			await client.request("createSession", { channel: resource });

			const error = await expectRpcError(
				client.request("disposeSession", { channel: resource }),
				JsonRpcErrorCodes.InternalError,
			);
			assert.match(error.message, /temporary failure/u);
			await client.request("disposeSession", { channel: resource });

			assert.equal(attempts, 2);
			assert.equal(fixture.host.store.has(resource), false);
		} finally {
			await fixture.close();
		}
	});

	it("protects a session after its first turn starts", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			const client = await fixture.connectAsVSCode();
			const id = randomUUID();
			const resource = sessionUri(id);
			await client.request("createSession", { channel: resource });
			client.dispatch(chatUri(id), {
				type: ActionType.ChatTurnStarted,
				turnId: "materialized-turn",
				startedAt: new Date().toISOString(),
				message: { text: "keep this", origin: { kind: MessageKind.User } },
			});

			await expectVscodeDisposalRefusal(client.request("disposeSession", { channel: resource }));

			assert.equal(fixture.host.store.has(resource), true);
		} finally {
			await fixture.close();
		}
	});
});

describe("channel URI classification", () => {
	it("reads ids only from single-segment standard session and chat URIs", () => {
		assert.equal(sessionIdFromUri("ahp-session:/abc"), "abc");
		assert.equal(chatIdFromUri("ahp-chat:/abc"), "abc");
		for (const uri of [
			"pi:/abc",
			"AHP-SESSION:/abc",
			"ahp-session://abc",
			"ahp-session:/a/b",
			"ahp-session:/abc?x",
			"ahp-chat:/c1",
		]) {
			assert.equal(sessionIdFromUri(uri), undefined, uri);
		}
		for (const uri of ["ahp-chat:/", "ahp-chat:/a/b", "ahp-chat://abc", "AHP-CHAT:/abc", "ahp-session:/abc"]) {
			assert.equal(chatIdFromUri(uri), undefined, uri);
		}
	});

	it("refuses to create a session at a non-standard URI", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			const channel = `pi:/${randomUUID()}`;
			await expectRpcError(fixture.client.request("createSession", { channel }), JsonRpcErrorCodes.InvalidParams);
			assert.equal(fixture.host.store.has(channel), false);
		} finally {
			await fixture.close();
		}
	});

	it("does not open or delete a durable session through another URI scheme", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			// `pi:/` once aliased sessions, and a client-chosen terminal URI can share a session's id.
			for (const channel of [`pi:/${fixture.sessionId}`, `agenthost-terminal:/${fixture.sessionId}`]) {
				await assert.rejects(fixture.client.subscribe(channel), RpcError, `${channel} must not open the session`);
				await assert.rejects(
					fixture.client.request("disposeSession", { channel }),
					RpcError,
					`${channel} must not delete the session`,
				);
				assert.equal(fixture.host.store.has(channel), false, channel);
			}
			assert.deepEqual(fixture.deletedFiles, []);
		} finally {
			await fixture.close();
		}
	});
});
