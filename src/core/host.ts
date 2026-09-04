/**
 * The AHP host: message routing, subscriptions, sequencing, and broadcast.
 *
 * The host owns the authoritative state for every channel it serves. Clients
 * apply their own actions optimistically and reconcile when the host echoes
 * them back in server order, so N clients converge on the same view.
 *
 * @see https://microsoft.github.io/agent-host-protocol/guide/doctrine
 */

import {
	type ActionEnvelope,
	type CompletionsParams,
	type CompletionsResult,
	type CreateResourceWatchParams,
	type CreateResourceWatchResult,
	type CreateSessionParams,
	type DispatchActionParams,
	type FetchTurnsParams,
	type FetchTurnsResult,
	type InitializeParams,
	type InitializeResult,
	isClientDispatchable,
	JsonRpcErrorCodes,
	type ListSessionsResult,
	type ReconnectParams,
	type ReconnectResult,
	ReconnectResultType,
	type ResolveSessionConfigParams,
	type ResolveSessionConfigResult,
	type ResourceCopyParams,
	type ResourceDeleteParams,
	type ResourceListResult,
	type ResourceMkdirParams,
	type ResourceMoveParams,
	type ResourceReadParams,
	type ResourceReadResult,
	type ResourceResolveParams,
	type ResourceResolveResult,
	type ResourceWriteParams,
	type SessionConfigCompletionsParams,
	type SessionConfigCompletionsResult,
	type Snapshot,
	type StateAction,
	type SubscribeParams,
	type SubscribeResult,
	type URI,
} from "@microsoft/agent-host-protocol";
import { ProtocolError } from "../protocol/errors.ts";
import {
	errorResponse,
	isJsonRpcNotification,
	isJsonRpcRequest,
	type JsonRpcNotification,
	type JsonRpcRequest,
	notification,
	readChannel,
	successResponse,
} from "../protocol/jsonrpc.ts";
import { negotiateProtocolVersion } from "../protocol/version.ts";
import { channelKind, ROOT_CHANNEL } from "./channels.ts";
import { ClientConnection, type Transport } from "./connection.ts";
import { Sequencer } from "./sequencer.ts";
import { StateStore } from "./state-store.ts";

/**
 * The optional halves of the protocol a host chooses to serve.
 *
 * One object rather than a setter per feature: the surface grew a setter each
 * time a command was implemented, and the router ended up with a nullable field
 * and an "unconfigured" branch for each. Collecting them makes what a host does
 * and does not serve readable in one place, and keeps the degradation for a
 * missing capability in one place too.
 *
 * Every field is optional, and the router answers a request for an absent one
 * the way the protocol expects — an empty result where that is meaningful,
 * `MethodNotFound` where it is not.
 */
export interface HostCapabilities {
	/** The session catalogue behind `listSessions`. */
	readonly catalogue?: SessionCatalogue;
	/** `createSession` / `disposeSession`. */
	readonly sessions?: SessionLifecycleHandler;
	/** The `resource*` request/response family. */
	readonly resources?: ResourceHandler;
	/** `createResourceWatch`. */
	readonly resourceWatches?: ResourceWatchHandler;
	/** `completions`. */
	readonly completions?: CompletionHandler;
	/** `resolveSessionConfig` / `sessionConfigCompletions`. */
	readonly sessionConfig?: SessionConfigHandler;
	/** `fetchTurns`. */
	readonly turnPaging?: TurnPagingHandler;
	/** Loads a channel that exists durably but is not yet in memory. */
	readonly hydrator?: ChannelHydrator;
}

export interface HostOptions {
	/** Advertised on `InitializeResult.serverInfo`. Informational only. */
	readonly serverInfo?: { name: string; version?: string; title?: string };
	/** Starting location for remote filesystem browsing, as a `file:` URI. */
	readonly defaultDirectory?: URI;
	/**
	 * Characters that should make a client issue a `completions` request.
	 *
	 * Only advertise what the host can actually answer: every completion item
	 * must carry an attachment, so a trigger with nothing to attach would make
	 * the client ask and always get nothing back.
	 */
	readonly completionTriggerCharacters?: readonly string[];
	readonly replayBufferCapacity?: number;
	readonly log?: (message: string) => void;
}

/**
 * Supplies the session catalogue. Split out because the catalogue is not part
 * of root state — clients fetch it imperatively and keep it fresh from
 * `root/session*` notifications.
 */
export interface SessionCatalogue {
	list(limit: number | undefined, cursor: string | undefined): Promise<ListSessionsResult>;
}

/**
 * Handles the session lifecycle commands. Kept behind an interface so the core
 * router stays agnostic of how sessions are actually backed.
 */
export interface SessionLifecycleHandler {
	create(params: CreateSessionParams): void | Promise<void>;
	dispose(channel: URI): void | Promise<void>;
}

/** Post-commit hook for actions a client dispatched. */
export type ClientActionListener = (channel: URI, action: StateAction) => void;

/**
 * Pre-commit check for actions a client dispatched.
 *
 * Returns a reason to refuse the action, or `undefined` to accept it. This runs
 * *before* the reducer, which is the only point where refusing is meaningful:
 * once an action is applied and broadcast, every client has already moved on.
 */
export type ClientActionValidator = (channel: URI, action: StateAction) => string | undefined;

/** Notified when the number of clients subscribed to a channel changes. */
export type SubscriberCountListener = (channel: URI, count: number) => void;

/**
 * Materialises a channel that exists durably but is not yet in memory.
 *
 * A client lists sessions and then subscribes to one; only sessions this host
 * created are live, so the rest have to be loaded on demand. Returning `false`
 * means the channel genuinely does not exist.
 */
export interface ChannelHydrator {
	hydrate(channel: URI): Promise<boolean>;
}

/** Serves the pre-creation session configuration exchange. */
export interface SessionConfigHandler {
	resolve(params: ResolveSessionConfigParams): ResolveSessionConfigResult | Promise<ResolveSessionConfigResult>;
	completions(
		params: SessionConfigCompletionsParams,
	): SessionConfigCompletionsResult | Promise<SessionConfigCompletionsResult>;
}

/** Loads older turns into a chat. */
export interface TurnPagingHandler {
	fetchTurns(params: FetchTurnsParams): Promise<FetchTurnsResult>;
}

/** Serves inline `completions` for a chat's message input. */
export interface CompletionHandler {
	complete(params: CompletionsParams): Promise<CompletionsResult>;
}

/**
 * Opens filesystem watchers. Separate from {@link ResourceHandler} because a
 * watch owns a live resource with its own lifetime, whereas the rest of the
 * family is request/response.
 */
export interface ResourceWatchHandler {
	create(params: CreateResourceWatchParams): Promise<CreateResourceWatchResult>;
}

/**
 * Serves the connection-level `resource*` family.
 *
 * Kept behind an interface because the family is symmetrical: the same shape
 * will back server → client requests when this host starts issuing them.
 */
export interface ResourceHandler {
	read(params: ResourceReadParams): Promise<ResourceReadResult>;
	write(params: ResourceWriteParams): Promise<Record<string, never>>;
	list(uri: string): Promise<ResourceListResult>;
	resolve(params: ResourceResolveParams): Promise<ResourceResolveResult>;
	mkdir(params: ResourceMkdirParams): Promise<Record<string, never>>;
	delete(params: ResourceDeleteParams): Promise<Record<string, never>>;
	move(params: ResourceMoveParams): Promise<Record<string, never>>;
	copy(params: ResourceCopyParams): Promise<Record<string, never>>;
}

export class AhpHost {
	readonly #store = new StateStore();
	readonly #sequencer: Sequencer;
	readonly #options: HostOptions;
	readonly #connections = new Set<ClientConnection>();
	/** `reconnect` omits clientInfo; an undefined value still records an id seen by this host process. */
	readonly #clientInfoById = new Map<string, InitializeParams["clientInfo"]>();
	#capabilities: HostCapabilities = {};
	readonly #actionListeners = new Set<ClientActionListener>();
	readonly #actionValidators = new Set<ClientActionValidator>();
	readonly #subscriberListeners = new Set<SubscriberCountListener>();

	constructor(options: HostOptions = {}) {
		this.#options = options;
		this.#sequencer = new Sequencer(options.replayBufferCapacity);
	}

	get store(): StateStore {
		return this.#store;
	}

	get serverSeq(): number {
		return this.#sequencer.current;
	}

	/**
	 * Declares what this host serves.
	 *
	 * Merges into whatever was declared before, so a caller can wire one area
	 * at a time without restating the rest.
	 */
	serve(capabilities: HostCapabilities): void {
		this.#capabilities = { ...this.#capabilities, ...capabilities };
	}

	// ── Connection lifecycle ────────────────────────────────────────────────

	/** Attaches a transport. The `clientId` is not known until `initialize`. */
	accept(transport: Transport): ClientConnection {
		const connection = new ClientConnection(transport);
		this.#connections.add(connection);
		transport.onMessage((message) => {
			this.#handleMessage(connection, message);
		});
		transport.onClose(() => {
			this.#connections.delete(connection);
			// A dropped socket releases its subscriptions just like an explicit
			// unsubscribe; resources tied to them must not outlive the client.
			for (const channel of connection.subscriptions) {
				this.#notifySubscriberCount(channel);
			}
		});
		return connection;
	}

	// ── Message routing ─────────────────────────────────────────────────────

	#handleMessage(connection: ClientConnection, message: unknown): void {
		if (isJsonRpcRequest(message)) {
			void this.#handleRequest(connection, message);
			return;
		}
		if (isJsonRpcNotification(message)) {
			this.#handleNotification(connection, message);
			return;
		}
		this.#log(`Ignoring unroutable message: ${JSON.stringify(message).slice(0, 200)}`);
	}

	async #handleRequest(connection: ClientConnection, request: JsonRpcRequest): Promise<void> {
		try {
			const result = await this.#dispatchRequest(connection, request);
			connection.send(successResponse(request.id, result));
		} catch (error) {
			const protocolError =
				error instanceof ProtocolError
					? error
					: new ProtocolError(JsonRpcErrorCodes.InternalError, error instanceof Error ? error.message : String(error));
			this.#log(`${request.method} failed: ${protocolError.message}`);
			connection.send(errorResponse(request.id, protocolError.code, protocolError.message, protocolError.data));
		}
	}

	async #dispatchRequest(connection: ClientConnection, request: JsonRpcRequest): Promise<unknown> {
		if (request.method === "reconnect") {
			const params = request.params as ReconnectParams | undefined;
			if (typeof params?.clientId === "string") {
				connection.workarounds.identify(this.#clientInfoById.get(params.clientId));
				connection.workarounds.identifyReconnect(params.subscriptions);
			}
		}
		connection.workarounds.applyToIncoming(request);
		switch (request.method) {
			// `ping` must be answered whether or not the client has completed
			// `initialize` or holds any subscription.
			case "ping":
				return null;
			case "initialize":
				return await this.#initialize(connection, request.params as InitializeParams);
			case "reconnect":
				return this.#reconnect(connection, request.params as ReconnectParams);
			case "subscribe":
				return await this.#subscribe(connection, request.params as SubscribeParams);
			case "listSessions": {
				const params = (request.params ?? {}) as { limit?: number; cursor?: string };
				if (!this.#capabilities.catalogue) {
					return { items: [] } satisfies ListSessionsResult;
				}
				return this.#capabilities.catalogue.list(params.limit, params.cursor);
			}
			case "createSession": {
				if (!this.#capabilities.sessions) {
					throw ProtocolError.methodNotFound("createSession");
				}
				await this.#capabilities.sessions.create(request.params as CreateSessionParams);
				return null;
			}
			case "disposeSession": {
				if (!this.#capabilities.sessions) {
					throw ProtocolError.methodNotFound("disposeSession");
				}
				const channel = readChannel(request.params);
				if (!channel) {
					throw ProtocolError.invalidParams("disposeSession requires a channel");
				}
				await this.#capabilities.sessions.dispose(channel);
				return null;
			}
			case "resourceRead":
				return this.#requireResources().read(request.params as ResourceReadParams);
			case "resourceWrite":
				return this.#requireResources().write(request.params as ResourceWriteParams);
			case "resourceList":
				return this.#requireResources().list((request.params as { uri: string }).uri);
			case "resourceResolve":
				return this.#requireResources().resolve(request.params as ResourceResolveParams);
			case "resourceMkdir":
				return this.#requireResources().mkdir(request.params as ResourceMkdirParams);
			case "resourceDelete":
				return this.#requireResources().delete(request.params as ResourceDeleteParams);
			case "resourceMove":
				return this.#requireResources().move(request.params as ResourceMoveParams);
			case "resourceCopy":
				return this.#requireResources().copy(request.params as ResourceCopyParams);
			case "resolveSessionConfig": {
				// A client calls this before `createSession`; answering
				// MethodNotFound stops it from getting as far as creating one.
				if (!this.#capabilities.sessionConfig) {
					return { schema: { type: "object", properties: {} }, values: {} } satisfies ResolveSessionConfigResult;
				}
				return this.#capabilities.sessionConfig.resolve(request.params as ResolveSessionConfigParams);
			}
			case "sessionConfigCompletions": {
				if (!this.#capabilities.sessionConfig) {
					return { items: [] } satisfies SessionConfigCompletionsResult;
				}
				return this.#capabilities.sessionConfig.completions(request.params as SessionConfigCompletionsParams);
			}
			case "fetchTurns": {
				// The result carries no turns: the host must dispatch
				// `chat/turnsLoaded` *before* responding, so the client's state
				// already holds the page by the time this returns.
				if (!this.#capabilities.turnPaging) {
					return {} satisfies FetchTurnsResult;
				}
				return this.#capabilities.turnPaging.fetchTurns(request.params as FetchTurnsParams);
			}
			case "completions": {
				// Best-effort by contract: a client debounces keystrokes into this,
				// so an unconfigured host answers with nothing rather than an error.
				if (!this.#capabilities.completions) {
					return { items: [] } satisfies CompletionsResult;
				}
				return this.#capabilities.completions.complete(request.params as CompletionsParams);
			}
			case "createResourceWatch": {
				if (!this.#capabilities.resourceWatches) {
					throw ProtocolError.methodNotFound("createResourceWatch");
				}
				return this.#capabilities.resourceWatches.create(request.params as CreateResourceWatchParams);
			}
			case "resourceRequest":
				// No per-resource grants are tracked: a client that reaches this
				// endpoint already holds the token and can start a session, so a
				// grant ledger here would imply a boundary that does not exist.
				// The receiver may still refuse individual operations.
				return {};
			default:
				throw ProtocolError.methodNotFound(request.method);
		}
	}

	#requireResources(): ResourceHandler {
		if (!this.#capabilities.resources) {
			throw ProtocolError.methodNotFound("resource*");
		}
		return this.#capabilities.resources;
	}

	#handleNotification(connection: ClientConnection, message: JsonRpcNotification): void {
		connection.workarounds.applyToIncoming(message);
		switch (message.method) {
			case "unsubscribe": {
				const channel = readChannel(message.params);
				if (channel) {
					connection.unsubscribe(channel);
					this.#notifySubscriberCount(channel);
				}
				return;
			}
			case "dispatchAction":
				this.#dispatchClientAction(connection, message.params as DispatchActionParams);
				return;
			default:
				this.#log(`Ignoring unknown notification: ${message.method}`);
		}
	}

	// ── Handshake ───────────────────────────────────────────────────────────

	async #initialize(connection: ClientConnection, params: InitializeParams): Promise<InitializeResult> {
		if (typeof params?.clientId !== "string" || params.clientId.length === 0) {
			throw ProtocolError.invalidParams("initialize requires a clientId");
		}
		const protocolVersion = negotiateProtocolVersion(params.protocolVersions);

		this.#bindClient(connection, params.clientId);

		const clientInfo = params.clientInfo ?? this.#clientInfoById.get(params.clientId);
		this.#clientInfoById.set(params.clientId, clientInfo);
		connection.workarounds.identify(clientInfo);

		const snapshots: Snapshot[] = [];
		for (const uri of params.initialSubscriptions ?? []) {
			if (!this.#store.has(uri)) {
				// Same lazy load as `subscribe`: a client reconnecting with its
				// previously-open sessions must get them back.
				await this.#capabilities.hydrator?.hydrate(uri).catch(() => false);
			}
			const snapshot = this.#trySubscribe(connection, uri);
			if (snapshot) {
				snapshots.push(snapshot);
			}
		}

		return {
			protocolVersion,
			serverSeq: this.#sequencer.current,
			...(this.#options.serverInfo ? { serverInfo: this.#options.serverInfo } : {}),
			...(this.#options.defaultDirectory ? { defaultDirectory: this.#options.defaultDirectory } : {}),
			...(this.#options.completionTriggerCharacters
				? { completionTriggerCharacters: [...this.#options.completionTriggerCharacters] }
				: {}),
			snapshots,
		};
	}

	async #reconnect(connection: ClientConnection, params: ReconnectParams): Promise<ReconnectResult> {
		if (typeof params?.clientId !== "string" || params.clientId.length === 0) {
			throw ProtocolError.invalidParams("reconnect requires a clientId");
		}
		const knownClient = this.#clientInfoById.has(params.clientId);
		if (!knownClient) {
			this.#clientInfoById.set(params.clientId, undefined);
		}
		this.#bindClient(connection, params.clientId);

		const requested = params.subscriptions ?? [];
		const missing: URI[] = [];
		connection.subscriptions.clear();
		for (const uri of requested) {
			if (uri !== ROOT_CHANNEL && !this.#store.has(uri)) {
				await this.#capabilities.hydrator?.hydrate(uri).catch(() => false);
			}
			if (uri === ROOT_CHANNEL || this.#store.has(uri)) {
				connection.subscribe(uri);
			} else {
				missing.push(uri);
			}
		}

		const lastSeen = params.lastSeenServerSeq ?? 0;
		if (knownClient && this.#sequencer.canReplayFrom(lastSeen)) {
			const actions = this.#sequencer.replayFrom(lastSeen, connection.subscriptions);
			return { type: ReconnectResultType.Replay, actions, missing };
		}

		// Replay is unavailable after buffer eviction or in a fresh host process.
		// Durable subscriptions were hydrated above; return current snapshots.
		const snapshots: Snapshot[] = [];
		for (const uri of connection.subscriptions) {
			const snapshot = this.#store.snapshot(uri, this.#sequencer.current);
			if (snapshot) {
				snapshots.push(snapshot);
			}
		}
		return { type: ReconnectResultType.Snapshot, snapshots };
	}

	/** Replaces a half-open socket when the same clientId reconnects. */
	#bindClient(connection: ClientConnection, clientId: string): void {
		for (const previous of this.#connections) {
			if (previous !== connection && previous.clientId === clientId) {
				this.#connections.delete(previous);
				previous.transport.close();
			}
		}
		connection.clientId = clientId;
	}

	// ── Subscriptions ───────────────────────────────────────────────────────

	async #subscribe(connection: ClientConnection, params: SubscribeParams): Promise<SubscribeResult> {
		const channel = params?.channel;
		if (typeof channel !== "string") {
			throw ProtocolError.invalidParams("subscribe requires a channel");
		}
		if (!this.#store.has(channel)) {
			// Not in memory does not mean it does not exist: a session from the
			// catalogue lives on disk until someone opens it. The hydrator gets the
			// first chance to resolve known aliases before the strict scheme check.
			const hydrated = (await this.#capabilities.hydrator?.hydrate(channel)) ?? false;
			if (!hydrated) {
				throw channelKind(channel) === undefined
					? ProtocolError.invalidParams(`Unsupported channel scheme: ${channel}`)
					: ProtocolError.notFound(channel);
			}
		}
		const snapshot = this.#trySubscribe(connection, channel);
		return snapshot ? { snapshot } : {};
	}

	#trySubscribe(connection: ClientConnection, channel: URI): Snapshot | undefined {
		// Membership in the store is the real test: a session opened at a
		// non-standard URI has no recognised scheme but is a perfectly valid
		// channel.
		if (!this.#store.has(channel)) {
			this.#log(`Ignoring subscription to unknown channel: ${channel}`);
			return undefined;
		}
		connection.subscribe(channel);
		return this.#store.snapshot(channel, this.#sequencer.current);
	}

	// ── Actions ─────────────────────────────────────────────────────────────

	#dispatchClientAction(connection: ClientConnection, params: DispatchActionParams): void {
		const channel = params?.channel;
		const action = params?.action;
		if (typeof channel !== "string" || !action) {
			this.#log("Ignoring malformed dispatchAction");
			return;
		}
		// Spec: an action naming a channel that does not exist is silently
		// ignored — no echo, no rejection.
		if (!this.#store.has(channel)) {
			this.#log(`Ignoring action for unknown channel: ${channel}`);
			return;
		}
		const origin = { clientId: connection.clientId, clientSeq: params.clientSeq };
		if (!isClientDispatchable(action as never)) {
			this.#rejectAction(channel, action, origin, `Action is not client-dispatchable: ${action.type}`);
			return;
		}
		for (const validator of this.#actionValidators) {
			const reason = validator(channel, action);
			if (reason !== undefined) {
				this.#rejectAction(channel, action, origin, reason);
				return;
			}
		}
		this.#commit(channel, action, origin);
		this.#emitClientAction(channel, action);
	}

	/**
	 * Applies a host-originated action and broadcasts it.
	 *
	 * This is the single write path for everything the agent backend produces.
	 */
	dispatchServerAction(channel: URI, action: StateAction): void {
		if (!this.#store.has(channel)) {
			this.#log(`Dropping server action for unknown channel: ${channel}`);
			return;
		}
		this.#commit(channel, action, undefined);
	}

	#commit(channel: URI, action: StateAction, origin: ActionEnvelope["origin"]): void {
		this.#store.apply(channel, action);
		const envelope: ActionEnvelope = {
			channel,
			action,
			serverSeq: this.#sequencer.next(),
			origin,
		};
		this.#sequencer.retain(envelope);
		this.#broadcast(channel, notification("action", envelope));
	}

	/** Echoes a rejected action so the write-ahead client can roll it back. */
	#rejectAction(channel: URI, action: StateAction, origin: ActionEnvelope["origin"], rejectionReason: string): void {
		const envelope: ActionEnvelope = {
			channel,
			action,
			serverSeq: this.#sequencer.next(),
			origin,
			rejectionReason,
		};
		this.#sequencer.retain(envelope);
		this.#broadcast(channel, notification("action", envelope));
	}

	// ── Broadcast ───────────────────────────────────────────────────────────

	/** Sends a channel-scoped message to every client subscribed to that channel. */
	#broadcast(channel: URI, message: JsonRpcNotification): void {
		for (const connection of this.#connections) {
			if (connection.isSubscribed(channel)) {
				connection.send(message);
			}
		}
	}

	/** How many connected clients are subscribed to a channel. */
	subscriberCount(channel: URI): number {
		let count = 0;
		for (const connection of this.#connections) {
			if (connection.isSubscribed(channel)) {
				count += 1;
			}
		}
		return count;
	}

	/**
	 * Observes changes to a channel's subscriber count.
	 *
	 * Some channels own a resource that should not outlive interest in it — a
	 * filesystem watcher has no dispose command and is released when its last
	 * subscriber goes away.
	 */
	onSubscriberCountChanged(listener: SubscriberCountListener): () => void {
		this.#subscriberListeners.add(listener);
		return () => this.#subscriberListeners.delete(listener);
	}

	#notifySubscriberCount(channel: URI): void {
		const count = this.subscriberCount(channel);
		for (const listener of this.#subscriberListeners) {
			try {
				listener(channel, count);
			} catch (error) {
				this.#log(`Subscriber-count listener threw for ${channel}: ${String(error)}`);
			}
		}
	}

	/** Emits a protocol notification (`root/sessionAdded`, `auth/required`, …). */
	notify(channel: URI, method: string, params: Record<string, unknown>): void {
		this.#broadcast(channel, notification(method, { channel, ...params }));
	}

	// ── Side effects ────────────────────────────────────────────────────────

	/**
	 * Registers a post-commit hook for client-dispatched actions.
	 *
	 * Actions are applied and broadcast *before* the hook runs, so the
	 * authoritative state already reflects the action by the time a backend is
	 * asked to act on it. Rejected actions never reach the hook.
	 */
	onClientAction(listener: ClientActionListener): () => void {
		this.#actionListeners.add(listener);
		return () => this.#actionListeners.delete(listener);
	}

	/**
	 * Registers a pre-commit check.
	 *
	 * Needed whenever accepting an action would leave the host unable to carry
	 * it out: applying it anyway would show the client a change the backend
	 * never made, which is worse than a refusal it can report.
	 */
	addClientActionValidator(validator: ClientActionValidator): () => void {
		this.#actionValidators.add(validator);
		return () => this.#actionValidators.delete(validator);
	}

	#emitClientAction(channel: URI, action: StateAction): void {
		for (const listener of this.#actionListeners) {
			try {
				listener(channel, action);
			} catch (error) {
				// A failing side effect must not corrupt the action stream that
				// other clients have already observed.
				this.#log(`Side effect for ${action.type} threw: ${String(error)}`);
			}
		}
	}

	#log(message: string): void {
		this.#options.log?.(`[ahp-host] ${message}`);
	}
}
