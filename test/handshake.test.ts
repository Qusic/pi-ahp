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
import { AhpErrorCodes, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { ROOT_CHANNEL } from "../src/core/channels.ts";
import { type Harness, must, nextClientId, startHarness, TEST_AGENT } from "./harness.ts";

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

	it("honours client preference order over the host's own", async () => {
		const client = await harness.connect();
		// The host prefers 0.6.0, but the client asked for 0.5.2 first.
		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: ["0.5.2", "0.6.0"],
		});

		assert.equal(result.protocolVersion, "0.5.2");
	});

	it("ignores versions it does not know and picks the first it does", async () => {
		const client = await harness.connect();
		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: ["99.0.0", "0.6.0"],
		});

		assert.equal(result.protocolVersion, "0.6.0");
	});

	it("rejects an unsupported version with UnsupportedProtocolVersion", async () => {
		const client = await harness.connect();
		const error = await client.initialize({ clientId: nextClientId(), protocolVersions: ["99.0.0"] }).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError, `expected RpcError, got ${String(error)}`);
		assert.equal(error.code, AhpErrorCodes.UnsupportedProtocolVersion);
		// The error advertises what the host can speak so the client can downgrade.
		const data = error.data as { supportedVersions?: string[] } | undefined;
		assert.deepEqual(data?.supportedVersions, [...SUPPORTED_PROTOCOL_VERSIONS]);
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
		const error = await client
			.request("initialize", {
				channel: ROOT_CHANNEL,
				protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
			} as never)
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32602);
	});

	it("answers ping before initialize", async () => {
		const client = await harness.connect();
		// The spec requires ping to work regardless of handshake or subscription
		// state, so idle-timeout intermediaries can be kept alive from the start.
		await client.ping();
	});
});
