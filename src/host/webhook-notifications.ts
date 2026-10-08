/** Send webhooks for effective turn results, even after the registering client disconnects. */

import { MessageKind } from "@microsoft/agent-host-protocol";
import type { SessionRegistry } from "../pi/session-registry.ts";
import { sendWebhook } from "./webhook-delivery.ts";
import type { WebhookRegistrationService } from "./webhook-registration.ts";

export class WebhookNotifications {
	readonly #unsubscribe: () => void;

	constructor(sessions: SessionRegistry, registrations: WebhookRegistrationService, log?: (message: string) => void) {
		this.#unsubscribe = sessions.onTurnResult(({ session, outcome, message }) => {
			const event = outcome === "complete" ? "ready" : "error";
			const detail = message.origin.kind === MessageKind.User ? message.text : "";
			for (const [clientId, registration] of registrations.entries()) {
				void sendWebhook(registration, { session, event, detail }).catch((error) => {
					log?.(`webhook ${event} for ${session} to client ${clientId} failed: ${String(error)}`);
				});
			}
		});
	}

	dispose(): void {
		this.#unsubscribe();
	}
}
