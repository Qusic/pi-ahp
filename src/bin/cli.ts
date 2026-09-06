#!/usr/bin/env node
/**
 * `pi-ahp` — starts the host and prints the endpoint clients connect to.
 */

import { loadDirectListenerSettings, SettingsError } from "../host/direct-settings.ts";
import { closeOnSignal, startHost, VERSION } from "../host/serve.ts";

function log(message: string): void {
	process.stderr.write(`${message}\n`);
}

function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		log(
			[
				`pi-ahp v${VERSION}`,
				"",
				"Usage: pi-ahp [--port <n>] [--host <addr>] [--cwd <path>] [--verbose]",
				"",
				"Direct-listener settings persist at ~/.pi/ahp/settings.json; the",
				"port and token are generated on first run.",
			].join("\n"),
		);
		return;
	}

	const verbose = args.includes("--verbose");
	const settings = await loadDirectListenerSettings();
	const workingDirectory = flagValue(args, "--cwd") ?? process.cwd();

	const server = await startHost({
		host: flagValue(args, "--host") ?? settings.host,
		port: Number(flagValue(args, "--port") ?? settings.port),
		connectionToken: settings.token ?? undefined,
		workingDirectory,
		...(verbose ? { log } : {}),
	});

	log(
		settings.token
			? `pi-ahp listening on ws://${server.host}:${server.port}?token=${settings.token}`
			: `pi-ahp listening on ws://${server.host}:${server.port} (no token — anyone who can reach ${server.host} can drive the agent)`,
	);
	log(`working directory: ${workingDirectory}`);

	closeOnSignal(server);
}

try {
	await main();
} catch (error) {
	// A settings problem is the user's to fix, not a crash: print what is wrong
	// and where, without a stack trace pointing into the store.
	if (error instanceof SettingsError) {
		process.stderr.write(`pi-ahp: ${error.message}\n`);
		process.exit(1);
	}
	throw error;
}
