/**
 * Repairs to the traffic of clients whose reading of the protocol differs from
 * this host's. Each entry says what the client does and what would let it go.
 */

import { ActionType, JsonRpcErrorCodes, type URI } from "@microsoft/agent-host-protocol";
import { ProtocolError } from "../protocol/errors.ts";
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../protocol/jsonrpc.ts";
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

const VSCODE_MATERIALIZED_SESSION_DISPOSAL_REFUSAL =
	"Materialized session disposal is temporarily disabled for VS Code because of a VS Code provisional-session lifecycle bug; this session was kept.";

/** Actions after which a session is no longer an abandoned empty draft. */
const MATERIALIZING_ACTIONS = new Set<string>([
	ActionType.ChatTurnStarted,
	ActionType.ChatPendingMessageSet,
	ActionType.SessionTitleChanged,
]);

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

function canonicalSessionUri(uri: URI): URI | undefined {
	const sessionId = providerSessionId(uri);
	return sessionId ? sessionUri(sessionId) : undefined;
}

function owningSessionUri(uri: URI): URI | undefined {
	const session = canonicalSessionUri(uri);
	if (session) return session;
	const chatId = chatIdFromUri(uri);
	return chatId ? sessionUri(chatId) : undefined;
}

interface MessageParams {
	action?: unknown;
	channel?: unknown;
	importConversation?: unknown;
	initialSubscriptions?: unknown;
	rejectionReason?: unknown;
	session?: unknown;
	subscriptions?: unknown;
}

type TrackedSessionState = "creating" | "empty" | "materialized" | "disposing";

interface PendingLifecycleRequest {
	readonly kind: "create" | "dispose";
	readonly session: URI;
}

function typeOfAction(value: unknown): string | undefined {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
		? value.type
		: undefined;
}

/**
 * Allows VS Code to clean up only sessions known to be unused drafts on this
 * connection. Unknown sessions are protected: reconnect does not carry enough
 * history to prove that they are empty.
 *
 * Remove this tracker when VS Code graduates materialized remote sessions
 * before tearing down its provisional-session service.
 */
class VscodeSessionDisposalGuard {
	readonly #sessions = new Map<URI, TrackedSessionState>();
	readonly #pendingRequests = new Map<number, PendingLifecycleRequest>();

	applyToIncoming(message: JsonRpcRequest | JsonRpcNotification, params: MessageParams): void {
		const channel = typeof params.channel === "string" ? params.channel : undefined;
		const actionType = typeOfAction(params.action);
		if (channel && actionType && MATERIALIZING_ACTIONS.has(actionType)) {
			this.#markMaterialized(channel);
		}
		if (!("id" in message) || !channel) {
			return;
		}
		const session = canonicalSessionUri(channel);
		if (!session) {
			return;
		}
		if (message.method === "createSession") {
			this.#sessions.set(session, params.importConversation === undefined ? "creating" : "materialized");
			this.#pendingRequests.set(message.id, { kind: "create", session });
			return;
		}
		if (message.method !== "disposeSession") {
			return;
		}
		if (this.#sessions.get(session) !== "empty") {
			throw new ProtocolError(JsonRpcErrorCodes.InvalidRequest, VSCODE_MATERIALIZED_SESSION_DISPOSAL_REFUSAL);
		}
		this.#sessions.set(session, "disposing");
		this.#pendingRequests.set(message.id, { kind: "dispose", session });
	}

	applyToOutgoing(message: JsonRpcMessage): void {
		if (!("method" in message)) {
			this.#applyResponse(message);
			return;
		}
		const params = message.params as MessageParams | undefined;
		if (!params) {
			return;
		}
		const actionType = typeOfAction(params.action);
		if (
			message.method === "action" &&
			params.rejectionReason === undefined &&
			actionType !== undefined &&
			MATERIALIZING_ACTIONS.has(actionType) &&
			typeof params.channel === "string"
		) {
			this.#markMaterialized(params.channel);
		}
		if (message.method === "root/sessionRemoved" && typeof params.session === "string") {
			const session = canonicalSessionUri(params.session);
			if (session) this.#sessions.delete(session);
		}
	}

	#applyResponse(message: JsonRpcResponse): void {
		const pending = this.#pendingRequests.get(message.id);
		if (!pending) {
			return;
		}
		this.#pendingRequests.delete(message.id);
		const state = this.#sessions.get(pending.session);
		if (pending.kind === "create") {
			if ("result" in message) {
				if (state === "creating") this.#sessions.set(pending.session, "empty");
			} else {
				this.#sessions.delete(pending.session);
			}
			return;
		}
		if ("result" in message) {
			this.#sessions.delete(pending.session);
		} else if (state === "disposing") {
			this.#sessions.set(pending.session, "empty");
		}
	}

	#markMaterialized(channel: URI): void {
		const session = owningSessionUri(channel);
		if (session && this.#sessions.has(session)) {
			this.#sessions.set(session, "materialized");
		}
	}
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
	readonly #vscodeSessionDisposal = new VscodeSessionDisposalGuard();

	/** Reads implementation identity without erasing a dialect inferred from URIs. */
	identify(clientInfo: { name?: string } | undefined): void {
		if (VSCODE_CLIENT_NAMES.has(clientInfo?.name ?? "")) this.#dialect = "vscode";
	}

	/** Rewrites this connection's parsed request or notification in place. */
	applyToIncoming(message: JsonRpcRequest | JsonRpcNotification): void {
		const params = message.params as MessageParams | undefined;
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
		if (this.#dialect === "vscode") {
			this.#vscodeSessionDisposal.applyToIncoming(message, params);
		}
	}

	/** Returns the message to send, rewritten if this client needs it. */
	applyToMessage(message: JsonRpcMessage): JsonRpcMessage {
		if (this.#dialect === "vscode") {
			this.#vscodeSessionDisposal.applyToOutgoing(message);
		}
		const dialect = this.#dialect;
		return dialect === "canonical"
			? message
			: (rewriteFields(message, (uri) => outbound(uri, dialect)) as JsonRpcMessage);
	}

	#observeDialect(method: string, params: MessageParams): void {
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
