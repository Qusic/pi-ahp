/** Validates and persists one client-owned webhook without broadcasting its body. */

import type { WebhookRegistrationHandler } from "../core/host.ts";
import type { MetadataStore } from "../pi/metadata-store.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { type WebhookRegistration, webhookRegistrationSchema } from "../protocol/webhook.ts";

const LEASE_MS = 24 * 60 * 60 * 1000;

type StoredWebhook = { readonly registration: WebhookRegistration; readonly setAt: number };

export class WebhookRegistrationService implements WebhookRegistrationHandler {
	readonly #metadata: MetadataStore;
	readonly #registrations = new Map<string, StoredWebhook>();

	constructor(metadata: MetadataStore) {
		this.#metadata = metadata;
		for (const { id, value } of metadata.clients.list("webhook")) {
			if (value) this.#registrations.set(id, value);
		}
	}

	*activeEntries(): IterableIterator<[string, WebhookRegistration]> {
		const cutoff = Date.now() - LEASE_MS;
		for (const [clientId, value] of this.#registrations) {
			if (value.setAt > cutoff) yield [clientId, value.registration];
		}
	}

	set(clientId: string, webhook: unknown): void {
		const parsed = webhookRegistrationSchema.safeParse(webhook);
		if (!parsed.success) throw ProtocolError.invalidParams("Invalid webhook URL or JSON body");
		if (parsed.data === null) {
			this.#metadata.clients.delete(clientId, "webhook");
			this.#registrations.delete(clientId);
		} else {
			const value = { registration: parsed.data, setAt: Date.now() };
			this.#metadata.clients.set(clientId, "webhook", value);
			this.#registrations.set(clientId, value);
		}
	}
}
