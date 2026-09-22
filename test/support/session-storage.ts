import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionCatalogue } from "../../src/pi/session-catalogue.ts";
import type { PiSessionStorage, SessionManagerFactory } from "../../src/pi/session-storage.ts";

/** New sessions persist beneath a fixture-owned catalogue root. */
export function persistentSessionManagerFactory(sessionRoot: string): SessionManagerFactory {
	const directory = join(sessionRoot, "created");
	return (workingDirectory, sessionId) => SessionManager.create(workingDirectory, directory, { id: sessionId });
}

/** A paired catalogue and writer rooted entirely inside one fixture. */
export function persistentSessionStorage(sessionRoot: string): PiSessionStorage {
	return {
		catalogue: new PiSessionCatalogue(sessionRoot),
		createSessionManager: persistentSessionManagerFactory(sessionRoot),
	};
}

/** Protocol-only fixtures need history identity, not filesystem persistence. */
export const inMemorySessionManagerFactory: SessionManagerFactory = (workingDirectory, sessionId) =>
	SessionManager.inMemory(workingDirectory, { id: sessionId });
