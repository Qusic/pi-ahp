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
	type ChatSummary,
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

/** Bits 0–4 are mutually exclusive activity; later bits are session metadata. */
const STATUS_ACTIVITY_MASK = (1 << 5) - 1;

interface SessionChatAggregate {
	readonly status: SessionStatus;
	readonly activity?: string;
	readonly modifiedAt?: string;
}

function timestamp(summary: ChatSummary): number {
	const value = Date.parse(summary.modifiedAt);
	return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function mostRecent(chats: readonly ChatSummary[], matches: (chat: ChatSummary) => boolean): ChatSummary | undefined {
	let latest: ChatSummary | undefined;
	for (const chat of chats) {
		if (matches(chat) && (!latest || timestamp(chat) > timestamp(latest))) {
			latest = chat;
		}
	}
	return latest;
}

/**
 * Projects the session-level summary fields AHP derives from its chat catalog.
 *
 * The current host exposes one chat, so this is a direct pass-through today.
 * Keeping the complete 0.9 rule here makes the projection deterministic and
 * avoids teaching the pi adapter about protocol status bits.
 */
export function aggregateSessionChats(state: SessionState): SessionChatAggregate {
	if (state.chats.length === 0) {
		return {
			status: state.status,
			...(state.activity !== undefined ? { activity: state.activity } : {}),
		};
	}

	const latest = mostRecent(state.chats, () => true);
	if (!latest) {
		return { status: state.status };
	}
	let driver = state.chats.find((chat) => chat.resource === state.defaultChat) ?? latest;
	const inputNeeded = mostRecent(
		state.chats,
		(chat) => (chat.status & SessionStatus.InputNeeded) === SessionStatus.InputNeeded,
	);
	const error = mostRecent(state.chats, (chat) => (chat.status & SessionStatus.Error) === SessionStatus.Error);
	if (inputNeeded) {
		driver = inputNeeded;
	} else if (error) {
		driver = error;
	}

	const metadataBits = state.status & ~STATUS_ACTIVITY_MASK;
	const activityBits = driver.status & STATUS_ACTIVITY_MASK;
	return {
		status: (metadataBits | activityBits) as SessionStatus,
		...(driver.activity !== undefined ? { activity: driver.activity } : {}),
		modifiedAt: latest.modifiedAt,
	};
}

export function sessionSummaryOf(
	resource: URI,
	createdAt: string,
	state: SessionState,
	meta?: Record<string, unknown>,
): SessionSummary {
	const aggregate = aggregateSessionChats(state);
	return {
		resource,
		provider: state.provider,
		title: state.title,
		status: aggregate.status,
		// Root summary activity is deliberately omitted for AHP 0.9: its partial
		// update shape cannot distinguish "clear" from "unchanged" on JSON wire.
		createdAt,
		modifiedAt: aggregate.modifiedAt ?? createdAt,
		...(state.workingDirectories ? { workingDirectories: state.workingDirectories } : {}),
		...(meta ? { _meta: meta } : {}),
	};
}
