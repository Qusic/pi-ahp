/**
 * The session channel — `ahp-session:/<uuid>`.
 *
 * A session is the coordination scope; the conversation itself lives on a chat
 * channel underneath it. Creation is asynchronous by design: the host returns
 * immediately with `lifecycle: 'creating'` and dispatches `session/ready` (or
 * `session/creationFailed`) once the backend is up, so a slow agent start never
 * blocks the client's round-trip.
 *
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/session-channel
 */

import {
	SessionLifecycle,
	type SessionState,
	SessionStatus,
	type SessionSummary,
	type URI,
} from "@microsoft/agent-host-protocol";
import { pathToFileUri } from "../core/uri.ts";

export function initialSessionState(provider: string, title: string, workingDirectory: string): SessionState {
	return {
		provider,
		title,
		status: SessionStatus.Idle,
		lifecycle: SessionLifecycle.Creating,
		workingDirectories: [pathToFileUri(workingDirectory)],
		activeClients: [],
		chats: [],
	};
}

export function sessionSummaryOf(
	resource: URI,
	createdAt: string,
	state: SessionState,
	meta?: Record<string, unknown>,
): SessionSummary {
	return {
		resource,
		provider: state.provider,
		title: state.title,
		status: state.status,
		createdAt,
		modifiedAt: new Date().toISOString(),
		...(state.workingDirectories ? { workingDirectories: state.workingDirectories } : {}),
		...(meta ? { _meta: meta } : {}),
	};
}
