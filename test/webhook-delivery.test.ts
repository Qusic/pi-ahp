/** Rendering and HTTP delivery without Pi sessions or an external webhook endpoint. */

import assert from "node:assert/strict";
import { it } from "node:test";
import { renderWebhookBody, sendWebhook, type WebhookContext } from "../src/host/webhook-delivery.ts";
import type { WebhookRegistration } from "../src/protocol/webhook.ts";

const context: WebhookContext = {
	session: "ahp-session:/test-session",
	event: "ready",
	detail: 'Line one\n"quoted" text',
};
const registration: WebhookRegistration = {
	url: "https://example.test/push?key=client-owned",
	body: { session: "$session", event: "$event", detail: "$detail" },
};

it("replaces only complete JSON values, including the root, without losing JSON escaping", () => {
	const body = {
		$event: "$event",
		literal: "prefix-$session",
		nested: ["$session", { detail: "$detail" }, null, 42],
	};
	assert.deepEqual(JSON.parse(renderWebhookBody(body, context)), {
		$event: "ready",
		literal: "prefix-$session",
		nested: [context.session, { detail: context.detail }, null, 42],
	});
	assert.equal(renderWebhookBody("$detail", context), JSON.stringify(context.detail));
	assert.equal(renderWebhookBody(null, context), "null");
});

it("POSTs JSON to the client URL once without following redirects", async (t) => {
	const post = t.mock.method(globalThis, "fetch", async () => new Response("accepted", { status: 200 }));
	await sendWebhook(registration, context);
	assert.equal(post.mock.callCount(), 1);
	const call = post.mock.calls[0];
	assert.ok(call);
	const [url, init] = call.arguments;
	assert.equal(url, registration.url);
	assert.ok(init);
	assert.equal(init.method, "POST");
	assert.deepEqual(init.headers, { "Content-Type": "application/json" });
	assert.equal(init.redirect, "error");
	assert.ok(init.signal instanceof AbortSignal);
	assert.deepEqual(JSON.parse(String(init.body)), {
		session: context.session,
		event: context.event,
		detail: context.detail,
	});
});

it("reports HTTP and transport failures without retrying or exposing the URL", async (t) => {
	let failTransport = false;
	const post = t.mock.method(globalThis, "fetch", async () => {
		if (failTransport) throw new Error(`Could not fetch ${registration.url}`);
		return new Response("private response", { status: 503 });
	});
	await assert.rejects(sendWebhook(registration, context), /Webhook returned HTTP 503/u);
	assert.equal(post.mock.callCount(), 1);
	failTransport = true;
	await assert.rejects(sendWebhook(registration, context), (reason: unknown) => {
		assert.equal((reason as Error).message, "Webhook request failed");
		return true;
	});
	assert.equal(post.mock.callCount(), 2);
});

it("handles timeout and refuses oversized output before fetching", async (t) => {
	const deadline = t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort());
	const post = t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
		assert.ok(init?.signal?.aborted);
		throw new Error("aborted");
	});
	await assert.rejects(sendWebhook(registration, context), /Webhook request timed out/u);
	assert.deepEqual(
		deadline.mock.calls.map((call) => call.arguments),
		[[5_000]],
	);
	assert.equal(post.mock.callCount(), 1);
	await assert.rejects(
		sendWebhook({ ...registration, body: "$detail" }, { ...context, detail: "x".repeat(64 * 1024) }),
		/request limit/u,
	);
	assert.equal(post.mock.callCount(), 1);
});
