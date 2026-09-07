/** Shared host construction; each entry point owns its endpoint and authentication policy. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileUri } from "../core/uri.ts";
import { type RunningServer, serveWebSocket } from "../transport/websocket.ts";
import { createPiHost } from "./pi-host.ts";

/**
 * Read from the manifest rather than restated here.
 *
 * The name and version go out in `serverInfo` during the handshake, so a copy
 * that drifts from the package tells clients something untrue about what they
 * are connected to. Resolved relative to this file, which keeps working when
 * the package is installed somewhere else.
 */
const manifest = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
) as { name: string; version: string };

export const NAME = manifest.name;
export const VERSION = manifest.version;

export interface ServeOptions {
	readonly host: string;
	readonly port: number;
	/** Absent or empty disables the WebSocket upgrade credential. */
	readonly connectionToken?: string | undefined;
	readonly workingDirectory: string;
	readonly log?: ((message: string) => void) | undefined;
}

export async function startHost(options: ServeOptions): Promise<RunningServer> {
	const {
		host: ahpHost,
		terminals,
		watches,
	} = await createPiHost({
		serverInfo: { name: NAME, version: VERSION },
		defaultDirectory: pathToFileUri(options.workingDirectory),
		workingDirectory: options.workingDirectory,
		...(options.log ? { log: options.log } : {}),
	});

	const server = await serveWebSocket(ahpHost, {
		host: options.host,
		port: options.port,
		...(options.connectionToken ? { connectionToken: options.connectionToken } : {}),
		...(options.log ? { log: options.log } : {}),
	});
	return {
		...server,
		async close() {
			terminals.shutdown();
			await Promise.all([server.close(), watches.dispose()]);
		},
	};
}

/** Closes `server` on SIGINT/SIGTERM. */
export function closeOnSignal(server: RunningServer): void {
	const shutdown = (): void => {
		void server.close().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
