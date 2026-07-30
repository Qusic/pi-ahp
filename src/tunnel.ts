#!/usr/bin/env node
/**
 * `pi-ahp-tunnel` — serves the host over a Microsoft dev tunnel, in the shape
 * VS Code discovers.
 *
 * VS Code finds agent hosts by listing tunnels labelled `vscode-server-launcher`
 * with a `protocolvN` label of at least 5, connecting to a fixed port, and
 * deriving the connection token from the tunnel id. All four are hard-coded in
 * its `tunnelAgentHostService`, so none of them is configurable here — which is
 * also why this command reads no settings file: every value it needs is either
 * fixed by VS Code or computed from the tunnel.
 *
 * The `devtunnel` CLI is not bundled. It is a 59 MB .NET binary that only
 * tunnel users need, and it has to be logged in anyway, so this expects one on
 * PATH rather than shipping or wrapping it.
 */

import { spawn, spawnSync } from "node:child_process";
import { startHost, VERSION } from "./serve.ts";
import {
	deriveConnectionToken,
	displayLabel,
	IDENTITY_LABEL,
	LAUNCHER_LABEL,
	nameLabel,
	PROTOCOL_LABEL,
	splitTunnelId,
	TUNNEL_PORT,
} from "./vscode-tunnel.ts";

function log(message: string): void {
	process.stderr.write(`${message}\n`);
}

class TunnelError extends Error {}

/** Both streams: the CLI reports success as JSON on stdout and errors on stderr. */
function devtunnel(args: string[]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("devtunnel", args, { encoding: "utf8" });
	if (result.error) {
		throw new TunnelError(
			[
				"`devtunnel` not found on PATH.",
				"",
				"Install it from https://aka.ms/devtunnels/download, then log in:",
				"",
				"    devtunnel user login -g      GitHub account",
				"    devtunnel user login         Microsoft account (the default)",
			].join("\n"),
		);
	}
	return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr ?? "" };
}

function requireLogin(): void {
	const { stdout } = devtunnel(["user", "show", "--json"]);
	if (/not logged in/i.test(stdout)) {
		throw new TunnelError(
			[
				"`devtunnel` is not logged in. Run one of:",
				"",
				"    devtunnel user login -g      GitHub account",
				"    devtunnel user login         Microsoft account (the default)",
				"",
				"Add -d for device-code auth when there is no browser.",
			].join("\n"),
		);
	}
}

interface Tunnel {
	readonly tunnelId: string;
	readonly labels: readonly string[];
}

/**
 * This host's tunnel, if a previous run made one.
 *
 * Repeating `--all-labels` is what ANDs them; a space-separated value is read
 * as one label whose name contains a space, which matches nothing. With no
 * match the CLI answers `{"warning": ...}` rather than an empty list.
 */
function findTunnel(): Tunnel | undefined {
	const { status, stdout } = devtunnel([
		"list",
		"--all-labels",
		IDENTITY_LABEL,
		"--all-labels",
		LAUNCHER_LABEL,
		"--json",
	]);
	if (status !== 0) {
		return undefined;
	}
	const found = (JSON.parse(stdout) as { tunnels?: Tunnel[] }).tunnels?.[0];
	return found?.tunnelId ? found : undefined;
}

function createTunnel(name: string | undefined): string {
	const labels = [LAUNCHER_LABEL, PROTOCOL_LABEL, IDENTITY_LABEL, ...(name ? [name] : [])];
	const created = devtunnel(["create", "--json", ...labels.flatMap((label) => ["-l", label])]);
	if (created.status !== 0) {
		throw new TunnelError(`devtunnel create failed:\n${(created.stderr || created.stdout).trim()}`);
	}
	const id = (JSON.parse(created.stdout) as { tunnel?: { tunnelId?: string } }).tunnel?.tunnelId;
	if (!id) {
		throw new TunnelError(`devtunnel create returned no tunnel id:\n${created.stdout.trim()}`);
	}
	return id;
}

/**
 * Adds the port VS Code looks for, if it is not already there.
 *
 * Passing `-p` to `devtunnel host` instead fails on an existing tunnel with
 * "Batch update of ports is not supported". `https` rather than the CLI's
 * `auto` default is what VS Code sets on its own tunnels.
 */
function ensurePort(id: string): void {
	const { status, stdout, stderr } = devtunnel([
		"port",
		"create",
		id,
		"-p",
		String(TUNNEL_PORT),
		"--protocol",
		"https",
		"--json",
	]);
	// Re-adding the port answers "Conflict with existing entity", on stderr,
	// with a non-zero status — which is the normal path on every run after the
	// first, not a failure.
	if (status !== 0 && !/conflict with existing/i.test(stderr)) {
		throw new TunnelError(`devtunnel port create failed:\n${(stderr || stdout).trim()}`);
	}
}

/** Swaps the display label, leaving the identity and protocol labels alone. */
function rename(id: string, from: string | undefined, to: string): void {
	const args = ["update", id, "--add-labels", to];
	if (from) {
		args.push("--remove-labels", from);
	}
	const { status, stdout, stderr } = devtunnel(args);
	if (status !== 0) {
		throw new TunnelError(`devtunnel update failed:\n${(stderr || stdout).trim()}`);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		log(
			[
				`pi-ahp-tunnel v${VERSION}`,
				"",
				"Usage: pi-ahp-tunnel [--name <label>] [--cwd <path>] [--verbose]",
				"",
				"Reuses this host's tunnel, creating one on the first run. `--name`",
				"sets what VS Code shows in its list; without it, a name given here",
				"or in VS Code earlier is left alone.",
				"",
				"Serves the host over a dev tunnel that VS Code discovers. Needs a",
				"`devtunnel` on PATH, already logged in:",
				"",
				"    devtunnel user login -g      GitHub account",
				"    devtunnel user login         Microsoft account (the default)",
				"",
				"Add -d for device-code auth when there is no browser. See",
				"`devtunnel user login --help` for the rest.",
				"",
				"Reads no settings: the port and token are fixed by what VS Code",
				`looks for (port ${TUNNEL_PORT}, token derived from the tunnel id).`,
			].join("\n"),
		);
		return;
	}

	const flag = (name: string): string | undefined => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const verbose = args.includes("--verbose");
	const workingDirectory = flag("--cwd") ?? process.cwd();

	requireLogin();
	const requested = flag("--name");
	const name = requested ? nameLabel(requested) : undefined;
	if (requested && !name) {
		log(`ignoring --name ${requested}: nothing left after removing characters a label cannot hold`);
	}

	const existing = findTunnel();
	let qualifiedId: string;
	if (existing) {
		qualifiedId = existing.tunnelId;
		const current = displayLabel(existing.labels);
		if (name && name !== current) {
			rename(qualifiedId, current, name);
		}
		log(`tunnel: ${qualifiedId} (reused${name && name !== current ? `, renamed to ${name}` : ""})`);
	} else {
		qualifiedId = createTunnel(name);
		log(`tunnel: ${qualifiedId} (new${name ? `, named ${name}` : ""})`);
	}
	ensurePort(qualifiedId);
	const { tunnelId } = splitTunnelId(qualifiedId);

	// The host must be up before the tunnel forwards to it, or the first client
	// through the relay hits a closed port.
	const server = await startHost({
		host: "127.0.0.1",
		port: TUNNEL_PORT,
		token: deriveConnectionToken(tunnelId),
		workingDirectory,
		...(verbose ? { log } : {}),
	});
	log(`listening on 127.0.0.1:${server.port}, working directory: ${workingDirectory}`);

	const host = spawn("devtunnel", ["host", qualifiedId], { stdio: "inherit" });
	let stopping = false;

	// Shutting down goes through the child's `exit`, not alongside it. Killing
	// the child and exiting in the same tick raced: `devtunnel host` outlives
	// us, keeps the relay connection, and the tunnel looks hosted by a process
	// that is gone.
	host.on("exit", (code) => {
		if (!stopping) {
			log(`devtunnel host exited (${code}); shutting down`);
		}
		void server.close().then(() => process.exit(stopping ? 0 : (code ?? 1)));
	});

	const stop = (): void => {
		if (stopping) {
			// A second Ctrl-C means the wait itself is the problem.
			process.exit(1);
		}
		stopping = true;
		host.kill();
		// A child that will not take SIGTERM should not wedge the terminal;
		// an orphaned relay is the lesser failure.
		setTimeout(() => host.kill("SIGKILL"), 5000).unref();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	log("");
	log("In VS Code, enable `chat.remoteAgentHostsEnabled` and sign in to the");
	log("same account; the tunnel appears in the agent host list.");
}

try {
	await main();
} catch (error) {
	if (error instanceof TunnelError) {
		process.stderr.write(`pi-ahp-tunnel: ${error.message}\n`);
		process.exit(1);
	}
	throw error;
}
