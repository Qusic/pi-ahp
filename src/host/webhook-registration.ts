/** Validates and persists one client-owned webhook without broadcasting its body. */

import type { WebhookRegistrationHandler } from "../core/host.ts";
import type { MetadataStore } from "../pi/metadata-store.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { webhookRegistrationSchema } from "../protocol/webhook.ts";

export class WebhookRegistrationService implements WebhookRegistrationHandler {
	readonly #metadata: MetadataStore;

	constructor(metadata: MetadataStore) {
		this.#metadata = metadata;
	}

	set(clientId: string, webhook: unknown): void {
		const parsed = webhookRegistrationSchema.safeParse(webhook);
		if (!parsed.success) throw ProtocolError.invalidParams("Invalid webhook URL or JSON body");
		if (parsed.data === null) {
			this.#metadata.clients.delete(clientId, "webhook");
		} else {
			this.#metadata.clients.set(clientId, "webhook", parsed.data);
		}
	}
}
