/**
 * Schema conformance of the host's outbound wire messages.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
	type ActionEnvelope,
	ActionType,
	type InitializeResult,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL } from "../src/core/channels.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";
import { checkSchema } from "./support/schema.ts";

describe("wire schema", () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness();
	});

	after(async () => {
		await harness.dispose();
	});

	it("emits a conforming InitializeResult", async () => {
		const client = await harness.connect();
		const result: InitializeResult = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [ROOT_CHANNEL],
		});

		assert.equal(checkSchema("commands", "InitializeResult", result), undefined);
	});

	it("emits a conforming RootState snapshot", async () => {
		const client = await harness.connect();
		const { result } = await client
			.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS })
			.then(() => client.subscribe(ROOT_CHANNEL));

		assert.ok(result.snapshot);
		assert.equal(checkSchema("commands", "Snapshot", result.snapshot), undefined);
		assert.equal(checkSchema("state", "RootState", result.snapshot.state), undefined);
	});

	it("emits conforming ActionEnvelopes", async () => {
		const client = await harness.connect();
		await client.initialize({
			clientId: nextClientId(),
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [ROOT_CHANNEL],
		});
		const subscription = client.attachSubscription(ROOT_CHANNEL);

		harness.host.dispatchServerAction(ROOT_CHANNEL, {
			type: ActionType.RootActiveSessionsChanged,
			activeSessions: 3,
		});

		let envelope: ActionEnvelope | undefined;
		for await (const event of subscription) {
			if (event.type === "action") {
				envelope = event.params;
				break;
			}
		}

		assert.ok(envelope);
		assert.equal(checkSchema("actions", "ActionEnvelope", envelope), undefined);
		assert.equal(checkSchema("actions", "StateAction", envelope.action), undefined);
	});

	it("fails validation for a structurally wrong action", () => {
		// The counterexample that motivates this suite: a reducer would accept
		// this silently (unknown shape → no-op), so only the schema catches it.
		const bogus = {
			channel: ROOT_CHANNEL,
			action: { type: ActionType.RootActiveSessionsChanged },
			serverSeq: 1,
		};

		assert.notEqual(checkSchema("actions", "ActionEnvelope", bogus), undefined);
	});
});
