/**
 * Loads a durable pi session into live channel state.
 *
 * Sessions outlive the host process: pi writes them to
 * `~/.pi/agent/sessions/**`, `listSessions` reports them, and a client then
 * subscribes to one. Only sessions this host created are in memory, so opening
 * any other one has to reconstruct its channels from disk — otherwise
 * `subscribe` answers `NotFound` for a session the catalogue just advertised.
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	type ChatState,
	MessageKind,
	type ModelSelection,
	SessionLifecycle,
	type SessionState,
	SessionStatus,
	type URI,
} from "@microsoft/agent-host-protocol";
import { chatSummaryOf } from "../channels/chat.ts";
import { chatIdFromUri, chatUri, isChatChannel, permissiveSessionId, sessionUri } from "../core/channels.ts";
import type { AhpHost, ChannelHydrator } from "../core/host.ts";
import { rebuildTurnsFromSession } from "./history.ts";
import { THINKING_CONFIG_KEY } from "./models.ts";
import { PI_PROVIDER } from "./provider.ts";
import type { PiSessionCatalogue } from "./session-catalogue.ts";
import { initialTurnsCursor } from "./turn-paging.ts";

export interface SessionHydratorOptions {
	readonly host: AhpHost;
	readonly catalogue: PiSessionCatalogue;
	/** Sessions this host already has live; those must never be reloaded over. */
	readonly isLive: (sessionChannel: URI) => boolean;
	/**
	 * The model to show when the session file records none.
	 *
	 * A hydrated session has no agent yet, so nothing else can answer "which
	 * model is selected" — and a client with an empty picker cannot send.
	 */
	readonly fallbackSelection?: () => ModelSelection | undefined;
	/**
	 * Registers the loaded session so it can later run turns.
	 *
	 * Without this a resumed session is read-only in a way nothing reports:
	 * the client's message reduces into state and echoes back, but no agent is
	 * listening and no reply ever comes.
	 */
	readonly adopt?: (session: {
		uri: URI;
		sessionId: string;
		workingDirectory: string;
		sessionManager: SessionManager;
		chatChannel: URI;
		createdAt: string;
	}) => void;
	readonly log?: (message: string) => void;
}

export class SessionHydrator implements ChannelHydrator {
	readonly #options: SessionHydratorOptions;

	constructor(options: SessionHydratorOptions) {
		this.#options = options;
	}

	async hydrate(channel: URI): Promise<boolean> {
		// A chat and its session share one id, so either URI loads the pair.
		// Session URIs are matched permissively: clients written against the
		// reference host still use `<provider>:/<uuid>`.
		const sessionId = isChatChannel(channel) ? chatIdFromUri(channel) : permissiveSessionId(channel);
		if (!sessionId) {
			return false;
		}

		// Register the session under the URI the client actually used, so a
		// non-standard scheme resolves to the same channel it subscribed to.
		const session = isChatChannel(channel) ? sessionUri(sessionId) : channel;
		const chat = chatUri(sessionId);
		if (this.#options.isLive(session)) {
			// Already running: its in-memory state is authoritative and must not
			// be overwritten with what happens to be on disk.
			return this.#options.host.store.has(channel);
		}

		const file = await this.#options.catalogue.findSessionFile(sessionId);
		if (!file) {
			return false;
		}

		let manager: SessionManager;
		try {
			manager = SessionManager.open(file);
		} catch (error) {
			this.#options.log?.(`cannot open ${file}: ${String(error)}`);
			return false;
		}

		const turns = rebuildTurnsFromSession(manager, { turnIdPrefix: sessionId });
		// Present only when the window really is a tail: its presence is the
		// protocol's signal that more history can be paged in.
		const turnsNextCursor = initialTurnsCursor(manager, sessionId, turns);
		const lastTurn = turns[turns.length - 1];
		const modifiedAt = lastTurn?.startedAt ?? new Date().toISOString();
		const workingDirectory = manager.getCwd();
		const title = manager.getSessionName()?.trim() || firstUserText(turns) || "Untitled session";

		// Read, for the same reason the catalogue reports read — see
		// `readSessionSummary`. The reducer still clears the bit if a turn starts.
		const status = SessionStatus.Idle | SessionStatus.IsRead;

		// Which model this conversation was last using. The agent starts only on
		// the first new turn, so without seeding it here the client's model
		// picker is empty until the user has already sent something.
		//
		// The recorded model is checked field by field: a session file can carry a
		// partially-populated entry, and a selection without an `id` is worse than
		// none — it fails validation and still leaves the picker empty.
		const recorded = manager.buildSessionContext();
		const recordedId = recorded.model?.modelId;
		const selection: ModelSelection | undefined =
			typeof recordedId === "string" && recordedId.length > 0
				? { id: recordedId, config: { [THINKING_CONFIG_KEY]: recorded.thinkingLevel } }
				: this.#options.fallbackSelection?.();

		const chatState: ChatState = {
			resource: chat,
			title,
			status,
			modifiedAt,
			turns,
			...(turnsNextCursor ? { turnsNextCursor } : {}),
			...(selection ? { draft: { text: "", origin: { kind: MessageKind.User }, model: selection } } : {}),
		};
		this.#options.host.store.create(chat, chatState);

		const sessionState: SessionState = {
			provider: PI_PROVIDER,
			title,
			status,
			// The transcript is genuinely available, so the session is ready. It
			// simply has no agent attached until someone starts a turn.
			lifecycle: SessionLifecycle.Ready,
			...(workingDirectory ? { workingDirectories: [`file://${workingDirectory}`] } : {}),
			activeClients: [],
			chats: [chatSummaryOf(chatState)],
			defaultChat: chat,
			_meta: { piSessionFile: file, hydrated: true },
		};
		this.#options.host.store.create(session, sessionState, "session");

		this.#options.adopt?.({
			uri: session,
			sessionId,
			workingDirectory,
			sessionManager: manager,
			chatChannel: chat,
			createdAt: turns[0]?.startedAt ?? modifiedAt,
		});

		this.#options.log?.(`hydrated ${session} with ${turns.length} turns`);
		return this.#options.host.store.has(channel);
	}
}

function firstUserText(turns: readonly { message: { text: string } }[]): string | undefined {
	for (const turn of turns) {
		const text = turn.message.text.trim();
		if (text) {
			return text.length > 60 ? `${text.slice(0, 59)}…` : text;
		}
	}
	return undefined;
}
