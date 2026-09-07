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

/** Whether an action namespace belongs to the reducer behind a channel. */
export function actionBelongsToChannel(type: unknown, kind: ChannelKind): boolean {
	return typeof type === "string" && type.startsWith(`${kind}/`);
}

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
 * a channel with the wrong reducer. A command that creates a resource can
 * register its client-chosen URI with an explicit kind instead.
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

interface SingleSegmentChannel {
	readonly scheme: string;
	readonly id: string;
}

function parseSingleSegmentChannel(uri: URI): SingleSegmentChannel | undefined {
	const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/([^/?#]+)$/.exec(uri);
	const scheme = match?.[1];
	const id = match?.[2];
	return scheme && id ? { scheme: scheme.toLowerCase(), id } : undefined;
}

/**
 * Identifies a session from its canonical scheme or explicit provider aliases
 * given as bare scheme names. Shape alone never makes an unknown URI a session.
 */
export function sessionIdFromUri(uri: URI, providerAliases: readonly string[] = []): string | undefined {
	const parsed = parseSingleSegmentChannel(uri);
	if (!parsed) {
		return undefined;
	}
	const canonical = SESSION_SCHEME.slice(0, -1);
	return parsed.scheme === canonical || providerAliases.some((alias) => parsed.scheme === alias.toLowerCase())
		? parsed.id
		: undefined;
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
