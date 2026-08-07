/**
 * The chat channel — `ahp-chat:/<uuid>`.
 *
 * Every session this host serves has exactly one chat. That is why the agent
 * declares no `multipleChats` capability: its absence is the protocol's way of
 * telling a client not to call `createChat`.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/chat-channel
 */

import {
	ActionType,
	ChatOriginKind,
	type ChatState,
	type ChatSummary,
	MessageKind,
	type ModelSelection,
	SessionStatus,
	type URI,
} from "@microsoft/agent-host-protocol";
import { chatUri } from "../core/channels.ts";
import type { AhpHost } from "../core/host.ts";

export function initialChatState(uri: URI, title: string, selection?: ModelSelection): ChatState {
	return {
		resource: uri,
		title,
		status: SessionStatus.Idle,
		modifiedAt: new Date().toISOString(),
		// A session's default chat exists because the user made the session.
		origin: { kind: ChatOriginKind.User },
		turns: [],
		// Seeded before the agent exists. Starting one takes seconds, and a
		// client that subscribes in the meantime would otherwise find an empty
		// model picker and be unable to send. The backend refines this once it
		// is up, if it resolves to something different.
		...(selection ? { draft: { text: "", origin: { kind: MessageKind.User }, model: selection } } : {}),
	};
}

export function chatSummaryOf(state: ChatState): ChatSummary {
	return {
		resource: state.resource,
		title: state.title,
		status: state.status,
		modifiedAt: state.modifiedAt,
		...(state.activity ? { activity: state.activity } : {}),
		...(state.origin ? { origin: state.origin } : {}),
	};
}

/**
 * Creates a session's default chat and registers it in the session catalog.
 *
 * The chat id is derived from the session id so that the pairing is
 * reconstructible without a lookup table, matching how the session URI already
 * carries pi's session id.
 */
export function installDefaultChat(
	host: AhpHost,
	sessionChannel: URI,
	sessionId: string,
	title: string,
	selection?: ModelSelection,
): URI {
	const uri = chatUri(sessionId);
	host.store.create(uri, initialChatState(uri, title, selection));

	const summary = chatSummaryOf(host.store.get(uri) as ChatState);
	host.dispatchServerAction(sessionChannel, { type: ActionType.SessionChatAdded, summary });
	host.dispatchServerAction(sessionChannel, { type: ActionType.SessionDefaultChatChanged, defaultChat: uri });
	return uri;
}

/**
 * Mirrors a chat's summary fields back onto the owning session's catalog.
 *
 * `ChatState` denormalises every `ChatSummary` field, so the two representations
 * drift unless the producer republishes on every change. Clients that only watch
 * the session (a session list, a mobile app) see nothing otherwise.
 */
export function syncChatSummary(host: AhpHost, sessionChannel: URI, chatChannel: URI): void {
	const state = host.store.get(chatChannel) as ChatState | undefined;
	if (!state) {
		return;
	}
	host.dispatchServerAction(sessionChannel, {
		type: ActionType.SessionChatUpdated,
		chat: chatChannel,
		changes: chatSummaryOf(state),
	});
}
