/**
 * Direct `pi-ahp` listener settings, persisted at `~/.pi/ahp/settings.json`.
 *
 * Two file states, deliberately kept apart:
 *
 * - **No file.** Nothing can be defaulted usefully — a port has to be free and
 *   a token has to be secret — so one of each is produced and written out. This
 *   is the only time the host invents anything.
 * - **A file exists.** It is taken literally. A missing `token` means no token,
 *   a missing `port` is an error, and a value of the wrong shape is an error
 *   rather than a silent substitution: a setting quietly replaced by something
 *   the user did not write is worse than a refusal to start.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DirectListenerSettings {
	port: number;
	/** `null` disables the check; clients then connect without `?token=`. */
	token: string | null;
	/** Bind address. Keep on loopback unless clients connect from another machine. */
	host: string;
}

const CONFIG_DIR_NAME = ".pi";
const DEFAULT_HOST = "127.0.0.1";

function getAhpDir(): string {
	const configDir = process.env.PI_CONFIG_DIR || join(homedir(), CONFIG_DIR_NAME);
	return join(configDir, "ahp");
}

function getSettingsPath(): string {
	return process.env.PI_AHP_SETTINGS || join(getAhpDir(), "settings.json");
}

/** Asks the OS for a free port and immediately gives it back. */
async function freePort(): Promise<number> {
	const probe = createServer();
	return new Promise<number>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, DEFAULT_HOST, () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

export class SettingsError extends Error {
	constructor(path: string, detail: string) {
		super(`${path}: ${detail}`);
		this.name = "SettingsError";
	}
}

export async function loadDirectListenerSettings(path: string = getSettingsPath()): Promise<DirectListenerSettings> {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		const settings: DirectListenerSettings = {
			port: await freePort(),
			token: randomBytes(32).toString("base64url"),
			host: DEFAULT_HOST,
		};
		writeSettings(settings, path);
		return settings;
	}

	let stored: Record<string, unknown>;
	try {
		stored = JSON.parse(raw) as Record<string, unknown>;
	} catch (error) {
		throw new SettingsError(path, `not valid JSON (${(error as Error).message})`);
	}

	if (stored.port === undefined) {
		throw new SettingsError(path, "no `port`. Set one, or delete the file to have it chosen.");
	}
	if (!Number.isInteger(stored.port) || (stored.port as number) < 1 || (stored.port as number) > 65535) {
		throw new SettingsError(path, `\`port\` must be an integer 1-65535, got ${JSON.stringify(stored.port)}`);
	}
	if (stored.token !== undefined && stored.token !== null && typeof stored.token !== "string") {
		throw new SettingsError(path, `\`token\` must be a string or null, got ${JSON.stringify(stored.token)}`);
	}
	if (stored.host !== undefined && typeof stored.host !== "string") {
		throw new SettingsError(path, `\`host\` must be a string, got ${JSON.stringify(stored.host)}`);
	}

	return {
		port: stored.port as number,
		// Absent means absent. Only a missing *file* mints a token.
		token: (stored.token as string | null | undefined) ?? null,
		host: (stored.host as string | undefined) ?? DEFAULT_HOST,
	};
}

function writeSettings(settings: DirectListenerSettings, path: string = getSettingsPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	// Owner-only: the token is a bearer credential for the endpoint.
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
