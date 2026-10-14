/**
 * The parts of a session that are about its *history file* rather than its
 * lifecycle: paging older turns in, and resolving where a truncation lands.
 *
 * Both are questions about pi's append-only entry tree, not about registries or
 * channels, and both need the same two things — a session manager and the id
 * prefix its turn ids were built from. Keeping them beside the rebuild they
 * depend on means the registry stays about *live sessions* instead of also
 * knowing how a turn id maps onto a session entry.
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { ActionType, type ChatState, type URI } from "@microsoft/agent-host-protocol";
import type { AhpHost } from "../core/host.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { CLEAR_ALL_ANCHOR, rebuildHistoryFromSession } from "./history.ts";
import { DEFAULT_PAGE_SIZE, loadOlderTurns } from "./turn-paging.ts";

/** The session file, and the prefix its turn ids were derived from. */
export interface HistorySource {
	readonly sessionManager: SessionManager;
	readonly sessionId: string;
	/**
	 * Anchors already known for turns this host ran itself.
	 *
	 * Consulted first because a live turn's id came from the client and cannot
	 * be recomputed from the file.
	 */
	readonly turnAnchors: ReadonlyMap<string, string>;
}

/**
 * Resolves the pi entry a `chat/truncated` names.
 *
 * `undefined` turnId means "clear everything", which maps to the very first
 * user message: navigating to a user entry lands the leaf on its parent, and
 * the first one's parent is `null`.
 */
export function truncationAnchor(source: HistorySource, turnId: string | undefined): string | undefined {
	const key = turnId ?? CLEAR_ALL_ANCHOR;
	const known = source.turnAnchors.get(key);
	if (known) {
		return known;
	}
	// A turn this host never ran: recompute from the file, which is where a
	// hydrated session's ids came from in the first place.
	return rebuildHistoryFromSession(source.sessionManager, { turnIdPrefix: source.sessionId }).anchors.get(key);
}

/** Materializes a paged-away turn before an action names it. */
export function loadTruncationTarget(host: AhpHost, channel: URI, source: HistorySource, turnId: string): void {
	const state = host.store.get(channel) as ChatState | undefined;
	if (state?.turns.some((turn) => turn.id === turnId)) return;
	const oldest = state?.turns[0];
	if (!oldest || !state.turnsNextCursor) {
		throw ProtocolError.invalidParams(`Turn ${turnId} is not in the chat's loaded history`);
	}

	const full = rebuildHistoryFromSession(source.sessionManager, { turnIdPrefix: source.sessionId }).turns;
	const target = full.findIndex((turn) => turn.id === turnId);
	const boundary = full.findIndex((turn) => turn.id === oldest.id);
	if (target < 0 || boundary <= target) {
		throw ProtocolError.invalidParams(`Turn ${turnId} is not older than the chat's visible history`);
	}
	// chat/truncated cannot name an unloaded turn: its reducer would be a no-op.
	// Prepend bounded pages, newest first, before the client action is committed.
	for (let end = boundary; end > target; ) {
		const start = Math.max(target, end - DEFAULT_PAGE_SIZE);
		const turns = full.slice(start, end);
		host.dispatchServerAction(channel, {
			type: ActionType.ChatTurnsLoaded,
			turns,
			...(start > 0 && turns[0] ? { turnsNextCursor: turns[0].id } : {}),
		});
		end = start;
	}
}

/** Serves `fetchTurns`, dispatching the page before the request resolves. */
export function dispatchOlderTurns(
	host: AhpHost,
	channel: URI,
	source: HistorySource,
	cursor: string | undefined,
): void {
	const state = host.store.get(channel) as ChatState | undefined;
	if (cursor !== undefined && cursor !== state?.turnsNextCursor) {
		throw ProtocolError.invalidParams(`Unrecognised fetchTurns cursor for ${channel}`);
	}

	const page = loadOlderTurns(source.sessionManager, source.sessionId, cursor);
	// Dispatched even when empty: it is what clears a cursor that has no more
	// history behind it, so the client stops asking.
	host.dispatchServerAction(channel, {
		type: ActionType.ChatTurnsLoaded,
		turns: page.turns,
		...(page.nextCursor ? { turnsNextCursor: page.nextCursor } : {}),
	});
}
