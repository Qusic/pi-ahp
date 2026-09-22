/**
 * Live sessions: creation, disposal, adoption from disk, and routing client
 * actions to whatever can carry them out.
 *
 * This is the pi-facing half of the session channel. The protocol-shaped half —
 * building a `SessionState`, deriving a `SessionSummary` — lives in
 * `channels/session.ts` and knows nothing about pi. The dependency runs one
 * way: an adapter depends on the shapes it produces, never the reverse.
 *
 * The session URI's uuid **is** pi's session id. `SessionManager.create()`
 * accepts an explicit id, so the two identity spaces are the same one and no
 * persistent mapping table is needed.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/session-channel
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	type Message,
	MessageKind,
	type ModelSelection,
	PendingMessageKind,
	ResponsePartKind,
	type SessionState,
	type SessionSummary,
	type StateAction,
	type URI,
} from "@microsoft/agent-host-protocol";
import { installDefaultChat, syncChatSummary } from "../channels/chat.ts";
import { notifySessionAdded, notifySessionRemoved, notifySessionSummaryChanged } from "../channels/root.ts";
import { aggregateSessionChats, initialSessionState, sessionSummaryOf } from "../channels/session.ts";
import { chatUri, ROOT_CHANNEL, sessionIdFromUri } from "../core/channels.ts";
import type { AhpHost } from "../core/host.ts";
import { fileUriToPath } from "../core/uri.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { ChatDriver, type PiBackend } from "./chat-driver.ts";
import { messageRejectionReason } from "./message-input.ts";
import { PI_PROVIDER } from "./provider.ts";
import type { LiveSessionCatalogueEntry } from "./session-catalogue.ts";
import { dispatchOlderTurns, truncationAnchor } from "./session-history.ts";
import type { SessionManagerFactory } from "./session-storage.ts";
import { fallbackSessionTitle, NEW_SESSION_TITLE } from "./session-title.ts";

/** Everything the host tracks for a live session. */
export interface LiveSession {
	readonly uri: URI;
	/** pi's session id — identical to the uuid in `uri`. */
	readonly sessionId: string;
	readonly workingDirectory: string;
	readonly sessionManager: SessionManager;
	readonly createdAt: string;
	/** The session's single chat channel. */
	readonly chatChannel: URI;
	/** Present once a backend is attached; absent while the session is storage-only. */
	driver?: ChatDriver;
	/**
	 * In-flight backend attach, so concurrent actions wait on one attempt.
	 *
	 * Explicitly `| undefined` rather than only optional: it is cleared by
	 * assignment when the attempt settles, which `exactOptionalPropertyTypes`
	 * distinguishes from never having been set.
	 */
	attaching?: Promise<void> | undefined;
	/**
	 * Turn id → the pi session entry that turn ends on.
	 *
	 * Truncation needs it: the protocol names a turn, pi navigates to an entry.
	 * Filled from the rebuild when a session is loaded from disk, and from the
	 * leaf pointer as live turns complete.
	 */
	readonly turnAnchors: Map<string, string>;
}

/** Creates the agent backend for a session. Absent in storage-only mode. */
export type BackendFactory = (session: LiveSession) => Promise<PiBackend> | PiBackend;

function userMessageRejectionReason(message: Message, originReason: string): string | undefined {
	return messageRejectionReason(message) ?? (message.origin.kind === MessageKind.User ? undefined : originReason);
}

function unsupportedClientActionReason(action: StateAction): string | undefined {
	switch (action.type) {
		case ActionType.SessionActiveClientSet:
		case ActionType.SessionActiveClientRemoved:
			return "This host does not accept active clients";
		case ActionType.SessionWorkingDirectorySet:
		case ActionType.SessionWorkingDirectoryRemoved:
		case ActionType.SessionWorkingDirectoryReplaced:
		case ActionType.ChatWorkingDirectorySet:
		case ActionType.ChatWorkingDirectoryRemoved:
			return "This agent does not support changing working directories";
		case ActionType.SessionCustomizationToggled:
			return "This host does not support customizations";
		case ActionType.SessionMcpServerStartRequested:
		case ActionType.SessionMcpServerStopRequested:
			return "This host does not support MCP servers";
		case ActionType.SessionIsReadChanged:
		case ActionType.SessionIsArchivedChanged:
			return "This host does not persist read or archive state";
		case ActionType.SessionConfigChanged:
			return "This session has no mutable configuration";
		case ActionType.ChatToolCallConfirmed:
		case ActionType.ChatToolCallComplete:
		case ActionType.ChatToolCallResultConfirmed:
		case ActionType.ChatToolCallContentChanged:
			return "This host does not support client tool execution or confirmation";
		case ActionType.ChatInputAnswerChanged:
		case ActionType.ChatInputCompleted:
			return "This host does not support interactive input requests";
		case ActionType.ChatTurnResume:
			return "This host cannot resume an errored turn";
		default:
			return undefined;
	}
}

export interface CreateSessionRequest {
	readonly channel: URI;
	/**
	 * A set in the protocol, but this host does not declare
	 * `multipleWorkingDirectories`, which is what forbids a client from sending
	 * more than one. Anything past the first is ignored rather than refused —
	 * the session still runs, in the directory the client asked for first.
	 */
	readonly workingDirectories?: readonly URI[];
	readonly provider?: string;
}

export interface SessionFileDeletionResult {
	readonly ok: boolean;
	readonly error?: string;
}

export interface SessionRegistryOptions {
	readonly host: AhpHost;
	/** Used for sessions created without one of their own. */
	readonly defaultWorkingDirectory?: string;
	readonly createBackend?: BackendFactory;
	/** Explicit storage boundary; composition chooses durable or in-memory sessions. */
	readonly createSessionManager: SessionManagerFactory;
	/** Seeds a new chat's draft so a client has a model selected from the start. */
	readonly defaultSelection?: () => ModelSelection | undefined;
	/** A failed result or rejection prevents protocol removal. */
	readonly deleteFile?: (path: string) => SessionFileDeletionResult | Promise<SessionFileDeletionResult>;
	/** Locates the file behind a session this host never ran. */
	readonly findSessionFile?: (sessionId: string) => Promise<string | undefined>;
	readonly log?: (message: string) => void;
}

export type SessionAvailableListener = (session: LiveSession) => void;
export type SessionDeletionCommittedListener = (sessionId: string) => void | Promise<void>;

export class SessionRegistry {
	readonly #options: SessionRegistryOptions;
	readonly #host: AhpHost;
	readonly #sessions = new Map<URI, LiveSession>();
	readonly #byChat = new Map<URI, LiveSession>();
	/** Last root-catalog value used as a diff baseline; never authoritative state. */
	readonly #summaryBaselines = new Map<URI, SessionSummary>();
	/** Coalesces duplicate disposal requests and blocks new work during deletion. */
	readonly #disposals = new Map<URI, Promise<void>>();
	/** Prevents projection-generated session actions from recursively republishing. */
	readonly #projectingSessions = new Set<URI>();
	readonly #sessionAvailableListeners = new Set<SessionAvailableListener>();
	readonly #sessionDeletionCommittedListeners = new Set<SessionDeletionCommittedListener>();

	constructor(options: SessionRegistryOptions) {
		this.#options = options;
		this.#host = options.host;

		// Client actions are routed to whichever channel owns them; the host
		// core stays agnostic of chats and backends.
		this.#host.onActionCommitted((channel, action) => {
			const owner = this.#byChat.get(channel);
			if (owner) {
				if (action.type === ActionType.ChatTurnStarted) {
					this.#applyFallbackTitle(owner, action.message.text);
				}
				this.#syncChatProjection(owner);
				return;
			}
			const session = this.#sessions.get(channel);
			if (session && !this.#projectingSessions.has(channel)) {
				this.#publishSummary(session);
			}
		});

		this.#host.onClientAction((channel, action) => {
			void this.#routeClientAction(channel, action).catch((error) => {
				this.#options.log?.(`side effect failed for ${channel}: ${String(error)}`);
			});
		});

		this.#host.addClientActionValidator((channel, action) => this.#validateClientAction(channel, action));
	}

	// ── Lookup ──────────────────────────────────────────────────────────────

	get(uri: URI): LiveSession | undefined {
		return this.#sessions.get(uri);
	}

	getByChat(chatChannel: URI): LiveSession | undefined {
		return this.#byChat.get(chatChannel);
	}

	has(uri: URI): boolean {
		return this.#sessions.has(uri);
	}

	isDisposing(uri: URI): boolean {
		return this.#disposals.has(uri);
	}

	/** Observes sessions after their registry and protocol channels exist. */
	onSessionAvailable(listener: SessionAvailableListener): () => void {
		this.#sessionAvailableListeners.add(listener);
		for (const session of this.#sessions.values()) this.#notifySessionAvailable(listener, session);
		return () => this.#sessionAvailableListeners.delete(listener);
	}

	/** Runs after durable deletion commits, before protocol channels disappear. */
	onSessionDeletionCommitted(listener: SessionDeletionCommittedListener): () => void {
		this.#sessionDeletionCommittedListeners.add(listener);
		return () => this.#sessionDeletionCommittedListeners.delete(listener);
	}

	/** Live summaries that override or supplement pi's on-disk catalogue. */
	catalogueOverrides(): LiveSessionCatalogueEntry[] {
		return [...this.#sessions.values()].map((session) => {
			const file = session.sessionManager.getSessionFile();
			return {
				summary: this.#summaryOf(session),
				...(file ? { file } : {}),
			};
		});
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────

	/**
	 * Handles `createSession`.
	 *
	 * Returns as soon as the channel exists; readiness arrives later as a
	 * `session/ready` action on that channel.
	 */
	create(request: CreateSessionRequest): void {
		const uri = request.channel;
		// Only canonical and provider-alias URIs can be recovered after a host restart.
		const sessionId = sessionIdFromUri(uri, [PI_PROVIDER]);
		if (!sessionId) {
			throw ProtocolError.invalidParams(`Not a session URI: ${uri}`);
		}
		if (this.#disposals.has(uri) || this.#sessions.has(uri) || this.#host.store.has(uri)) {
			throw ProtocolError.sessionAlreadyExists(uri);
		}
		if (request.provider !== undefined && request.provider !== PI_PROVIDER) {
			throw ProtocolError.providerNotFound(request.provider);
		}

		const requested = request.workingDirectories?.[0];
		const workingDirectory = requested
			? fileUriToPath(requested)
			: (this.#options.defaultWorkingDirectory ?? process.cwd());

		const title = NEW_SESSION_TITLE;
		const createdAt = new Date().toISOString();
		// A provider-alias URI still needs the session reducer.
		this.#host.store.create(uri, initialSessionState(PI_PROVIDER, title, workingDirectory), "session");

		// pi withholds the session file until an assistant message exists; the
		// manager still owns the target directory and in-memory entry tree now.
		const sessionManager = this.#options.createSessionManager(workingDirectory, sessionId);
		const chatChannel = installDefaultChat(this.#host, uri, sessionId, title, this.#options.defaultSelection?.());

		const session: LiveSession = {
			uri,
			sessionId,
			workingDirectory,
			sessionManager,
			chatChannel,
			createdAt,
			turnAnchors: new Map(),
		};
		this.#track(session);
		this.#notifySessionAvailableToAll(session);

		const summary = this.#summaryOf(session);
		notifySessionAdded(this.#host, summary);
		this.#summaryBaselines.set(uri, summary);
		this.#bumpActiveSessions();

		// Readiness is genuinely asynchronous once a backend is involved: the
		// client already holds the channel and sees `lifecycle: 'creating'` until
		// the agent is up.
		void this.#attachBackend(session);
	}

	/**
	 * Registers a session loaded from disk.
	 *
	 * Deliberately without a backend: a client browsing its history would
	 * otherwise start an agent for every session it looks at. The agent is
	 * attached on the first action that needs one.
	 */
	adopt(
		session: Omit<LiveSession, "driver" | "attaching" | "turnAnchors"> & {
			turnAnchors?: Map<string, string>;
		},
	): LiveSession {
		const existing = this.#sessions.get(session.uri);
		if (existing) {
			return existing;
		}
		const adopted: LiveSession = { ...session, turnAnchors: session.turnAnchors ?? new Map() };
		this.#track(adopted);
		this.#notifySessionAvailableToAll(adopted);
		this.#summaryBaselines.set(adopted.uri, this.#summaryOf(adopted));
		this.#bumpActiveSessions();
		return adopted;
	}

	/**
	 * Handles `disposeSession`.
	 *
	 * Works for any session in the catalogue, not just ones this host has
	 * running. Most sessions a client can see were written by pi and have never
	 * been live here, so refusing to dispose them would make the delete
	 * affordance fail on almost everything the list shows.
	 *
	 * AHP requires backend teardown and catalogue removal but does not prescribe
	 * how a host stores sessions. This catalogue is the set of pi session files,
	 * so stable removal also requires deleting the backing file via the same
	 * trash-then-unlink path pi's own `/resume` delete uses.
	 */
	dispose(uri: URI): Promise<void> {
		const pending = this.#disposals.get(uri);
		if (pending) {
			return pending;
		}

		// Defer the work so the gate is installed before backend shutdown can emit
		// events or any other message can observe the transition.
		const operation = Promise.resolve().then(() => this.#disposeOnce(uri));
		this.#disposals.set(uri, operation);
		const clear = (): void => {
			if (this.#disposals.get(uri) === operation) {
				this.#disposals.delete(uri);
			}
		};
		void operation.then(clear, clear);
		return operation;
	}

	async #disposeOnce(uri: URI): Promise<void> {
		const session = this.#sessions.get(uri);
		let sessionId: string;
		let file: string | undefined;
		let quiesced: ChatDriver | undefined;

		try {
			if (session) {
				sessionId = session.sessionId;
				quiesced = session.driver;
				await quiesced?.quiesce();
				file = session.sessionManager.getSessionFile();

				// Storage-only or failed-start backends have no driver to close a turn.
				const chat = this.#host.store.get(session.chatChannel) as ChatState | undefined;
				if (chat?.activeTurn) {
					const started = Date.parse(chat.activeTurn.startedAt);
					this.#host.dispatchServerAction(session.chatChannel, {
						type: ActionType.ChatTurnCancelled,
						turnId: chat.activeTurn.id,
						duration: Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0,
					});
				}
			} else {
				const kind = this.#host.store.kindOf(uri);
				if (kind !== undefined && kind !== "session") {
					throw ProtocolError.sessionNotFound(uri);
				}
				const parsedId = sessionIdFromUri(uri, [PI_PROVIDER]);
				if (!parsedId) {
					throw ProtocolError.sessionNotFound(uri);
				}
				sessionId = parsedId;
				file = await this.#options.findSessionFile?.(sessionId);
				if (!file && !this.#host.store.has(uri)) {
					throw ProtocolError.sessionNotFound(uri);
				}
			}

			if (file) {
				const deleteFile = this.#options.deleteFile;
				if (!deleteFile) {
					throw new Error("durable session deletion is not configured");
				}
				const result = await deleteFile(file);
				if (!result.ok) {
					throw new Error(result.error ?? "the durable session file remains");
				}
			}
		} catch (error) {
			quiesced?.resume();
			if (error instanceof ProtocolError) {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not dispose session ${uri}: ${message}`);
		}

		// Durable deletion is now committed. Protocol children disappear before
		// the parent so their subscribers can observe final cleanup actions.
		for (const listener of this.#sessionDeletionCommittedListeners) {
			try {
				await listener(sessionId);
			} catch (error) {
				this.#options.log?.(`protocol child cleanup failed for ${uri}: ${String(error)}`);
			}
		}

		// Re-read the live entry defensively so cleanup cannot leave registry and
		// protocol state disagreeing.
		const current = this.#sessions.get(uri);
		if (current) {
			current.driver?.dispose();
			this.#sessions.delete(uri);
			this.#byChat.delete(current.chatChannel);
			// Disposing a session cascades to every chat in its catalog.
			this.#host.deleteChannel(current.chatChannel);
		} else {
			this.#host.deleteChannel(chatUri(sessionId));
		}
		this.#host.deleteChannel(uri);
		this.#summaryBaselines.delete(uri);
		notifySessionRemoved(this.#host, uri);
		this.#bumpActiveSessions();
	}

	// ── Backend attachment ──────────────────────────────────────────────────

	async #attachBackend(session: LiveSession): Promise<void> {
		// Concurrent actions during startup must wait on one attempt, not race
		// to build a second agent over the same session file.
		if (session.attaching) {
			return session.attaching;
		}
		session.attaching = this.#startBackend(session).finally(() => {
			session.attaching = undefined;
		});
		return session.attaching;
	}

	async #startBackend(session: LiveSession): Promise<void> {
		if (!this.#options.createBackend) {
			// Storage-only mode: the session owns identity and history but has no
			// agent, so it is ready as soon as it exists.
			this.#host.dispatchServerAction(session.uri, { type: ActionType.SessionReady });
			return;
		}
		try {
			const backend = await this.#options.createBackend(session);
			// Disposal may win while an asynchronous backend is starting. Never
			// attach a late backend to a session that no longer exists.
			if (this.#sessions.get(session.uri) !== session) {
				backend.dispose?.();
				return;
			}
			session.driver = new ChatDriver({
				host: this.#host,
				chatChannel: session.chatChannel,
				backend,
				workingDirectory: session.workingDirectory,
				// A completed turn's last entry is wherever the leaf now points.
				recordTurnAnchor: (turnId) => {
					const leaf = session.sessionManager.getLeafEntry();
					// Navigating to a user entry branches before it, so it cannot
					// represent "keep this cancelled user-only turn" safely.
					if (!leaf || (leaf.type === "message" && leaf.message.role === "user")) {
						return;
					}
					session.turnAnchors.set(turnId, leaf.id);
				},
				...(this.#options.log ? { log: this.#options.log } : {}),
			});
			this.#host.dispatchServerAction(session.uri, { type: ActionType.SessionReady });
			// Tell the client which model and reasoning effort are actually in
			// effect. There is no protocol field for a "default model", but a
			// client initialises its input from `ChatState.draft`, so seeding the
			// draft's selection is how a host answers that question.
			session.driver.publishDefaultSelection();
		} catch (error) {
			if (this.#sessions.get(session.uri) !== session) return;
			const message = error instanceof Error ? error.message : String(error);
			this.#host.dispatchServerAction(session.uri, {
				type: ActionType.SessionCreationFailed,
				error: { errorType: "backendStartFailed", message },
			});

			// A turn may already be active: the client's `chat/turnStarted` was
			// reduced before the agent was asked for. Nothing will ever emit
			// `agent_settled` now, so close it here or the chat sits in progress
			// forever with no reply and no error.
			const chat = this.#host.store.get(session.chatChannel) as ChatState | undefined;
			if (chat?.activeTurn) {
				this.#host.dispatchServerAction(session.chatChannel, {
					type: ActionType.ChatError,
					turnId: chat.activeTurn.id,
					duration: 0,
					part: {
						kind: ResponsePartKind.Error,
						error: { errorType: "backendStartFailed", message },
					},
				});
			}
		}
	}

	// ── Client actions ──────────────────────────────────────────────────────

	#validateClientAction(channel: URI, action: StateAction): string | undefined {
		const session = this.#sessions.get(channel) ?? this.#byChat.get(channel);
		if (this.#disposals.has(channel) || (session && this.#disposals.has(session.uri))) {
			return "This session is being disposed";
		}

		const unsupported = unsupportedClientActionReason(action);
		if (unsupported) {
			return unsupported;
		}

		const chat = this.#host.store.get(channel) as ChatState | undefined;
		switch (action.type) {
			case ActionType.SessionTitleChanged:
				return typeof action.title === "string" ? undefined : "A session title must be a string";
			case ActionType.ChatTurnStarted: {
				if (typeof action.turnId !== "string" || typeof action.startedAt !== "string") {
					return "A turn requires string turnId and startedAt fields";
				}
				const invalid = userMessageRejectionReason(
					action.message,
					"A client can only start a turn with a user message",
				);
				if (invalid) return invalid;
				if (action.queuedMessageId !== undefined) {
					return "Only the host can start a queued message";
				}
				return chat?.activeTurn ? "A turn is already active" : undefined;
			}
			case ActionType.ChatTurnCancelled:
				if (typeof action.turnId !== "string" || typeof action.duration !== "number") {
					return "Turn cancellation requires a turnId and duration";
				}
				return chat?.activeTurn?.id === action.turnId ? undefined : "No matching active turn to cancel";
			case ActionType.ChatPendingMessageSet: {
				if (
					typeof action.id !== "string" ||
					(action.kind !== PendingMessageKind.Steering && action.kind !== PendingMessageKind.Queued)
				) {
					return "A pending message requires an id and supported kind";
				}
				return userMessageRejectionReason(action.message, "A client can only queue a user message");
			}
			case ActionType.ChatPendingMessageRemoved:
				if (typeof action.id !== "string") return "A pending message removal requires an id";
				if (action.kind === PendingMessageKind.Steering) {
					return "A steering message cannot be withdrawn after pi has queued it";
				}
				if (action.kind !== PendingMessageKind.Queued) return "Unsupported pending message kind";
				return chat?.queuedMessages?.some((message) => message.id === action.id)
					? undefined
					: "No matching queued message to remove";
			case ActionType.ChatQueuedMessagesReordered:
				return Array.isArray(action.order) && action.order.every((id) => typeof id === "string")
					? undefined
					: "Queued message order must be an array of ids";
			case ActionType.ChatDraftChanged: {
				if (action.draft === undefined) return undefined;
				return userMessageRejectionReason(action.draft, "A client can only draft a user message");
			}
			case ActionType.ChatTruncated: {
				if (action.turnId !== undefined && typeof action.turnId !== "string") {
					return "A truncation turnId must be a string";
				}
				// Accepting an impossible truncation would shorten the client's view
				// while pi kept using context the user believes is gone.
				const session = this.#byChat.get(channel);
				if (!session) {
					return undefined;
				}
				return truncationAnchor(session, action.turnId)
					? undefined
					: `Cannot truncate: no session entry matches turn ${action.turnId ?? "(all)"}`;
			}
			default:
				return undefined;
		}
	}

	/**
	 * Routes a client action to whatever owns it.
	 *
	 * Chat actions go to the chat's driver, starting the agent first if this
	 * session has only ever been read from disk. Session actions are handled
	 * here — they carry no turn and need no agent.
	 */
	async #routeClientAction(channel: URI, action: StateAction): Promise<void> {
		const owningSession = this.#sessions.get(channel);
		if (owningSession) {
			this.#handleSessionAction(owningSession, action);
			return;
		}

		const session = this.#byChat.get(channel);
		if (!session) {
			return;
		}
		if (!session.driver) {
			await this.#attachBackend(session);
		}
		// An action accepted before disposal may have been waiting for lazy
		// backend startup. On failure it still belongs to the surviving session;
		// on success there is no session left to mutate.
		const disposal = this.#disposals.get(session.uri);
		if (disposal) {
			try {
				await disposal;
				return;
			} catch {
				// Disposal rolled back; continue with the action already in state.
			}
		}
		if (this.#sessions.get(session.uri) !== session) {
			return;
		}
		if (action.type === ActionType.ChatTruncated) {
			await this.#truncate(session, action.turnId);
			return;
		}
		if (action.type === ActionType.ChatTurnStarted) {
			const chat = this.#host.store.get(channel) as ChatState | undefined;
			if (chat?.activeTurn?.id !== action.turnId) {
				return;
			}
		}
		session.driver?.handleClientAction(channel, action);
	}

	#handleSessionAction(session: LiveSession, action: StateAction): void {
		if (action.type !== ActionType.SessionTitleChanged) {
			return;
		}

		// The reducer has already updated the in-memory title. Persisting it is
		// what makes the rename survive a restart: pi stores session names as
		// `session_info` entries, and this is the same call its own `/resume`
		// rename makes — so a session renamed here reads the same in pi's CLI.
		try {
			session.sessionManager.appendSessionInfo(action.title);
		} catch (error) {
			this.#options.log?.(`could not persist title for ${session.uri}: ${String(error)}`);
		}

		// The chat mirrors the session's title. Updating its modification time
		// lets the ordinary chat-to-session projection update the root catalogue.
		this.#renameChat(session, action.title);
	}

	#applyFallbackTitle(session: LiveSession, firstUserMessage: string): void {
		const state = this.#host.store.get(session.uri) as SessionState | undefined;
		if (state?.title !== NEW_SESSION_TITLE || session.sessionManager.getSessionName()) {
			return;
		}
		const title = fallbackSessionTitle(firstUserMessage);
		if (!title) {
			return;
		}

		// This is pi's unnamed-session fallback, not an explicit session name:
		// publish it to AHP without adding a `session_info` entry.
		this.#host.dispatchServerAction(session.uri, { type: ActionType.SessionTitleChanged, title });
		this.#renameChat(session, title, false);
	}

	#renameChat(session: LiveSession, title: string, touch = true): void {
		const chat = this.#host.store.get(session.chatChannel) as ChatState | undefined;
		if (!chat || chat.title === title) {
			return;
		}
		// There is no chat title action in AHP 0.9. Replace the authoritative
		// chat state, then run the same projection used after ordinary actions.
		this.#host.store.create(
			session.chatChannel,
			{ ...chat, title, ...(touch ? { modifiedAt: new Date().toISOString() } : {}) },
			"chat",
		);
		this.#syncChatProjection(session);
	}

	// ── History ─────────────────────────────────────────────────────────────

	/** Serves `fetchTurns`; the page is dispatched before this resolves. */
	async fetchTurns(channel: URI, cursor: string | undefined): Promise<void> {
		const session = this.#byChat.get(channel);
		if (!session) {
			throw ProtocolError.notFound(channel);
		}
		dispatchOlderTurns(this.#host, channel, session, cursor);
	}

	async #truncate(session: LiveSession, turnId: string | undefined): Promise<void> {
		const anchor = truncationAnchor(session, turnId);
		if (!anchor) {
			// Validated before the action was applied, so this only happens if
			// the file changed underneath us.
			this.#options.log?.(`no truncation anchor for ${turnId ?? "(all)"} in ${session.uri}`);
			return;
		}
		const applied = await session.driver?.truncate(anchor);
		if (applied === false) {
			// An extension vetoed it. Protocol state is already truncated, so
			// the two have diverged; say so loudly rather than pretend.
			this.#options.log?.(`agent refused truncation of ${session.uri}; state and session now differ`);
		}
	}

	// ── Internals ───────────────────────────────────────────────────────────

	#summaryOf(session: LiveSession): SessionSummary {
		const state = this.#host.store.get(session.uri) as SessionState | undefined;
		if (!state) {
			throw new Error(`Session state is missing: ${session.uri}`);
		}
		return sessionSummaryOf(session.uri, session.createdAt, state, {
			...state._meta,
			piSessionId: session.sessionId,
		});
	}

	/** Publishes only changed root-catalog fields. */
	#publishSummary(session: LiveSession): void {
		const current = this.#summaryOf(session);
		const previous = this.#summaryBaselines.get(session.uri);
		const changes: Partial<SessionSummary> = {};
		if (!previous || current.title !== previous.title) changes.title = current.title;
		if (!previous || current.status !== previous.status) changes.status = current.status;
		if (!previous || current.modifiedAt !== previous.modifiedAt) changes.modifiedAt = current.modifiedAt;
		this.#summaryBaselines.set(session.uri, current);
		if (Object.keys(changes).length > 0) {
			notifySessionSummaryChanged(this.#host, session.uri, changes);
		}
	}

	/**
	 * Projects a reduced chat summary onto its parent session and root catalog.
	 *
	 * The official 0.9 reducer cannot update top-level `SessionState.status`, so
	 * this deliberately leaves that field alone. Clients still receive the live
	 * status in `SessionState.chats[]`, `ChatState`, and the root summary.
	 */
	#syncChatProjection(session: LiveSession): void {
		this.#projectingSessions.add(session.uri);
		let changed = false;
		try {
			changed = syncChatSummary(this.#host, session.uri, session.chatChannel);
			if (!changed) {
				return;
			}

			const state = this.#host.store.get(session.uri) as SessionState | undefined;
			if (!state) {
				return;
			}
			const aggregate = aggregateSessionChats(state);
			if (state.activity !== aggregate.activity) {
				this.#host.dispatchServerAction(session.uri, {
					type: ActionType.SessionActivityChanged,
					activity: aggregate.activity,
				});
			}
		} finally {
			this.#projectingSessions.delete(session.uri);
		}
		if (changed && this.#sessions.get(session.uri) === session) {
			this.#publishSummary(session);
		}
	}

	#track(session: LiveSession): void {
		this.#sessions.set(session.uri, session);
		this.#byChat.set(session.chatChannel, session);
	}

	#notifySessionAvailableToAll(session: LiveSession): void {
		for (const listener of this.#sessionAvailableListeners) this.#notifySessionAvailable(listener, session);
	}

	#notifySessionAvailable(listener: SessionAvailableListener, session: LiveSession): void {
		try {
			listener(session);
		} catch (error) {
			this.#options.log?.(`session availability listener failed for ${session.uri}: ${String(error)}`);
		}
	}

	#bumpActiveSessions(): void {
		this.#host.dispatchServerAction(ROOT_CHANNEL, {
			type: ActionType.RootActiveSessionsChanged,
			activeSessions: this.#sessions.size,
		});
	}
}
