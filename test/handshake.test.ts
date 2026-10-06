/**
 * Connection handshake and pre-handshake request policy.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/lifecycle
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { RootState, SessionState } from "@microsoft/agent-host-protocol";
import {
	ActionType,
	AhpErrorCodes,
	JsonRpcErrorCodes,
	PROTOCOL_VERSION,
	ReconnectResultType,
	SessionStatus,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { initialSessionState } from "../src/channels/session.ts";
import { ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { type Harness, nextClientId, startHarness, TEST_AGENT } from "./harness.ts";
import { expectRpcError, must } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";

describe("handshake", () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness();
	});

	after(async () => {
		await harness.dispose();
	});

	it("negotiates the current version without following future SDK versions implicitly", async () => {
		assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ["1.0.0", "0.9.0"]);
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

	it("still serves a 0.9-only client's snapshots and actions", async () => {
		const client = await harness.connect();
		const clientId = nextClientId();
		const result = await client.initialize({
			clientId,
			protocolVersions: ["0.9.0"],
			initialSubscriptions: [ROOT_CHANNEL],
		});
		assert.equal(result.protocolVersion, "0.9.0");
		assert.equal(result.snapshots[0]?.resource, ROOT_CHANNEL);

		const session = sessionUri("old-client-action");
		harness.host.store.create(session, initialSessionState("pi", "Before", "/tmp"), "session");
		const { result: subscribed, subscription } = await client.subscribe(session);
		assert.equal((must(subscribed.snapshot).state as SessionState).status, SessionStatus.Idle);
		const sent = client.dispatch(session, { type: ActionType.SessionTitleChanged, title: "After" });
		const event = await subscription.next();
		assert.ok(!event.done && event.value.type === "action");
		assert.equal(event.value.params.origin?.clientSeq, sent.clientSeq);
		assert.equal(event.value.params.rejectionReason, undefined);
		assert.deepEqual(event.value.params.action, { type: ActionType.SessionTitleChanged, title: "After" });

		const lastSeenServerSeq = event.value.params.serverSeq;
		await client.shutdown();
		harness.host.dispatchServerAction(session, { type: ActionType.SessionTitleChanged, title: "Offline" });
		const resumed = await harness.connect();
		const replay = await resumed.reconnect({
			clientId,
			lastSeenServerSeq,
			subscriptions: [ROOT_CHANNEL, session],
		});
		assert.ok(replay.type === ReconnectResultType.Replay);
		assert.deepEqual(
			replay.actions.map((envelope) => envelope.action),
			[{ type: ActionType.SessionTitleChanged, title: "Offline" }],
		);
	});

	it("chooses the highest compatible offer regardless of client order", async () => {
		const client = await harness.connect();
		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: ["0.9.0", PROTOCOL_VERSION],
		});
		assert.equal(result.protocolVersion, PROTOCOL_VERSION);
	});

	it("accepts compatible patch versions and ignores unsupported offers", async () => {
		const client = await harness.connect();
		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: ["0.9.1", "99.0.0", "1.0.1"],
		});

		assert.equal(result.protocolVersion, "1.0.1");
	});

	it("rejects an older wire model with UnsupportedProtocolVersion", async () => {
		const client = await harness.connect();
		const error = await expectRpcError(
			client.initialize({ clientId: nextClientId(), protocolVersions: ["0.8.0"] }),
			AhpErrorCodes.UnsupportedProtocolVersion,
		);
		const data = error.data as { supportedVersions?: string[] } | undefined;
		assert.deepEqual(data?.supportedVersions, ["1.0.0", "0.9.0"]);
		await eventually("unsupported-version connection to close", () => client.connectionState.status === "closed");
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
			{ protocolVersions: ["01.0.0"] },
			{ protocolVersions: ["1.0.0", "1.0.0-beta.1"] },
			{ clientInfo: { name: 42 } },
			{ locale: 42 },
			{ capabilities: [] },
		]) {
			await expectRpcError(
				client.request("initialize", {
					channel: ROOT_CHANNEL,
					clientId: nextClientId(),
					protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
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
		await expectRpcError(client.request("listSessions", { channel: ROOT_CHANNEL }), JsonRpcErrorCodes.InvalidRequest);
	});

	it("rejects a second handshake without changing client compatibility mode", async () => {
		const client = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		const session = sessionUri("rejected-second-handshake");
		harness.host.store.create(session, initialSessionState("pi", "Still canonical", "/tmp"), "session");

		await expectRpcError(
			client.request("initialize", {
				channel: ROOT_CHANNEL,
				clientId: nextClientId(),
				protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
				clientInfo: { name: "vscode-editor-window" },
			}),
			JsonRpcErrorCodes.InvalidRequest,
		);

		assert.equal((await client.subscribe(session)).result.snapshot?.resource, session);
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
