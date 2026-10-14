/** Send webhooks for effective turn results, even after the registering client disconnects. */

import { basename } from "node:path";
import { MessageKind } from "@microsoft/agent-host-protocol";
import type { SessionRegistry } from "../pi/session-registry.ts";
import { sendWebhook } from "./webhook-delivery.ts";
import type { WebhookRegistrationService } from "./webhook-registration.ts";

const MAX_WORKSPACE_LENGTH = 40;
const MAX_DETAIL_LENGTH = 80;

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	let prefix = "";
	for (const char of text) {
		if (prefix.length + char.length >= limit) break;
		prefix += char;
	}
	return `${prefix}…`;
}

export class WebhookNotifications {
	readonly #unsubscribe: () => void;

	constructor(sessions: SessionRegistry, registrations: WebhookRegistrationService, log?: (message: string) => void) {
		this.#unsubscribe = sessions.onTurnResult(({ session, outcome, message }) => {
			const event = outcome === "complete" ? "ready" : "error";
			const workspace = truncate(basename(sessions.get(session)?.workingDirectory ?? ""), MAX_WORKSPACE_LENGTH);
			const detail = truncate(message.origin.kind === MessageKind.User ? message.text : "", MAX_DETAIL_LENGTH);
			for (const [clientId, registration] of registrations.activeEntries()) {
				void sendWebhook(registration, { session, event, workspace, detail }).catch((error) => {
					log?.(`webhook ${event} for ${session} to client ${clientId} failed: ${String(error)}`);
				});
			}
		});
	}

	dispose(): void {
		this.#unsubscribe();
	}
}
