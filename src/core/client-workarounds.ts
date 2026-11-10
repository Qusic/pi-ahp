/**
 * Repairs to the traffic of clients whose reading of the protocol differs from
 * this host's. Each entry says what the client does and what would let it go.
 */

import {
	ActionType,
	JsonRpcErrorCodes,
	type ResolveSessionConfigResult,
	type URI,
} from "@microsoft/agent-host-protocol";
import { ProtocolError } from "../protocol/errors.ts";
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../protocol/jsonrpc.ts";
import { chatIdFromUri, chatUri, sessionIdFromUri, sessionUri } from "./channels.ts";

/** The client names VS Code identifies itself with at `initialize`. */
const VSCODE_CLIENT_NAMES = new Set(["vscode-editor-window", "vscode-agents-window"]);

const VSCODE_SESSION_DISPOSAL_REFUSAL =
	"Deleting sessions from VS Code is temporarily disabled because VS Code can dispose sessions unintentionally; this session was kept.";

/** Actions after which a session is no longer an abandoned empty draft. */
const MATERIALIZING_ACTIONS = new Set<string>([
	ActionType.ChatTurnStarted,
	ActionType.ChatPendingMessageSet,
	ActionType.SessionTitleChanged,
]);

interface MessageParams {
	_meta?: unknown;
	action?: unknown;
	channel?: unknown;
	clientInfo?: unknown;
	importConversation?: unknown;
	rejectionReason?: unknown;
	session?: unknown;
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

/** VS Code names itself at `initialize` and sends namespaced metadata with every handshake. */
function identifiesVscode({ clientInfo, _meta: meta }: MessageParams): boolean {
	const name =
		typeof clientInfo === "object" && clientInfo !== null && "name" in clientInfo ? clientInfo.name : undefined;
	return (
		(typeof name === "string" && VSCODE_CLIENT_NAMES.has(name)) ||
		(typeof meta === "object" &&
			meta !== null &&
			("vscode.telemetryLevel" in meta || "vscode.clientConnectionKind" in meta))
	);
}

/** The session a session or chat channel belongs to; a chat shares its session's id. */
function owningSessionUri(uri: URI): URI | undefined {
	if (sessionIdFromUri(uri)) return uri;
	const chatId = chatIdFromUri(uri);
	return chatId ? sessionUri(chatId) : undefined;
}

/**
 * Lets VS Code dispose only the drafts it created on this connection and never
 * used. VS Code disposes every loaded session when the window's workspace
 * folders change (microsoft/vscode#343406, microsoft/vscode#344553), so any
 * other session is kept. Unknown sessions are protected too: reconnect does not
 * carry enough history to prove that they are empty.
 *
 * Remove this guard when VS Code Stable fixes those issues.
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
		if (!("id" in message) || !channel || !sessionIdFromUri(channel)) {
			return;
		}
		if (message.method === "createSession") {
			this.#sessions.set(channel, params.importConversation === undefined ? "creating" : "materialized");
			this.#pendingRequests.set(message.id, { kind: "create", session: channel });
			return;
		}
		if (message.method !== "disposeSession") {
			return;
		}
		if (this.#sessions.get(channel) !== "empty") {
			throw new ProtocolError(JsonRpcErrorCodes.InvalidRequest, VSCODE_SESSION_DISPOSAL_REFUSAL);
		}
		this.#sessions.set(channel, "disposing");
		this.#pendingRequests.set(message.id, { kind: "dispose", session: channel });
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
			this.#sessions.delete(params.session);
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

/** Makes the properties a session fixes at creation read-only. */
function lockCreationTimeConfig(result: ResolveSessionConfigResult): void {
	for (const property of Object.values(result.schema.properties)) {
		if (!property.sessionMutable) property.readOnly = true;
	}
}

/** The channel AHP defines for a request VS Code addresses elsewhere; see {@link ClientWorkarounds}. */
function vscodeChannel(method: string, channel: URI, action: unknown): URI {
	if (method === "completions") {
		const sessionId = sessionIdFromUri(channel);
		return sessionId ? chatUri(sessionId) : channel;
	}
	if (method === "dispatchAction" && typeOfAction(action) === ActionType.SessionTitleChanged) {
		const chatId = chatIdFromUri(channel);
		return chatId ? sessionUri(chatId) : channel;
	}
	return channel;
}

/**
 * VS Code Stable still departs from AHP in four ways, repaired per connection
 * so core services only ever see standard traffic:
 *
 * - it requests `completions` for a session rather than the session's chat;
 * - it renames a default chat with `session/titleChanged` on the chat channel,
 *   which AHP defines only on the owning session;
 * - it can dispose sessions unintentionally (see {@link VscodeSessionDisposalGuard});
 * - it creates a session before the user configures it (microsoft/vscode#345623),
 *   then changes properties AHP fixes at creation, so those are shown read-only.
 *
 * Remove each repair when VS Code Stable sends standard traffic.
 */
export class ClientWorkarounds {
	#isVscode = false;
	readonly #vscodeSessionDisposal = new VscodeSessionDisposalGuard();
	readonly #configRequests = new Set<number>();

	/** Repairs this connection's parsed request or notification in place. */
	applyToIncoming(message: JsonRpcRequest | JsonRpcNotification): void {
		const params = message.params as MessageParams | undefined;
		if (!params) return;
		if (identifiesVscode(params)) this.#isVscode = true;
		if (!this.#isVscode) return;
		if (typeof params.channel === "string") {
			params.channel = vscodeChannel(message.method, params.channel, params.action);
		}
		if (message.method === "resolveSessionConfig" && "id" in message) {
			this.#configRequests.add(message.id);
		}
		this.#vscodeSessionDisposal.applyToIncoming(message, params);
	}

	/** Repairs a message this connection is about to be sent, in place. */
	applyToOutgoing(message: JsonRpcMessage): void {
		if (!this.#isVscode) return;
		if (!("method" in message) && this.#configRequests.delete(message.id) && "result" in message) {
			lockCreationTimeConfig(message.result as ResolveSessionConfigResult);
		}
		this.#vscodeSessionDisposal.applyToOutgoing(message);
	}
}
