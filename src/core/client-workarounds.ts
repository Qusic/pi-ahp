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
 * The provider scheme affected by this compatibility layer. Keep it local so
 * client-specific routing does not leak into canonical host APIs.
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
 * VS Code computes provider-scoped session URIs and derived default-chat URIs
 * instead of using the canonical resources published by the host. It also
 * targets `completions` at the session URI rather than the chat URI. Publishing
 * those shapes globally would impose one client's dialect on every client, so
 * translation remains per connection and core services see canonical URIs.
 *
 * `initialize.clientInfo` identifies VS Code before snapshots are sent. A raw
 * `pi:/...` target identifies only the provider-session dialect used by the iOS
 * client, while observing a derived chat enables the full VS Code dialect.
 * Reconnect subscriptions provide the same fingerprints after a host restart.
 *
 * Remove this layer when VS Code consistently addresses the resources a host
 * publishes.
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
 * A derived chat URI is unwrapped regardless of who sent it — it names no channel this
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
