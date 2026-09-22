import { join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionCatalogue } from "./session-catalogue.ts";

/** Allocates pi's canonical history manager for a newly created session. */
export type SessionManagerFactory = (workingDirectory: string, sessionId: string) => SessionManager;

/** Paired read/write boundary for pi's durable session corpus. */
export interface PiSessionStorage {
	readonly catalogue: PiSessionCatalogue;
	readonly createSessionManager: SessionManagerFactory;
}

/** Pi's standard durable, cwd-partitioned session tree. */
const durableSessionManagerFactory: SessionManagerFactory = (workingDirectory, sessionId) =>
	SessionManager.create(workingDirectory, undefined, { id: sessionId });

/**
 * Production storage follows the SDK default: SessionManager resolves each
 * cwd-partitioned write directory, while the catalogue scans the matching
 * `getAgentDir()/sessions` root. Pi's separate session-dir precedence lives in
 * its CLI rather than an exported SDK resolver, so the host does not duplicate it.
 */
export function createDefaultPiSessionStorage(): PiSessionStorage {
	return {
		catalogue: new PiSessionCatalogue(join(getAgentDir(), "sessions")),
		createSessionManager: durableSessionManagerFactory,
	};
}
