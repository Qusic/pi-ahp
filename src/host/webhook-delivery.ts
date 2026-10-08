/** Render a client-owned JSON template and send one best-effort webhook request. */

import type { URI } from "@microsoft/agent-host-protocol";
import type { WebhookRegistration } from "../protocol/webhook.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface WebhookContext {
	readonly session: URI;
	readonly event: "ready" | "error" | "input" | "confirmation";
	readonly detail: string;
}

export function renderWebhookBody(body: WebhookRegistration["body"], context: WebhookContext): string {
	const serialized = JSON.stringify(body, (_key, value: unknown) => {
		switch (value) {
			case "$session":
				return context.session;
			case "$event":
				return context.event;
			case "$detail":
				return context.detail;
			default:
				return value;
		}
	});
	if (serialized === undefined) throw new Error("Webhook body must be JSON");
	if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
		throw new Error("Webhook JSON body exceeds the request limit");
	}
	return serialized;
}

/** One POST per call. The eventual event observer owns failures and concurrency. */
export async function sendWebhook(registration: WebhookRegistration, context: WebhookContext): Promise<void> {
	const body = renderWebhookBody(registration.body, context);
	const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await globalThis.fetch(registration.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal,
			redirect: "error",
		});
	} catch (error) {
		throw new Error(signal.aborted ? "Webhook request timed out" : "Webhook request failed", {
			cause: error,
		});
	}
	// The response body is irrelevant; release it without waiting on the peer's stream.
	void response.body?.cancel().catch(() => undefined);
	if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
}
