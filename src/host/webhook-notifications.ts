/** Send webhooks for effective turn results, even after the registering client disconnects. */

import { basename } from "node:path";
import { MessageKind } from "@microsoft/agent-host-protocol";
import type { SessionRegistry } from "../pi/session-registry.ts";
import { sendWebhook } from "./webhook-delivery.ts";
import type { WebhookRegistrationService } from "./webhook-registration.ts";

const MAX_DETAIL_GRAPHEMES = 240;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncateDetail(detail: string): string {
	const segments = segmenter.segment(detail)[Symbol.iterator]();
	let prefix = "";
	for (let index = 0; index < MAX_DETAIL_GRAPHEMES - 1; index++) {
		const next = segments.next();
		if (next.done) return detail;
		prefix += next.value.segment;
	}
	const last = segments.next();
	return last.done || segments.next().done ? detail : `${prefix}…`;
}

export class WebhookNotifications {
	readonly #unsubscribe: () => void;

	constructor(sessions: SessionRegistry, registrations: WebhookRegistrationService, log?: (message: string) => void) {
		this.#unsubscribe = sessions.onTurnResult(({ session, outcome, message }) => {
			const event = outcome === "complete" ? "ready" : "error";
			const workspace = basename(sessions.get(session)?.workingDirectory ?? "");
			const detail = truncateDetail(message.origin.kind === MessageKind.User ? message.text : "");
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
