/**
 * Connection handshake.
 *
 * Mirrors the scenarios in the reference host's
 * `test/node/protocol/handshake.integrationTest.ts`.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/lifecycle
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { RootState } from "@microsoft/agent-host-protocol";
import {
	ActionType,
	AhpErrorCodes,
	JsonRpcErrorCodes,
	PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { initialSessionState } from "../src/channels/session.ts";
import { ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { type Harness, must, nextClientId, startHarness, TEST_AGENT } from "./harness.ts";

async function expectRpcError(promise: Promise<unknown>, code: number): Promise<RpcError> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	assert.ok(error instanceof RpcError);
	assert.equal(error.code, code);
	return error;
}

describe("handshake", () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness();
	});

	after(async () => {
		await harness.dispose();
	});

	it("negotiates the client's most-preferred supported version", async () => {
		const client = await harness.connect();
		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
		});

		assert.equal(result.protocolVersion, PROTOCOL_VERSION);
		assert.equal(typeof result.serverSeq, "number");
		assert.equal(result.serverInfo?.name, "pi-ahp");
	});

	it("does not advertise deferred host capabilities", async () => {
		const client = await harness.connect();
		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
		});

		assert.equal(result.terminalCommandPrefix, undefined);
		assert.equal(result.telemetry, undefined);
		assert.equal(result.automations, undefined);
	});

	it("ignores versions it does not know before the current one", async () => {
		const client = await harness.connect();
		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: ["99.0.0", PROTOCOL_VERSION],
		});

		assert.equal(result.protocolVersion, PROTOCOL_VERSION);
	});

	it("rejects an older wire model with UnsupportedProtocolVersion", async () => {
		const client = await harness.connect();
		const error = await expectRpcError(
			client.initialize({ clientId: nextClientId(), protocolVersions: ["0.8.0"] }),
			AhpErrorCodes.UnsupportedProtocolVersion,
		);
		const data = error.data as { supportedVersions?: string[] } | undefined;
		assert.deepEqual(data?.supportedVersions, [PROTOCOL_VERSION]);
	});

	it("returns a snapshot for each initialSubscription in the same round-trip", async () => {
		const client = await harness.connect();
		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [ROOT_CHANNEL],
		});

		assert.equal(result.snapshots.length, 1);
		const snapshot = must(result.snapshots[0]);
		assert.equal(snapshot.resource, ROOT_CHANNEL);
		assert.equal(snapshot.fromSeq, result.serverSeq);

		const rootState = snapshot.state as RootState;
		assert.deepEqual(rootState.agents, [TEST_AGENT]);
	});

	it("skips unknown initialSubscriptions instead of failing the handshake", async () => {
		const client = await harness.connect();
		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [ROOT_CHANNEL, "ahp-session:/does-not-exist"],
		});

		assert.equal(result.snapshots.length, 1);
		assert.equal(must(result.snapshots[0]).resource, ROOT_CHANNEL);
	});

	it("rejects an initialize without a clientId", async () => {
		const client = await harness.connect();
		await expectRpcError(
			client.request("initialize", {
				channel: ROOT_CHANNEL,
				protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
			} as never),
			JsonRpcErrorCodes.InvalidParams,
		);
	});

	it("rejects malformed initialize descriptors", async () => {
		const client = await harness.connect();
		for (const invalid of [
			{ protocolVersions: [42] },
			{ clientInfo: { name: 42 } },
			{ locale: 42 },
			{ capabilities: [] },
		]) {
			await expectRpcError(
				client.request("initialize", {
					channel: ROOT_CHANNEL,
					clientId: nextClientId(),
					protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
					...invalid,
				} as never),
				JsonRpcErrorCodes.InvalidParams,
			);
		}
		assert.equal(
			(await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS }))
				.protocolVersion,
			PROTOCOL_VERSION,
		);
	});

	it("answers ping before initialize", async () => {
		const client = await harness.connect();
		// The spec requires ping to work regardless of handshake or subscription
		// state, so idle-timeout intermediaries can be kept alive from the start.
		await client.ping();
	});

	it("ignores notifications before initialize or reconnect", async () => {
		const client = await harness.connect();
		const before = harness.host.serverSeq;
		client.dispatch(ROOT_CHANNEL, { type: ActionType.RootConfigChanged, config: { ignored: true } });
		// WebSocket ordering makes the ping response a barrier after the notification.
		await client.ping();
		assert.equal(harness.host.serverSeq, before);
	});

	it("requires initialize or reconnect before other requests", async () => {
		const client = await harness.connect();
		await expectRpcError(
			client.request("listSessions", { channel: ROOT_CHANNEL } as never),
			JsonRpcErrorCodes.InvalidRequest,
		);
	});

	it("rejects a second handshake on an initialized connection", async () => {
		const client = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		await expectRpcError(
			client.request("initialize", {
				channel: ROOT_CHANNEL,
				clientId: nextClientId(),
				protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			} as never),
			JsonRpcErrorCodes.InvalidRequest,
		);
	});

	it("rejects malformed reconnect state without binding the connection", async () => {
		const client = await harness.connect();
		for (const invalid of [
			{ clientId: "", lastSeenServerSeq: 0, subscriptions: [] },
			{ lastSeenServerSeq: -1, subscriptions: [] },
			{ lastSeenServerSeq: 0, subscriptions: 42 },
		]) {
			await expectRpcError(
				client.request("reconnect", {
					channel: ROOT_CHANNEL,
					clientId: nextClientId(),
					...invalid,
				} as never),
				JsonRpcErrorCodes.InvalidParams,
			);
		}

		const result = await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		assert.equal(result.protocolVersion, PROTOCOL_VERSION);
	});

	it("rejects malformed subscription lists without binding or poisoning the connection", async () => {
		const client = await harness.connect();
		const id = "handshake-retry";
		const canonical = sessionUri(id);
		harness.host.store.create(canonical, initialSessionState("pi", "Retry", "/tmp"), "session");
		await expectRpcError(
			client.request("initialize", {
				channel: ROOT_CHANNEL,
				clientId: nextClientId(),
				protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
				// The valid provider alias must not establish a dialect when another
				// element makes the whole handshake invalid.
				initialSubscriptions: [`pi:/${id}`, 42],
			} as never),
			JsonRpcErrorCodes.InvalidParams,
		);

		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [canonical],
		});
		assert.equal(result.protocolVersion, PROTOCOL_VERSION);
		assert.deepEqual(
			result.snapshots.map((snapshot) => snapshot.resource),
			[canonical],
		);
	});
});

describe("connection token", () => {
	// VS Code names a manually configured connection token `tkn`; generic AHP
	// examples use `token`. A direct listener configured with a token accepts
	// either spelling.
	for (const param of ["token", "tkn"]) {
		it(`accepts the token as \`${param}\``, async () => {
			const harness = await startHarness({ connectionToken: "secret" });
			try {
				const client = await harness.connectWith(`?${param}=secret`);
				const result = await client.initialize({
					clientId: nextClientId(),
					protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
				});
				assert.equal(result.protocolVersion, PROTOCOL_VERSION);
			} finally {
				await harness.dispose();
			}
		});
	}

	it("rejects a wrong token", async () => {
		const harness = await startHarness({ connectionToken: "secret" });
		try {
			await assert.rejects(harness.connectWith("?tkn=wrong"));
		} finally {
			await harness.dispose();
		}
	});

	it("ignores a VS Code tkn when the listener requires no token", async () => {
		const harness = await startHarness();
		try {
			const client = await harness.connectWith("?tkn=legacy-tunnel-value");
			const result = await client.initialize({
				clientId: nextClientId(),
				protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			});
			assert.equal(result.protocolVersion, PROTOCOL_VERSION);
		} finally {
			await harness.dispose();
		}
	});
});
