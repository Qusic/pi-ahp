/** Shared display-title rules for live, catalogued, and hydrated sessions. */

export const NEW_SESSION_TITLE = "New Session";
const UNTITLED_SESSION_TITLE = "Untitled session";
const TITLE_FALLBACK_LENGTH = 60;

/** pi displays the first user message when no explicit session name exists. */
export function fallbackSessionTitle(text: string | undefined): string | undefined {
	const collapsed = text?.replace(/\s+/gu, " ").trim() ?? "";
	if (!collapsed) {
		return undefined;
	}
	return collapsed.length > TITLE_FALLBACK_LENGTH ? `${collapsed.slice(0, TITLE_FALLBACK_LENGTH - 1)}…` : collapsed;
}

export function sessionDisplayTitle(name: string | undefined, firstUserMessage: string | undefined): string {
	return name?.trim() || fallbackSessionTitle(firstUserMessage) || UNTITLED_SESSION_TITLE;
}
