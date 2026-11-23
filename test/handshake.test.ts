/**
 * Connection handshake and pre-handshake request policy.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/lifecycle
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import type { RootState } from "@microsoft/agent-host-protocol";
import {
	ActionType,
	AhpErrorCodes,
	JsonRpcErrorCodes,
	negotiateProtocolVersion,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import WebSocket from "ws";
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

	it("answers initialize with the version the SDK selects", async () => {
		const client = await harness.connect();
		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
		});

		assert.equal(result.protocolVersion, negotiateProtocolVersion(SUPPORTED_PROTOCOL_VERSIONS));
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

	it("refuses an offer it cannot speak with UnsupportedProtocolVersion", async () => {
		const client = await harness.connect();
		const error = await expectRpcError(
			client.initialize({ clientId: nextClientId(), protocolVersions: ["99.0.0"] }),
			AhpErrorCodes.UnsupportedProtocolVersion,
		);
		const data = error.data as { supportedVersions?: string[] } | undefined;
		assert.deepEqual(data?.supportedVersions, SUPPORTED_PROTOCOL_VERSIONS);
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
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
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

	it("rejects a second handshake and keeps the connection usable", async () => {
		const client = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

		await expectRpcError(
			client.request("initialize", {
				channel: ROOT_CHANNEL,
				clientId: nextClientId(),
				protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
			}),
			JsonRpcErrorCodes.InvalidRequest,
		);

		assert.equal((await client.subscribe(ROOT_CHANNEL)).result.snapshot?.resource, ROOT_CHANNEL);
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

		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
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
				initialSubscriptions: [canonical, 42],
			} as never),
			JsonRpcErrorCodes.InvalidParams,
		);

		const result = await client.initialize({
			clientId: nextClientId(),
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [canonical],
		});
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
				await client.initialize({
					clientId: nextClientId(),
					protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
				});
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

	it("rejects browser origins without a token, including a tunnel-derived tkn", async () => {
		const harness = await startHarness();
		try {
			for (const query of ["", "?tkn=tunnel-derived"]) {
				const socket = new WebSocket(`${harness.url}${query}`, { origin: "https://untrusted.example" });
				socket.on("error", () => {});
				try {
					await assert.rejects(once(socket, "open"), /Unexpected server response: 403/u);
				} finally {
					socket.terminate();
				}
			}
			const client = await harness.connect();
			await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
			await client.ping();
		} finally {
			await harness.dispose();
		}
	});

	it("allows browser origins when a valid connection token is supplied", async () => {
		const harness = await startHarness({ connectionToken: "secret" });
		const socket = new WebSocket(harness.url, { origin: "https://client.example" });
		try {
			await once(socket, "open");
			assert.equal(socket.readyState, WebSocket.OPEN);
		} finally {
			socket.terminate();
			await harness.dispose();
		}
	});

	it("ignores a VS Code tkn when the listener requires no token", async () => {
		const harness = await startHarness();
		try {
			const client = await harness.connectWith("?tkn=legacy-tunnel-value");
			await client.initialize({
				clientId: nextClientId(),
				protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			});
		} finally {
			await harness.dispose();
		}
	});
});

describe("WebSocket frame errors", () => {
	it("closes a malformed peer without stopping AHP", async () => {
		const harness = await startHarness();
		const malformed = new WebSocket(harness.url);
		malformed.on("error", () => {});
		try {
			await once(malformed, "open");
			const closed = Promise.withResolvers<number>();
			const timeout = setTimeout(() => closed.reject(new Error("malformed peer was not closed")), 5_000);
			malformed.once("close", (code) => closed.resolve(code));
			try {
				// A WebSocket client must mask its frames. ws will reject this one.
				malformed.send("{}", { mask: false });
				assert.equal(await closed.promise, 1002);
			} finally {
				clearTimeout(timeout);
			}

			const client = await harness.connect();
			await client.initialize({
				clientId: nextClientId(),
				protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			});
			await client.ping();
		} finally {
			malformed.terminate();
			await harness.dispose();
		}
	});
});
