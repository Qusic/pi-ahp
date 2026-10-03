/**
 * Repairs to the traffic of clients whose reading of the protocol differs from
 * this host's. Each entry says what the client does and what would let it go.
 */

import { ActionType, JsonRpcErrorCodes, type SessionSummary, type URI } from "@microsoft/agent-host-protocol";
import { ProtocolError } from "../protocol/errors.ts";
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../protocol/jsonrpc.ts";
import { chatIdFromUri, chatUri, ROOT_CHANNEL, sessionIdFromUri, sessionUri } from "./channels.ts";

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
type SessionUriDialect = "canonical" | "provider" | "vscode";

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
	_meta?: unknown;
	action?: unknown;
	channel?: unknown;
	changes?: unknown;
	importConversation?: unknown;
	initialSubscriptions?: unknown;
	rejectionReason?: unknown;
	session?: unknown;
	subscriptions?: unknown;
	summary?: unknown;
}

type TrackedSessionState = "creating" | "empty" | "materialized" | "disposing";

type PendingLifecycleRequest =
	| { readonly kind: "create" | "dispose"; readonly session: URI }
	| { readonly kind: "listSessions" };

function typeOfAction(value: unknown): string | undefined {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
		? value.type
		: undefined;
}

function hasVscodeClientMeta(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		("vscode.telemetryLevel" in value || "vscode.clientConnectionKind" in value)
	);
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
	readonly #deferredSessionAdded = new Map<URI, JsonRpcNotification>();
	readonly #pendingOutgoing: JsonRpcMessage[] = [];

	takePendingOutgoing(): JsonRpcMessage[] {
		const result = [...this.#pendingOutgoing];
		this.#pendingOutgoing.length = 0;
		return result;
	}

	isProvisional(uri: URI): boolean {
		const session = canonicalSessionUri(uri);
		if (!session) return false;
		const state = this.#sessions.get(session);
		return state === "creating" || state === "empty";
	}

	applyToIncoming(message: JsonRpcRequest | JsonRpcNotification, params: MessageParams): void {
		const channel = typeof params.channel === "string" ? params.channel : undefined;
		const actionType = typeOfAction(params.action);
		if (channel && actionType && MATERIALIZING_ACTIONS.has(actionType)) {
			this.#markMaterialized(channel);
			const session = owningSessionUri(channel);
			if (session) {
				const deferred = this.#deferredSessionAdded.get(session);
				if (deferred) {
					this.#deferredSessionAdded.delete(session);
					this.#pendingOutgoing.push(deferred);
				}
			}
		}
		if (!("id" in message)) {
			return;
		}
		if (message.method === "listSessions") {
			this.#pendingRequests.set(message.id, { kind: "listSessions" });
			return;
		}
		if (!channel) {
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

	applyToOutgoing(message: JsonRpcMessage): JsonRpcMessage | JsonRpcMessage[] | undefined {
		if (!("method" in message)) {
			return this.#applyResponse(message);
		}
		const params = message.params as MessageParams | undefined;
		if (!params) {
			return message;
		}
		if (message.method === "root/sessionAdded") {
			const summary = params.summary as { resource?: string } | undefined;
			if (typeof summary?.resource === "string") {
				const session = canonicalSessionUri(summary.resource);
				if (session && this.isProvisional(session)) {
					this.#deferredSessionAdded.set(session, message as JsonRpcNotification);
					return undefined;
				}
			}
			return message;
		}
		if (message.method === "root/sessionSummaryChanged") {
			const sessionUri = typeof params.session === "string" ? canonicalSessionUri(params.session) : undefined;
			if (sessionUri && this.isProvisional(sessionUri)) {
				const deferred = this.#deferredSessionAdded.get(sessionUri);
				if (deferred && typeof deferred.params === "object" && deferred.params !== null) {
					const deferredParams = deferred.params as { summary?: SessionSummary };
					if (deferredParams.summary && typeof params.changes === "object" && params.changes !== null) {
						deferredParams.summary = { ...deferredParams.summary, ...params.changes };
					}
				}
				return undefined;
			}
			return message;
		}
		if (message.method === "root/sessionRemoved" && typeof params.session === "string") {
			const session = canonicalSessionUri(params.session);
			if (session) {
				const wasProvisional = this.isProvisional(session) || this.#deferredSessionAdded.has(session);
				this.#deferredSessionAdded.delete(session);
				this.#sessions.delete(session);
				if (wasProvisional) {
					return undefined;
				}
			}
			return message;
		}
		const actionType = typeOfAction(params.action);
		if (
			message.method === "action" &&
			params.rejectionReason === undefined &&
			actionType !== undefined &&
			MATERIALIZING_ACTIONS.has(actionType) &&
			typeof params.channel === "string"
		) {
			const session = owningSessionUri(params.channel);
			if (session) {
				this.#markMaterialized(session);
				const deferred = this.#deferredSessionAdded.get(session);
				if (deferred) {
					this.#deferredSessionAdded.delete(session);
					return [deferred, message];
				}
			}
		}
		return message;
	}

	#applyResponse(message: JsonRpcResponse): JsonRpcResponse {
		const pending = this.#pendingRequests.get(message.id);
		if (!pending) {
			return message;
		}
		this.#pendingRequests.delete(message.id);
		if (pending.kind === "listSessions") {
			if (
				"result" in message &&
				typeof message.result === "object" &&
				message.result !== null &&
				"items" in message.result &&
				Array.isArray(message.result.items)
			) {
				const items = message.result.items.filter((item: unknown) => {
					if (typeof item === "object" && item !== null && "resource" in item && typeof item.resource === "string") {
						return !this.isProvisional(item.resource);
					}
					return true;
				});
				return { ...message, result: { ...message.result, items } };
			}
			return message;
		}
		const session = pending.session;
		const state = this.#sessions.get(session);
		if (pending.kind === "create") {
			if ("result" in message) {
				if (state === "creating") this.#sessions.set(session, "empty");
			} else {
				this.#sessions.delete(session);
				this.#deferredSessionAdded.delete(session);
			}
			return message;
		}
		if ("result" in message) {
			this.#sessions.delete(session);
			this.#deferredSessionAdded.delete(session);
		} else if (state === "disposing") {
			this.#sessions.set(session, "empty");
		}
		return message;
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
 * `initialize.clientInfo`, VS Code's namespaced request metadata, and derived
 * chat URIs identify VS Code and gate its workarounds. Independently, a raw
 * `pi:/...` target selects the provider-session URI dialect used by the iOS
 * client. Both observations remain per connection; core services stay canonical.
 *
 * Remove each compatibility branch when its clients emit canonical AHP traffic.
 */
export class ClientWorkarounds {
	#isVscode = false;
	#usesProviderSessionUris = false;
	readonly #vscodeSessionDisposal = new VscodeSessionDisposalGuard();

	/** Reads implementation identity without erasing observations from wire traffic. */
	identify(clientInfo: { name?: string } | undefined): void {
		if (VSCODE_CLIENT_NAMES.has(clientInfo?.name ?? "")) this.#isVscode = true;
	}

	/** Rewrites this connection's parsed request or notification in place. */
	applyToIncoming(message: JsonRpcRequest | JsonRpcNotification): void {
		const params = message.params as MessageParams | undefined;
		if (!params) return;
		this.#observeTraffic(message.method, params);
		// Remove when VS Code includes the AHP 0.9 root-channel discriminant in reconnect.
		if ("id" in message && this.#isVscode && message.method === "reconnect" && params.channel === undefined) {
			params.channel = ROOT_CHANNEL;
		}

		const dialect = this.#uriDialect();
		const rewrite = (uri: URI) => inbound(uri, dialect);
		if (typeof params.channel === "string") {
			let channel = rewrite(params.channel);
			if (message.method === "completions" && dialect !== "canonical") {
				// Both VS Code and the iOS client currently target completions at the
				// provider-style session URI.
				const sessionId = providerSessionId(channel);
				channel = sessionId ? chatUri(sessionId) : channel;
			}
			// VS Code addresses its session rename to the selected chat. AHP defines
			// `session/titleChanged` only on the owning session.
			if (
				message.method === "dispatchAction" &&
				this.#isVscode &&
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
		if (this.#isVscode) {
			this.#vscodeSessionDisposal.applyToIncoming(message, params);
		}
	}

	/** Takes any notifications that became ready to deliver to this connection. */
	takePendingOutgoing(): JsonRpcMessage[] {
		if (!this.#isVscode) return [];
		return this.#vscodeSessionDisposal.takePendingOutgoing();
	}

	/** Returns the outgoing message, rewritten if this client needs it. */
	applyToOutgoing(message: JsonRpcMessage): JsonRpcMessage | JsonRpcMessage[] | undefined {
		if (this.#isVscode) {
			const transformed = this.#vscodeSessionDisposal.applyToOutgoing(message);
			if (transformed === undefined) {
				return undefined;
			}
			const dialect = this.#uriDialect();
			if (Array.isArray(transformed)) {
				return dialect === "canonical"
					? transformed
					: transformed.map((msg) => rewriteFields(msg, (uri) => outbound(uri, dialect)) as JsonRpcMessage);
			}
			return dialect === "canonical"
				? transformed
				: (rewriteFields(transformed, (uri) => outbound(uri, dialect)) as JsonRpcMessage);
		}
		const dialect = this.#uriDialect();
		return dialect === "canonical"
			? message
			: (rewriteFields(message, (uri) => outbound(uri, dialect)) as JsonRpcMessage);
	}

	#observeTraffic(method: string, params: MessageParams): void {
		const direct = typeof params.channel === "string" ? params.channel : undefined;
		const listed = [
			...(Array.isArray(params.initialSubscriptions) ? params.initialSubscriptions : []),
			...(Array.isArray(params.subscriptions) ? params.subscriptions : []),
		];
		const observed = direct ? [direct, ...listed] : listed;
		this.#observeVscode(params, observed);
		if (
			!this.#usesProviderSessionUris &&
			(PROVIDER_SESSION_METHODS.has(method) ? observed : listed).some(
				(uri) => typeof uri === "string" && isProviderSession(uri),
			)
		) {
			this.#usesProviderSessionUris = true;
		}
	}

	#observeVscode(params: MessageParams, observed: readonly unknown[]): void {
		if (
			hasVscodeClientMeta(params._meta) ||
			observed.some((uri) => typeof uri === "string" && sessionFromDerivedChat(uri) !== undefined)
		) {
			this.#isVscode = true;
		}
	}

	#uriDialect(): SessionUriDialect {
		if (this.#isVscode) return "vscode";
		return this.#usesProviderSessionUris ? "provider" : "canonical";
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

function inbound(uri: URI, dialect: SessionUriDialect): URI {
	const derivedSession = sessionFromDerivedChat(uri);
	const derivedSessionId = derivedSession ? providerSessionId(derivedSession) : undefined;
	if (derivedSessionId) return chatUri(derivedSessionId);
	if (dialect === "canonical" || !isProviderSession(uri)) return uri;
	const sessionId = providerSessionId(uri);
	return sessionId ? sessionUri(sessionId) : uri;
}

/** Translates a URI this host minted into the dialect this client expects. */
function outbound(uri: URI, dialect: Exclude<SessionUriDialect, "canonical">): URI {
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
