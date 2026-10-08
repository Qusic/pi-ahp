/** The namespaced AHP extension for client-owned webhook registrations. */

import { z } from "zod";

export const WEBHOOK_SET_METHOD = "x-qusic/ahp-webhook/set";
export const WEBHOOK_CAPABILITY = "me.qusic.ahp-webhook";
export const WEBHOOK_CAPABILITY_VERSION = 1;

const MAX_URL_LENGTH = 2 * 1024;
const MAX_BODY_BYTES = 16 * 1024;

function isWebhookUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
		return (
			(url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
			!url.username &&
			!url.password &&
			!url.hash
		);
	} catch {
		return false;
	}
}

/** Only full JSON values "$session", "$event" and "$detail" are replaced when sending. */
export const webhookRegistrationSchema = z
	.strictObject({
		url: z.string().max(MAX_URL_LENGTH).refine(isWebhookUrl),
		body: z.json().refine((body) => Buffer.byteLength(JSON.stringify(body), "utf8") <= MAX_BODY_BYTES),
	})
	.nullable();

export type WebhookRegistration = NonNullable<z.infer<typeof webhookRegistrationSchema>>;
