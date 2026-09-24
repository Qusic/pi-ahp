import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Stable pi custom-entry namespace owned by pi-ahp. */
export const SESSION_ARCHIVE_CUSTOM_TYPE = "pi-ahp.session-archive";

interface SessionArchiveEntry {
	readonly isArchived?: unknown;
}

/** The newest valid archive marker wins; absent or malformed entries mean unarchived. */
export function isSessionArchived(sessionManager: SessionManager): boolean {
	let archived = false;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== SESSION_ARCHIVE_CUSTOM_TYPE) continue;
		const data = entry.data as SessionArchiveEntry | undefined;
		if (typeof data?.isArchived === "boolean") archived = data.isArchived;
	}
	return archived;
}

/** Appends an archive-state marker to pi's durable session transcript. */
export function persistSessionArchived(sessionManager: SessionManager, isArchived: boolean): void {
	sessionManager.appendCustomEntry(SESSION_ARCHIVE_CUSTOM_TYPE, { isArchived });
}
