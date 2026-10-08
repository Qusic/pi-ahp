/** The optional webhook control plane, before any delivery or event wiring. */

import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { JsonRpcErrorCodes, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { ROOT_CHANNEL } from "../src/core/channels.ts";
import { WebhookRegistrationService } from "../src/host/webhook-registration.ts";
import { MetadataStore } from "../src/pi/metadata-store.ts";
import type { WebhookRegistration } from "../src/protocol/webhook.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";
import { expectRpcError } from "./support/assertions.ts";

const METHOD = "x-qusic/ahp-webhook/set";

const webhook: WebhookRegistration = {
	url: "https://example.test/push?key=private",
	body: { device: "test-device", session: "$session", event: "$event", detail: "$detail" },
};

function setWebhook(client: AhpClient, value: unknown, channel = ROOT_CHANNEL): Promise<null> {
	// The official SDK's CommandMap intentionally does not type custom methods.
	return client.request(METHOD as never, { channel, webhook: value } as never) as Promise<null>;
}

async function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-webhook-"));
	let harness: Harness | undefined;
	t.after(async () => {
		try {
			await harness?.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	const start = async () => {
		harness = await startHarness();
		const metadata = new MetadataStore(join(root, "ahp"));
		harness.host.serve({ webhooks: new WebhookRegistrationService(metadata) });
		return { harness, metadata };
	};
	return {
		...(await start()),
		restart: async () => {
			await harness?.dispose();
			harness = undefined;
			return start();
		},
	};
}

it("only advertises the extension when its handler is installed", async (t) => {
	const bare = await startHarness();
	t.after(() => bare.dispose());
	const uninitialized = await bare.connect();
	await expectRpcError(setWebhook(uninitialized, webhook), JsonRpcErrorCodes.InvalidRequest);
	const client = await bare.connect();
	const result = await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	assert.equal(result._meta?.["me.qusic.ahp-webhook"], undefined);
	await expectRpcError(setWebhook(client, webhook), JsonRpcErrorCodes.MethodNotFound);
});

it("persists independent registrations across both AHP versions, replacement, clearing and restart", async (t) => {
	const f = await fixture(t);
	const first = await f.harness.connect();
	const second = await f.harness.connect();
	const firstId = nextClientId();
	const secondId = nextClientId();
	for (const [client, id, versions] of [
		[first, firstId, ["1.0.0"]],
		[second, secondId, ["0.9.0"]],
	] as const) {
		const result = await client.initialize({ clientId: id, protocolVersions: versions });
		assert.equal(result._meta?.["me.qusic.ahp-webhook"], 1);
	}
	assert.equal(await setWebhook(first, webhook), null);
	for (const body of [["$session", { type: "$event" }], null]) {
		const value = { ...webhook, body };
		assert.equal(await setWebhook(second, value), null);
		assert.deepEqual(f.metadata.clients.get(secondId, "webhook"), value);
	}
	const replacement = { ...webhook, body: { device: "rotated", detail: "$detail" } };
	assert.equal(await setWebhook(first, replacement), null);
	assert.deepEqual(f.metadata.clients.get(firstId, "webhook"), replacement);

	assert.equal(await setWebhook(first, null), null);
	assert.equal(await setWebhook(first, null), null, "clearing an absent registration is idempotent");
	assert.equal(f.metadata.clients.get(firstId, "webhook"), null);
	const restarted = await f.restart();
	assert.equal(restarted.metadata.clients.get(firstId, "webhook"), null);
	assert.deepEqual(restarted.metadata.clients.get(secondId, "webhook"), { ...webhook, body: null });
});

it("accepts loopback HTTP and rejects other insecure or malformed registrations", async (t) => {
	const f = await fixture(t);
	const client = await f.harness.connect();
	const id = nextClientId();
	await client.initialize({ clientId: id, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	await expectRpcError(setWebhook(client, webhook, "ahp-session:/wrong"), JsonRpcErrorCodes.InvalidParams);
	await expectRpcError(
		client.request(METHOD as never, { channel: ROOT_CHANNEL } as never),
		JsonRpcErrorCodes.InvalidParams,
	);
	for (const url of ["http://localhost:8080/push", "http://127.0.0.1:8080/push", "http://[::1]:8080/push"]) {
		assert.equal(await setWebhook(client, { ...webhook, url }), null);
		assert.equal(f.metadata.clients.get(id, "webhook")?.url, url);
	}
	const urlPrefix = "https://example.test/";
	const maxUrl = `${urlPrefix}${"x".repeat(2_048 - urlPrefix.length)}`;
	assert.equal(await setWebhook(client, { ...webhook, url: maxUrl }), null);
	assert.equal(f.metadata.clients.get(id, "webhook")?.url, maxUrl);
	const maxBody = "x".repeat(16_384 - 2); // JSON quotes make the serialized root string exactly 16 KiB.
	assert.equal(await setWebhook(client, { ...webhook, body: maxBody }), null);
	assert.equal(f.metadata.clients.get(id, "webhook")?.body, maxBody);
	await setWebhook(client, null);
	for (const invalid of [
		{ ...webhook, url: "http://localhost.evil.test/push" },
		{ ...webhook, url: "http://192.168.1.2/push" },
		{ ...webhook, url: "https://user:pass@example.test/push" },
		{ ...webhook, url: `${maxUrl}x` },
		{ ...webhook, url: "https://example.test/push#fragment" },
		{ ...webhook, body: undefined },
		{ ...webhook, body: `${maxBody}x` },
		{ ...webhook, extra: "unsupported" },
	]) {
		await expectRpcError(setWebhook(client, invalid), JsonRpcErrorCodes.InvalidParams);
	}
	assert.equal(f.metadata.clients.get(id, "webhook"), null);
});

it("does not acknowledge a failed replacement or clear", async (t) => {
	const f = await fixture(t);
	const client = await f.harness.connect();
	const id = nextClientId();
	await client.initialize({ clientId: id, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	await setWebhook(client, webhook);

	const rename = t.mock.method(fs, "renameSync", () => {
		throw new Error("webhook storage unavailable");
	});
	try {
		await expectRpcError(
			setWebhook(client, { ...webhook, body: { event: "$event" } }),
			JsonRpcErrorCodes.InternalError,
		);
	} finally {
		rename.mock.restore();
	}
	assert.deepEqual(f.metadata.clients.get(id, "webhook"), webhook);

	const unlink = t.mock.method(fs, "unlinkSync", () => {
		throw new Error("webhook removal unavailable");
	});
	try {
		await expectRpcError(setWebhook(client, null), JsonRpcErrorCodes.InternalError);
	} finally {
		unlink.mock.restore();
	}
	assert.deepEqual(f.metadata.clients.get(id, "webhook"), webhook);
});
