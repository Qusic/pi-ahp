/**
 * Paging older turns into a chat.
 *
 * A hydrated chat shows the window pi itself renders — everything back to the
 * most recent compaction. The conversation before that is still on disk, and
 * without a way to reach it a long, repeatedly-compacted session looks like it
 * only ever had its last few exchanges.
 *
 * `fetchTurns` is that way. The command returns nothing itself: the host
 * dispatches `chat/turnsLoaded`, which prepends the older turns into the same
 * reduced state and updates or clears the cursor.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/chat-channel
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Turn } from "@microsoft/agent-host-protocol";
import { rebuildHistory } from "./history.ts";

/** Turns per page. Large enough to be worth a round-trip, small enough to stay cheap. */
export const DEFAULT_PAGE_SIZE = 20;

export interface OlderTurnsPage {
	/** Oldest-first, as the action requires. */
	readonly turns: Turn[];
	/** Cursor for the next page older than this one, absent when at the beginning. */
	readonly nextCursor?: string;
}

/**
 * Every turn on the session's current branch, ignoring compaction.
 *
 * `getBranch()` walks root→leaf, so it sees the whole conversation; the visible
 * window comes from `buildContextEntries()`, which starts at the last
 * compaction. Turn ids are derived from the entry that opened each turn, so the
 * two rebuilds agree on ids wherever they overlap — which is also what lets the
 * reducer dedupe a page against what the client already holds.
 */
function fullBranchTurns(manager: SessionManager, prefix: string): Turn[] {
	return rebuildHistory(manager.getBranch(), { turnIdPrefix: prefix }).turns;
}

/**
 * The cursor to publish for a chat, or `undefined` when nothing older exists.
 *
 * Its presence is the protocol's signal that `turns` is a tail window rather
 * than the whole conversation.
 */
export function initialTurnsCursor(
	manager: SessionManager,
	prefix: string,
	visible: readonly Turn[],
): string | undefined {
	const oldestVisible = visible[0];
	if (!oldestVisible) {
		return undefined;
	}
	const full = fullBranchTurns(manager, prefix);
	const boundary = full.findIndex((turn) => turn.id === oldestVisible.id);
	// `boundary <= 0` means the visible window already starts at the beginning.
	return boundary > 0 ? oldestVisible.id : undefined;
}

/**
 * Loads the page immediately older than `cursor`.
 *
 * The cursor names the oldest turn the client currently holds, so paging is
 * anchored to content rather than to an offset — appending to a session cannot
 * shift it, and a cursor for a turn that has since been truncated away simply
 * finds nothing rather than returning the wrong slice.
 */
export function loadOlderTurns(
	manager: SessionManager,
	prefix: string,
	cursor: string | undefined,
	limit: number = DEFAULT_PAGE_SIZE,
): OlderTurnsPage {
	if (!cursor) {
		return { turns: [] };
	}
	const full = fullBranchTurns(manager, prefix);
	const boundary = full.findIndex((turn) => turn.id === cursor);
	if (boundary <= 0) {
		return { turns: [] };
	}

	const start = Math.max(0, boundary - Math.max(1, limit));
	const turns = full.slice(start, boundary);
	return {
		turns,
		// More remains only if this page did not reach the beginning.
		...(start > 0 && turns[0] ? { nextCursor: turns[0].id } : {}),
	};
}
