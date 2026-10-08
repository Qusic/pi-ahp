/** Committed Pi-host turn outcomes drive offline client webhooks, not subscriptions. */

import assert from "node:assert/strict";
import { it } from "node:test";
import { ActionType, type ChatState, MessageKind, ResponsePartKind, TurnState } from "@microsoft/agent-host-protocol";
import { WebhookNotifications } from "../src/host/webhook-notifications.ts";
import { WebhookRegistrationService } from "../src/host/webhook-registration.ts";
import { archiveSessionFixture } from "./support/archive-session.ts";
import { eventually } from "./support/async.ts";

it("delivers each effective ready/error outcome to an offline client, but not cancelled or duplicate turns", async (t) => {
	const f = await archiveSessionFixture(t);
	const registrations = new WebhookRegistrationService(f.metadata);
	const notifications = new WebhookNotifications(f.sessions, registrations);
	t.after(() => notifications.dispose());
	registrations.set("offline-client", {
		url: "https://example.test/push",
		body: { session: "$session", event: "$event", detail: "$detail" },
	});
	const post = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
	const start = (turnId: string, text: string) =>
		f.initialHost.dispatchServerAction(f.chat, {
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: f.timestamp.toISOString(),
			message: { text, origin: { kind: MessageKind.User } },
		});
	const complete = (turnId: string) =>
		f.initialHost.dispatchServerAction(f.chat, { type: ActionType.ChatTurnComplete, turnId, duration: 1000 });
	const bodyAt = (index: number) => {
		const call = post.mock.calls[index];
		assert.ok(call);
		const init = call.arguments[1];
		assert.ok(init);
		return JSON.parse(String(init.body));
	};

	start("first", 'Fix "quotes"\nand the next line');
	complete("first");
	await eventually("ready webhook to start", () => post.mock.callCount() > 0);
	assert.equal(post.mock.callCount(), 1);
	assert.deepEqual(bodyAt(0), {
		session: f.session,
		event: "ready",
		detail: 'Fix "quotes"\nand the next line',
	});
	complete("first");
	assert.equal(post.mock.callCount(), 1, "a repeated terminal action is not another outcome");

	start("cancelled", "do not notify");
	f.initialHost.dispatchServerAction(f.chat, {
		type: ActionType.ChatTurnCancelled,
		turnId: "cancelled",
		duration: 1000,
	});
	assert.equal(post.mock.callCount(), 1);

	start("failed", "Newest user request");
	f.initialHost.dispatchServerAction(f.chat, {
		type: ActionType.ChatError,
		turnId: "failed",
		duration: 1000,
		part: { kind: ResponsePartKind.Error, error: { errorType: "test", message: "failed" } },
	});
	await eventually("error webhook to start", () => post.mock.callCount() > 1);
	assert.equal(post.mock.callCount(), 2);
	assert.deepEqual(bodyAt(1), { session: f.session, event: "error", detail: "Newest user request" });

	registrations.set("offline-client", null);
	start("after-clear", "not delivered");
	complete("after-clear");
	assert.equal(post.mock.callCount(), 2);
});

it("loads and fans out persisted registrations without their clients reconnecting", async (t) => {
	const f = await archiveSessionFixture(t);
	for (const [id, url] of [
		["first-client", "https://example.test/first"],
		["second-client", "https://example.test/second"],
	] as const) {
		f.metadata.clients.set(id, "webhook", { url, body: { event: "$event" } });
	}
	const registrations = new WebhookRegistrationService(f.metadata);
	const notifications = new WebhookNotifications(f.sessions, registrations);
	t.after(() => notifications.dispose());
	const post = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
	f.initialHost.dispatchServerAction(f.chat, {
		type: ActionType.ChatTurnStarted,
		turnId: "persisted",
		startedAt: f.timestamp.toISOString(),
		message: { text: "hello", origin: { kind: MessageKind.User } },
	});
	f.initialHost.dispatchServerAction(f.chat, {
		type: ActionType.ChatTurnComplete,
		turnId: "persisted",
		duration: 1000,
	});
	await eventually("both persisted webhooks to start", () => post.mock.callCount() >= 2);
	assert.deepEqual(post.mock.calls.map((call) => call.arguments[0]).sort(), [
		"https://example.test/first",
		"https://example.test/second",
	]);
});

it("does not wait for a webhook or let delivery failure undo a completed turn", async (t) => {
	const f = await archiveSessionFixture(t);
	const registrations = new WebhookRegistrationService(f.metadata);
	registrations.set("offline-client", { url: "https://example.test/push", body: { event: "$event" } });
	const logs: string[] = [];
	const notifications = new WebhookNotifications(f.sessions, registrations, (message) => logs.push(message));
	t.after(() => notifications.dispose());
	const pending = Promise.withResolvers<Response>();
	const post = t.mock.method(globalThis, "fetch", () => pending.promise);
	try {
		f.initialHost.dispatchServerAction(f.chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "slow-webhook",
			startedAt: f.timestamp.toISOString(),
			message: { text: "hello", origin: { kind: MessageKind.User } },
		});
		f.initialHost.dispatchServerAction(f.chat, {
			type: ActionType.ChatTurnComplete,
			turnId: "slow-webhook",
			duration: 1000,
		});
		assert.equal((f.initialHost.store.get(f.chat) as ChatState).activeTurn, undefined);
		await eventually("slow webhook to start", () => post.mock.callCount() > 0);
		assert.equal(post.mock.callCount(), 1);
		pending.reject(new Error("delivery unavailable"));
		await eventually("webhook failure to be logged", () => logs.length === 1);
		assert.match(logs[0] ?? "", /Webhook request failed/u);
		assert.equal((f.initialHost.store.get(f.chat) as ChatState).turns.at(-1)?.state, TurnState.Complete);
		assert.equal(post.mock.callCount(), 1);
	} finally {
		pending.resolve(new Response(null, { status: 204 }));
	}
});
