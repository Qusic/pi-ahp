/**
 * The root channel — `ahp-root://`.
 *
 * Exactly one root channel exists per host. It carries the agents this host can
 * speak to plus host-level config. The session catalogue is deliberately *not*
 * root state: clients fetch it with `listSessions` and patch it from
 * `root/session*` notifications.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/root-channel
 */

import type { AgentInfo, RootState, SessionSummary, URI } from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL } from "../core/channels.ts";
import type { AhpHost } from "../core/host.ts";

export function initialRootState(agents: AgentInfo[] = []): RootState {
	return { agents, activeSessions: 0 };
}

/** Registers `ahp-root://` on the host. Must run before any client connects. */
export function installRootChannel(host: AhpHost, agents: AgentInfo[] = []): void {
	host.store.create(ROOT_CHANNEL, initialRootState(agents));
}

// ── Catalogue notifications ───────────────────────────────────────────────
// Ephemeral and never replayed on reconnect; after reconnecting a client
// re-fetches the catalogue with `listSessions`.

export function notifySessionAdded(host: AhpHost, summary: SessionSummary): void {
	host.notify(ROOT_CHANNEL, "root/sessionAdded", { summary });
}

export function notifySessionRemoved(host: AhpHost, session: URI): void {
	host.notify(ROOT_CHANNEL, "root/sessionRemoved", { session });
}

export function notifySessionSummaryChanged(host: AhpHost, session: URI, changes: Partial<SessionSummary>): void {
	host.notify(ROOT_CHANNEL, "root/sessionSummaryChanged", { session, changes });
}
