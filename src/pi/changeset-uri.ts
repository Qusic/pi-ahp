/** Stable AHP identities and catalogue entries for pi's Git changes views. */

import type { Changeset, URI } from "@microsoft/agent-host-protocol";

const CHANGESET_SCHEME = "ahp-changeset:";

export type PiChangesetKind = "latest-commit" | "uncommitted";

export interface ParsedPiChangesetUri {
	readonly sessionId: string;
	readonly kind: PiChangesetKind;
}

export function piChangesetUri(sessionId: string, kind: PiChangesetKind): URI {
	return `${CHANGESET_SCHEME}/${encodeURIComponent(sessionId)}/${kind}`;
}

export function parsePiChangesetUri(uri: URI): ParsedPiChangesetUri | undefined {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== CHANGESET_SCHEME || parsed.host || parsed.search || parsed.hash) {
		return undefined;
	}
	const match = /^\/([^/]+)\/(latest-commit|uncommitted)$/.exec(parsed.pathname);
	if (!match) {
		return undefined;
	}
	let sessionId: string;
	try {
		sessionId = decodeURIComponent(match[1] ?? "");
	} catch {
		return undefined;
	}
	if (!sessionId || sessionId.includes("/")) {
		return undefined;
	}
	const kind = match[2] as PiChangesetKind;
	return piChangesetUri(sessionId, kind) === uri ? { sessionId, kind } : undefined;
}

export function piChangesetCatalogue(sessionId: string, hasCommit: boolean): Changeset[] {
	return [
		...(hasCommit
			? ([
					{
						label: "Latest Commit",
						description: "Changes introduced by the current HEAD commit",
						changeKind: "branch",
						uriTemplate: piChangesetUri(sessionId, "latest-commit"),
					},
				] satisfies Changeset[])
			: []),
		{
			label: "Uncommitted Changes",
			description: "Current staged, unstaged, and untracked changes",
			changeKind: "uncommitted",
			uriTemplate: piChangesetUri(sessionId, "uncommitted"),
		},
	];
}
