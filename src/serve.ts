/**
 * Starting the host, without deciding where the settings came from.
 *
 * `pi-ahp` reads them from a file; `pi-ahp-tunnel` derives them from a tunnel
 * and never touches one. Routing the tunnel path back through a settings-shaped
 * command line would mean keeping a flag in sync for every value, so both entry
 * points call this instead.
 */

import { createPiHost } from "./pi-host.ts";
import { type RunningServer, serveWebSocket } from "./transport/websocket.ts";

export const VERSION = "0.0.1";

export interface ServeOptions {
	readonly host: string;
	readonly port: number;
	/** Absent or empty disables the upgrade check. */
	readonly token?: string | undefined;
	readonly workingDirectory: string;
	readonly log?: ((message: string) => void) | undefined;
}

export async function startHost(options: ServeOptions): Promise<RunningServer> {
	const { host: ahpHost } = await createPiHost({
		serverInfo: { name: "pi-ahp", version: VERSION },
		defaultDirectory: `file://${options.workingDirectory}`,
		workingDirectory: options.workingDirectory,
		...(options.log ? { log: options.log } : {}),
	});

	return serveWebSocket(ahpHost, {
		host: options.host,
		port: options.port,
		...(options.token ? { token: options.token } : {}),
		...(options.log ? { log: options.log } : {}),
	});
}

/** Closes `server` on SIGINT/SIGTERM. */
export function closeOnSignal(server: RunningServer): void {
	const shutdown = (): void => {
		void server.close().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
