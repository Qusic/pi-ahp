/**
 * Channel URI scheme helpers.
 *
 * Channels are the routing key for the whole protocol: every command and every
 * notification carries `params.channel`, so `(method, channel)` is enough to
 * dispatch a message.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/subscriptions
 */

import type { URI } from "@microsoft/agent-host-protocol";

export const ROOT_CHANNEL = "ahp-root://";

const SESSION_SCHEME = "ahp-session:";
const CHAT_SCHEME = "ahp-chat:";
const TERMINAL_SCHEME = "ahp-terminal:";
const CHANGESET_SCHEME = "ahp-changeset:";
export const RESOURCE_WATCH_SCHEME = "ahp-resource-watch:";

export type ChannelKind = "root" | "session" | "chat" | "terminal" | "changeset" | "resourceWatch";

function isRootChannel(uri: URI): boolean {
	return uri === ROOT_CHANNEL;
}

function isSessionChannel(uri: URI): boolean {
	return uri.startsWith(`${SESSION_SCHEME}/`);
}

export function isChatChannel(uri: URI): boolean {
	return uri.startsWith(`${CHAT_SCHEME}/`);
}

/**
 * Classifies a channel URI, or `undefined` for a scheme this host does not
 * serve.
 *
 * Deliberately strict: it drives `subscribe`, where guessing wrong would create
 * a channel with the wrong reducer. Session URIs with a non-standard scheme are
 * handled by {@link permissiveSessionId} on the paths that know they are
 * dealing with a session.
 */
export function channelKind(uri: URI): ChannelKind | undefined {
	if (isRootChannel(uri)) {
		return "root";
	}
	if (isSessionChannel(uri)) {
		return "session";
	}
	if (isChatChannel(uri)) {
		return "chat";
	}
	if (uri.startsWith(`${TERMINAL_SCHEME}/`)) {
		return "terminal";
	}
	if (uri.startsWith(`${CHANGESET_SCHEME}/`)) {
		return "changeset";
	}
	if (uri.startsWith(`${RESOURCE_WATCH_SCHEME}/`)) {
		return "resourceWatch";
	}
	return undefined;
}

/** `ahp-session:/<id>` → `<id>`. Returns `undefined` when the URI is not a session. */
function sessionIdFromUri(uri: URI): string | undefined {
	return isSessionChannel(uri) ? uri.slice(`${SESSION_SCHEME}/`.length) || undefined : undefined;
}

/** Schemes that are definitely not a session, so a permissive parse can rule them out. */
const NON_SESSION_SCHEMES = new Set([
	"ahp-root",
	CHAT_SCHEME.slice(0, -1),
	TERMINAL_SCHEME.slice(0, -1),
	CHANGESET_SCHEME.slice(0, -1),
	RESOURCE_WATCH_SCHEME.slice(0, -1),
	"ahp-otlp",
	"file",
	"http",
	"https",
]);

/**
 * Extracts a session id from a URI, tolerating a non-standard scheme.
 *
 * The spec says a session lives at `ahp-session:/<uuid>`, but the reference
 * host does not enforce it: its provider mints the session URI and a mismatch
 * with the client's requested `channel` is only logged
 * (`protocolServerHandler.ts`). Real clients learned the older
 * `<provider>:/<uuid>` shape from that behaviour and still send it — an iOS
 * client tested against VS Code opens sessions as `pi:/<uuid>`.
 *
 * Rejecting those would be defensible and useless. The id is the only part this
 * host needs, so any single-segment URI whose scheme is not some other channel
 * type is read as a session.
 */
export function permissiveSessionId(uri: URI): string | undefined {
	const standard = sessionIdFromUri(uri);
	if (standard) {
		return standard;
	}
	const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/{1,3}([^/?#]+)$/.exec(uri);
	if (!match) {
		return undefined;
	}
	// Both groups are non-optional in the pattern, so a match guarantees them;
	// `noUncheckedIndexedAccess` cannot see that, and the defaults say it
	// without asserting.
	const [, scheme = "", id] = match;
	return NON_SESSION_SCHEMES.has(scheme.toLowerCase()) ? undefined : id;
}

export function sessionUri(sessionId: string): URI {
	return `${SESSION_SCHEME}/${sessionId}`;
}

/** `ahp-chat:/<id>` → `<id>`. Returns `undefined` when the URI is not a chat. */
export function chatIdFromUri(uri: URI): string | undefined {
	return isChatChannel(uri) ? uri.slice(`${CHAT_SCHEME}/`.length) || undefined : undefined;
}

export function chatUri(chatId: string): URI {
	return `${CHAT_SCHEME}/${chatId}`;
}
