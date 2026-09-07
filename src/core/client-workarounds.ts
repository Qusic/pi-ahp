/**
 * Repairs to the traffic of clients whose reading of the protocol differs from
 * this host's. Each entry says what the client does and what would let it go.
 */

import { ActionType, type URI } from "@microsoft/agent-host-protocol";
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest } from "../protocol/jsonrpc.ts";
import { chatIdFromUri, chatUri, sessionIdFromUri, sessionUri } from "./channels.ts";

/**
 * Field names that carry session or chat URIs in state, actions, and catalogue
 * notifications. The rewrite itself ignores every other URI scheme.
 */
const REWRITABLE_FIELDS = new Set(["channel", "resource", "defaultChat", "session", "chat"]);

/** VS Code's derived chat URI: `ahp-chat://<anything>/<base64url(sessionUri)>`. */
const DERIVED_CHAT_URI = /^ahp-chat:\/\/[^/]+\/([^/?#]+)$/;

/** The client names VS Code identifies itself with at `initialize`. */
const VSCODE_CLIENT_NAMES = new Set(["vscode-editor-window", "vscode-agents-window"]);

/**
 * The scheme VS Code will address sessions under, being this host's agent
 * provider name. Hard-coded rather than threaded down from the pi layer:
 * everything about this file is temporary, and a parameter for it would outlive
 * the reason for it in three signatures.
 */
const PROVIDER_SESSION_SCHEME = "pi";
type SessionDialect = "canonical" | "provider" | "vscode";

/** Methods where a direct `pi:/...` target can only mean a session. */
const PROVIDER_SESSION_METHODS = new Set([
	"createSession",
	"disposeSession",
	"subscribe",
	"unsubscribe",
	"dispatchAction",
	"completions",
]);

function providerSessionId(uri: URI): string | undefined {
	return sessionIdFromUri(uri, [PROVIDER_SESSION_SCHEME]);
}

function isProviderSession(uri: URI): boolean {
	return uri.toLowerCase().startsWith(`${PROVIDER_SESSION_SCHEME}:/`) && providerSessionId(uri) !== undefined;
}

interface IncomingParams {
	action?: unknown;
	channel?: unknown;
	initialSubscriptions?: unknown;
	subscriptions?: unknown;
}

function typeOfAction(value: unknown): string | undefined {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
		? value.type
		: undefined;
}

/**
 * VS Code addresses sessions and chats at URIs it computes, not the ones it was
 * given.
 *
 * Three assumptions drive it, none of them in the protocol:
 *
 *  - A session lives at `<agentProvider>:/<id>`. `agentHostSessionHandler`
 *    rebuilds the URI that way from the provider name rather than using the
 *    `resource` the host published. It has a `sessionSchemeAlias` config for
 *    exactly this mismatch — "sessions are `ahp-session:/<id>` while the agent
 *    is `copilot`" — but only its cloud sandbox provider sets it.
 *  - A session's default chat lives at `ahp-chat://default/<base64url(session)>`,
 *    derived so producer and consumer "can compute it without a lookup table".
 *    `SessionState.defaultChat` and the session's chat list are both ignored.
 *  - `completions` targets the backend session URI even though its `channel`
 *    is specified as a chat URI. VS Code's host accepts either and silently
 *    chooses the default chat; this host keeps that tolerance per connection.
 *
 * So nothing this host sends is addressable by it, and every subscription
 * misses: sessions list, and opening one shows an empty transcript. Publishing
 * its shapes instead would push a base64 blob and a provider-specific scheme
 * onto every other client, so the translation is per connection and only for
 * the clients that need it.
 *
 * Normally VS Code is identified at `initialize`, before the session list and
 * snapshots go out. A raw `pi:/...` target separately identifies only the
 * provider-style session scheme, which covers the iOS client without forcing
 * VS Code's derived-chat format on it. Observing a derived chat enables that
 * second translation. After a host restart, reconnect subscriptions provide the
 * same fingerprints. Replies use each connection's dialect while core services
 * see canonical URIs.
 *
 * Goes when VS Code addresses what it was given.
 */
export class ClientWorkarounds {
	#dialect: SessionDialect = "canonical";

	/** Reads implementation identity without erasing a dialect inferred from URIs. */
	identify(clientInfo: { name?: string } | undefined): void {
		if (VSCODE_CLIENT_NAMES.has(clientInfo?.name ?? "")) this.#dialect = "vscode";
	}

	/** Rewrites this connection's parsed request or notification in place. */
	applyToIncoming(message: JsonRpcRequest | JsonRpcNotification): void {
		const params = message.params as IncomingParams | undefined;
		if (!params) return;
		this.#observeDialect(message.method, params);

		const rewrite = (uri: URI) => inbound(uri, this.#dialect);
		if (typeof params.channel === "string") {
			let channel = rewrite(params.channel);
			if (message.method === "completions" && this.#dialect !== "canonical") {
				// Both VS Code and the iOS client currently target completions at the
				// provider-style session URI.
				const sessionId = providerSessionId(channel);
				channel = sessionId ? chatUri(sessionId) : channel;
			}
			// VS Code addresses its session rename to the selected chat. AHP defines
			// `session/titleChanged` only on the owning session.
			if (
				message.method === "dispatchAction" &&
				this.#dialect === "vscode" &&
				typeOfAction(params.action) === ActionType.SessionTitleChanged
			) {
				const chatId = chatIdFromUri(channel);
				channel = chatId ? sessionUri(chatId) : channel;
			}
			params.channel = channel;
		}
		// Handshake requests name their subscribed channels in arrays rather than
		// the top-level routing `channel`.
		for (const field of ["initialSubscriptions", "subscriptions"] as const) {
			const subscriptions = params[field];
			if (Array.isArray(subscriptions)) {
				params[field] = subscriptions.map((uri) => (typeof uri === "string" ? rewrite(uri) : uri));
			}
		}
	}

	/** Returns the message to send, rewritten if this client needs it. */
	applyToMessage(message: JsonRpcMessage): JsonRpcMessage {
		const dialect = this.#dialect;
		return dialect === "canonical"
			? message
			: (rewriteFields(message, (uri) => outbound(uri, dialect)) as JsonRpcMessage);
	}

	#observeDialect(method: string, params: IncomingParams): void {
		const direct = typeof params.channel === "string" ? params.channel : undefined;
		const listed = [
			...(Array.isArray(params.initialSubscriptions) ? params.initialSubscriptions : []),
			...(Array.isArray(params.subscriptions) ? params.subscriptions : []),
		];
		const observed = direct ? [direct, ...listed] : listed;
		if (observed.some((uri) => typeof uri === "string" && sessionFromDerivedChat(uri) !== undefined)) {
			this.#dialect = "vscode";
		} else if (
			this.#dialect === "canonical" &&
			(PROVIDER_SESSION_METHODS.has(method) ? observed : listed).some(
				(uri) => typeof uri === "string" && isProviderSession(uri),
			)
		) {
			this.#dialect = "provider";
		}
	}
}

/**
 * Translates a URI this client computed into the one this host minted.
 *
 * A derived chat URI is unwrapped whoever sent it — it names no channel this
 * host could otherwise serve. A provider-aliased session URI is only rewritten
 * for a client identified as using that alias; unknown schemes are left alone.
 */
function sessionFromDerivedChat(uri: URI): URI | undefined {
	const [, encoded = ""] = DERIVED_CHAT_URI.exec(uri) ?? [];
	const session = encoded ? Buffer.from(encoded, "base64url").toString("utf8") : "";
	return isProviderSession(session) ? session : undefined;
}

function inbound(uri: URI, dialect: SessionDialect): URI {
	const derivedSession = sessionFromDerivedChat(uri);
	const derivedSessionId = derivedSession ? providerSessionId(derivedSession) : undefined;
	if (derivedSessionId) return chatUri(derivedSessionId);
	if (dialect === "canonical" || !isProviderSession(uri)) return uri;
	const sessionId = providerSessionId(uri);
	return sessionId ? sessionUri(sessionId) : uri;
}

/** Translates a URI this host minted into the dialect this client expects. */
function outbound(uri: URI, dialect: Exclude<SessionDialect, "canonical">): URI {
	const chatId = chatIdFromUri(uri);
	if (chatId) {
		return dialect === "vscode"
			? `ahp-chat://default/${Buffer.from(`${PROVIDER_SESSION_SCHEME}:/${chatId}`).toString("base64url")}`
			: uri;
	}
	const sessionId = providerSessionId(uri);
	return sessionId ? `${PROVIDER_SESSION_SCHEME}:/${sessionId}` : uri;
}

/** Applies `rewrite` to every rewritable field, however deeply nested. */
function rewriteFields(value: unknown, rewrite: (uri: URI) => URI): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => rewriteFields(item, rewrite));
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] =
			REWRITABLE_FIELDS.has(key) && typeof item === "string" ? rewrite(item as URI) : rewriteFields(item, rewrite);
	}
	return out;
}
