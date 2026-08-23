/**
 * Repairs to the traffic of clients whose reading of the protocol differs from
 * this host's. Each entry says what the client does and what would let it go.
 */

import type { URI } from "@microsoft/agent-host-protocol";
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest } from "../protocol/jsonrpc.ts";
import { chatIdFromUri, chatUri, permissiveSessionId, sessionUri } from "./channels.ts";

/**
 * Where a URI this host minted can appear on the wire: an action envelope's
 * `channel`, a snapshot's or summary's `resource`, and `SessionState.defaultChat`.
 */
const REWRITABLE_FIELDS = new Set(["channel", "resource", "defaultChat"]);

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

/**
 * VS Code addresses sessions and chats at URIs it computes, not the ones it was
 * given.
 *
 * Two assumptions drive it, neither of them in the protocol:
 *
 *  - A session lives at `<agentProvider>:/<id>`. `agentHostSessionHandler`
 *    rebuilds the URI that way from the provider name rather than using the
 *    `resource` the host published. It has a `sessionSchemeAlias` config for
 *    exactly this mismatch — "sessions are `ahp-session:/<id>` while the agent
 *    is `copilot`" — but only its cloud sandbox provider sets it.
 *  - A session's default chat lives at `ahp-chat://default/<base64url(session)>`,
 *    derived so producer and consumer "can compute it without a lookup table".
 *    `SessionState.defaultChat` and the session's chat list are both ignored.
 *
 * So nothing this host sends is addressable by it, and every subscription
 * misses: sessions list, and opening one shows an empty transcript. Publishing
 * its shapes instead would push a base64 blob and a provider-specific scheme
 * onto every other client, so the translation is per connection and only for
 * the clients that need it.
 *
 * Two things it depends on. The client is identified at `initialize`, not on
 * first use, because the session list and the session snapshot both go out
 * before it asks for anything they name. And the two directions have to stay
 * symmetric: a URI rewritten one way only answers on a channel the client is
 * not listening to.
 *
 * Goes when VS Code addresses what it was given.
 */
export class ClientWorkarounds {
	/** The scheme this client expects sessions under, when not the standard one. */
	#sessionScheme: string | undefined;

	/** Reads the handshake; see the note on timing above. */
	identify(clientInfo: { name?: string } | undefined): void {
		this.#sessionScheme = VSCODE_CLIENT_NAMES.has(clientInfo?.name ?? "") ? PROVIDER_SESSION_SCHEME : undefined;
	}

	/** Rewrites this connection's parsed request or notification in place. */
	applyToIncoming(message: JsonRpcRequest | JsonRpcNotification): void {
		const params = message.params as { channel?: unknown; subscriptions?: unknown } | undefined;
		if (!params) {
			return;
		}
		const rewrite = (uri: URI) => inbound(uri, this.#sessionScheme);
		if (typeof params.channel === "string") {
			params.channel = rewrite(params.channel);
		}
		// `reconnect` names its channels here rather than in `channel`.
		if (Array.isArray(params.subscriptions)) {
			params.subscriptions = params.subscriptions.map((uri) => (typeof uri === "string" ? rewrite(uri) : uri));
		}
	}

	/** Returns the message to send, rewritten if this client needs it. */
	applyToMessage(message: JsonRpcMessage): JsonRpcMessage {
		const scheme = this.#sessionScheme;
		return scheme ? (rewriteFields(message, (uri) => outbound(uri, scheme)) as JsonRpcMessage) : message;
	}
}

/**
 * Translates a URI this client computed into the one this host minted.
 *
 * A derived chat URI is unwrapped whoever sent it — it names no channel this
 * host could otherwise serve. A session URI is only rewritten for a client
 * being answered under `scheme`, because choosing your own session URI is
 * something any client may legitimately do (`permissiveSessionId`), and one
 * that did would not want it moved.
 */
function inbound(uri: URI, scheme: string | undefined): URI {
	const derived = DERIVED_CHAT_URI.exec(uri);
	if (derived) {
		const [, encoded = ""] = derived;
		const id = permissiveSessionId(Buffer.from(encoded, "base64url").toString("utf8"));
		return id ? chatUri(id) : uri;
	}
	if (!scheme || !uri.startsWith(`${scheme}:/`)) {
		return uri;
	}
	const sessionId = permissiveSessionId(uri);
	return sessionId ? sessionUri(sessionId) : uri;
}

/** Translates a URI this host minted into the one this client will compute. */
function outbound(uri: URI, scheme: string): URI {
	const chatId = chatIdFromUri(uri);
	if (chatId) {
		return `ahp-chat://default/${Buffer.from(`${scheme}:/${chatId}`).toString("base64url")}`;
	}
	const sessionId = permissiveSessionId(uri);
	return sessionId ? `${scheme}:/${sessionId}` : uri;
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
