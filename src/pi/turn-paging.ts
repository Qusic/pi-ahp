/**
 * Paging older turns into a chat.
 *
 * A hydrated chat initially shows a tail of complete user-visible turns from
 * pi's current branch. Compaction changes the model context, not this history.
 * `fetchTurns` prepends older complete turns with `chat/turnsLoaded` and updates
 * or clears the cursor before responding.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/chat-channel
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Turn } from "@microsoft/agent-host-protocol";
import { rebuildHistory } from "./history.ts";

/** Turns per page. Large enough to be worth a round-trip, small enough to stay cheap. */
export const DEFAULT_PAGE_SIZE = 20;

export interface TurnsPage {
	/** Oldest-first, as the action requires. */
	readonly turns: Turn[];
	/** Cursor for the next page older than this one, absent when at the beginning. */
	readonly nextCursor?: string;
}

/** The same chronological branch and turn identities used by hydration. */
function fullBranchTurns(manager: SessionManager, prefix: string): Turn[] {
	return rebuildHistory(manager.getBranch(), { turnIdPrefix: prefix }).turns;
}

/** Initial complete-turn tail; a cursor means earlier turns remain available. */
export function initialTurnsWindow(full: readonly Turn[], limit: number = DEFAULT_PAGE_SIZE): TurnsPage {
	const start = Math.max(0, full.length - Math.max(1, limit));
	const turns = full.slice(start);
	return { turns, ...(start > 0 && turns[0] ? { nextCursor: turns[0].id } : {}) };
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
): TurnsPage {
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
