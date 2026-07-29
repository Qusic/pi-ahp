/**
 * Reconnection: replay from the buffer, snapshot fallback, and unresumable
 * subscriptions.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/lifecycle
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
	ActionType,
	type ReconnectReplayResult,
	ReconnectResultType,
	type ReconnectSnapshotResult,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { type Harness, must, startHarness } from "./harness.ts";

const CLIENT_ID = "reconnecting-client";

function bumpActiveSessions(harness: Harness, count: number): void {
	harness.host.dispatchServerAction(ROOT_CHANNEL, {
		type: ActionType.RootActiveSessionsChanged,
		activeSessions: count,
	});
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
});
