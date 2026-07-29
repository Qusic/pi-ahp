/**
 * Subscriptions, action dispatch, and multi-client broadcast.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/subscriptions
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
	type ActionEnvelope,
	ActionType,
	type RootState,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import type { AhpClient, Subscription } from "@microsoft/agent-host-protocol/client";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { ROOT_CHANNEL } from "../src/core/channels.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";

/** Reads the next action envelope off a subscription, failing fast on a stall. */
async function nextEnvelope(subscription: Subscription, timeoutMs = 2_000): Promise<ActionEnvelope> {
	const timer = new Promise<never>((_, reject) => {
		const handle = setTimeout(() => reject(new Error("timed out waiting for an action")), timeoutMs);
		handle.unref?.();
	});
	const next = (async () => {
		for await (const event of subscription) {
			if (event.type === "action") {
				return event.params;
			}
		}
		throw new Error("subscription ended before an action arrived");
	})();
	return Promise.race([next, timer]);
}

async function initialized(harness: Harness, subscriptions: string[] = []): Promise<AhpClient> {
	const client = await harness.connect();
	await client.initialize({
		clientId: nextClientId(),
		protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
		initialSubscriptions: subscriptions,
	});
	return client;
}

describe("subscriptions", () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness();
	});

	after(async () => {
		await harness.dispose();
	});

	it("returns the current state as a snapshot", async () => {
		const client = await initialized(harness);
		const { result } = await client.subscribe(ROOT_CHANNEL);

		assert.ok(result.snapshot);
		assert.equal(result.snapshot.resource, ROOT_CHANNEL);
		assert.equal((result.snapshot.state as RootState).agents.length, 1);
	});

	it("rejects a channel scheme the host does not serve", async () => {
		const client = await initialized(harness);
		const error = await client.subscribe("ahp-unknown:/x").then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32602);
	});

	it("rejects a well-formed URI for a channel that does not exist", async () => {
		const client = await initialized(harness);
		const error = await client.subscribe("ahp-session:/nope").then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32008);
	});
});

describe("action dispatch", () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness();
	});

	after(async () => {
		await harness.dispose();
	});

	it("echoes a client-dispatchable action with its origin", async () => {
		const client = await initialized(harness);
		const { subscription } = await client.subscribe(ROOT_CHANNEL);

		const handle = client.dispatch(ROOT_CHANNEL, {
			type: ActionType.RootConfigChanged,
			config: { theme: "dark" },
		});
		const envelope = await nextEnvelope(subscription);

		assert.equal(envelope.channel, ROOT_CHANNEL);
		assert.equal(envelope.action.type, ActionType.RootConfigChanged);
		assert.equal(envelope.rejectionReason, undefined);
		// The origin lets the write-ahead client match the echo to its own dispatch.
		assert.equal(envelope.origin?.clientSeq, handle.clientSeq);
		assert.ok(envelope.serverSeq > 0);
	});

	it("rejects an action that is not client-dispatchable", async () => {
		const client = await initialized(harness);
		const { subscription } = await client.subscribe(ROOT_CHANNEL);

		// `root/agentsChanged` is server-only: the host owns the agent list.
		client.dispatch(ROOT_CHANNEL, { type: ActionType.RootAgentsChanged, agents: [] });
		const envelope = await nextEnvelope(subscription);

		assert.ok(envelope.rejectionReason, "expected a rejectionReason on the echo");
		assert.match(envelope.rejectionReason, /not client-dispatchable/);
		// The state must be untouched by a rejected action.
		assert.equal((harness.host.store.get(ROOT_CHANNEL) as RootState).agents.length, 1);
	});

	it("silently ignores an action for a channel that does not exist", async () => {
		const client = await initialized(harness);
		const { subscription } = await client.subscribe(ROOT_CHANNEL);

		client.dispatch("ahp-session:/ghost", { type: ActionType.SessionTitleChanged, title: "x" });
		// No echo for the ghost channel, so the next envelope on root is the one
		// we dispatch afterwards.
		client.dispatch(ROOT_CHANNEL, { type: ActionType.RootConfigChanged, config: { probe: 1 } });

		const envelope = await nextEnvelope(subscription);
		assert.equal(envelope.channel, ROOT_CHANNEL);
	});

	it("broadcasts to every subscriber and allocates one seq per action", async () => {
		const alice = await initialized(harness);
		const bob = await initialized(harness);
		const { subscription: aliceSub } = await alice.subscribe(ROOT_CHANNEL);
		const { subscription: bobSub } = await bob.subscribe(ROOT_CHANNEL);

		alice.dispatch(ROOT_CHANNEL, { type: ActionType.RootConfigChanged, config: { shared: true } });

		const [seenByAlice, seenByBob] = await Promise.all([nextEnvelope(aliceSub), nextEnvelope(bobSub)]);

		assert.equal(seenByAlice.serverSeq, seenByBob.serverSeq);
		assert.deepEqual(seenByAlice.action, seenByBob.action);
		// Both clients reduce the same envelope, so they converge by construction.
		assert.equal(seenByAlice.origin?.clientId, seenByBob.origin?.clientId);
	});

	it("treats root/configChanged as a no-op until the host declares a config schema", async () => {
		// Matches the upstream reducer case
		// `128-root-configchanged-noops-when-config-undefined`: config values can
		// only be merged into a schema the host has already published. The action
		// is still sequenced and echoed — it just does not change state.
		const client = await initialized(harness);
		const { subscription } = await client.subscribe(ROOT_CHANNEL);

		client.dispatch(ROOT_CHANNEL, { type: ActionType.RootConfigChanged, config: { theme: "dark" } });
		const envelope = await nextEnvelope(subscription);

		assert.equal(envelope.rejectionReason, undefined);
		assert.equal((harness.host.store.get(ROOT_CHANNEL) as RootState).config, undefined);
	});

	it("stops delivering after unsubscribe", async () => {
		const client = await initialized(harness);
		const { subscription } = await client.subscribe(ROOT_CHANNEL);
		await client.unsubscribe(ROOT_CHANNEL);

		const seqBefore = harness.host.serverSeq;
		harness.host.dispatchServerAction(ROOT_CHANNEL, {
			type: ActionType.RootActiveSessionsChanged,
			activeSessions: 7,
		});

		// The action was still sequenced and applied — the client just stops seeing it.
		assert.equal(harness.host.serverSeq, seqBefore + 1);
		const stalled = await Promise.race([
			nextEnvelope(subscription, 150).then(() => "delivered"),
			new Promise<string>((resolve) => {
				const handle = setTimeout(() => resolve("silent"), 250);
				handle.unref?.();
			}),
		]).catch(() => "silent");
		assert.equal(stalled, "silent");
	});
});
