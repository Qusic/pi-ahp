/** Validates and persists one client-owned webhook without broadcasting its body. */

import type { WebhookRegistrationHandler } from "../core/host.ts";
import type { MetadataStore } from "../pi/metadata-store.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { type WebhookRegistration, webhookRegistrationSchema } from "../protocol/webhook.ts";

export class WebhookRegistrationService implements WebhookRegistrationHandler {
	readonly #metadata: MetadataStore;
	readonly #registrations = new Map<string, WebhookRegistration>();

	constructor(metadata: MetadataStore) {
		this.#metadata = metadata;
		for (const { id, value } of metadata.clients.list("webhook")) {
			if (value) this.#registrations.set(id, value);
		}
	}

	entries(): IterableIterator<[string, WebhookRegistration]> {
		return this.#registrations.entries();
	}

	set(clientId: string, webhook: unknown): void {
		const parsed = webhookRegistrationSchema.safeParse(webhook);
		if (!parsed.success) throw ProtocolError.invalidParams("Invalid webhook URL or JSON body");
		if (parsed.data === null) {
			this.#metadata.clients.delete(clientId, "webhook");
			this.#registrations.delete(clientId);
		} else {
			this.#metadata.clients.set(clientId, "webhook", parsed.data);
			this.#registrations.set(clientId, parsed.data);
		}
	}
}
