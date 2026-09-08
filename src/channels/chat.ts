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
	type SessionState,
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
		...(state.activity !== undefined ? { activity: state.activity } : {}),
		...(state.origin !== undefined ? { origin: state.origin } : {}),
		...(state.interactivity !== undefined ? { interactivity: state.interactivity } : {}),
		...(state.workingDirectories !== undefined ? { workingDirectories: state.workingDirectories } : {}),
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

function equalUris(left: readonly URI[] | undefined, right: readonly URI[] | undefined): boolean {
	if (!left || !right) {
		return left === right;
	}
	return left.length === right.length && left.every((uri, index) => uri === right[index]);
}

function equalSummary(left: ChatSummary, right: ChatSummary): boolean {
	return (
		left.resource === right.resource &&
		left.title === right.title &&
		left.status === right.status &&
		left.activity === right.activity &&
		left.modifiedAt === right.modifiedAt &&
		(left.origin === right.origin || JSON.stringify(left.origin) === JSON.stringify(right.origin)) &&
		left.interactivity === right.interactivity &&
		equalUris(left.workingDirectories, right.workingDirectories)
	);
}

/**
 * Mirrors a chat's denormalized summary fields into its owning session.
 *
 * Partial updates cannot express removal of an optional JSON field: an
 * `undefined` value disappears on the wire and means "unchanged". Use the
 * action's full-summary upsert form when one of those fields is cleared.
 */
export function syncChatSummary(host: AhpHost, sessionChannel: URI, chatChannel: URI): boolean {
	const chat = host.store.get(chatChannel) as ChatState | undefined;
	const session = host.store.get(sessionChannel) as SessionState | undefined;
	const previous = session?.chats.find((summary) => summary.resource === chatChannel);
	if (!chat || !previous) {
		return false;
	}

	const current = chatSummaryOf(chat);
	if (equalSummary(previous, current)) {
		return false;
	}

	const clearsOptional =
		(previous.activity !== undefined && current.activity === undefined) ||
		(previous.origin !== undefined && current.origin === undefined) ||
		(previous.interactivity !== undefined && current.interactivity === undefined) ||
		(previous.workingDirectories !== undefined && current.workingDirectories === undefined);
	if (clearsOptional) {
		host.dispatchServerAction(sessionChannel, { type: ActionType.SessionChatAdded, summary: current });
	} else {
		const { resource: _resource, ...changes } = current;
		host.dispatchServerAction(sessionChannel, {
			type: ActionType.SessionChatUpdated,
			chat: chatChannel,
			changes,
		});
	}
	return true;
}
