#!/usr/bin/env node
/**
 * Serves pi-ahp in the fixed Dev Tunnel shape VS Code discovers. Dev Tunnels
 * controls remote access; the forwarded loopback listener has no URL token.
 */

import { spawn } from "node:child_process";
import { startHost, VERSION } from "../host/serve.ts";
import { DevTunnelCli, TunnelError } from "../tunnel/devtunnel.ts";
import { displayLabel, nameLabel, TUNNEL_PORT } from "../tunnel/discovery.ts";

function log(message: string): void {
	process.stderr.write(`${message}\n`);
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
				"sets the display label shown by clients; without it, an existing",
				"label is left alone.",
				"",
				"Serves the host over a dev tunnel that compatible AHP clients can",
				"discover. It requires `devtunnel` on PATH and an existing login:",
				"",
				"    devtunnel user login -g      GitHub account",
				"    devtunnel user login         Microsoft account (the default)",
				"",
				"Add -d for device-code auth when there is no browser. See",
				"`devtunnel user login --help` for the rest.",
				"",
				"Does not read or modify pi-ahp's direct-listener settings. The",
				`discovery port is fixed at ${TUNNEL_PORT}; remote access is controlled`,
				"by Microsoft Dev Tunnels rather than an additional URL token.",
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

	const devtunnel = new DevTunnelCli();
	devtunnel.requireLogin();
	const requested = flag("--name");
	const name = requested ? nameLabel(requested) : undefined;
	if (requested && !name) {
		log(`ignoring --name ${requested}: nothing left after removing characters a label cannot hold`);
	}

	const existing = devtunnel.findTunnel();
	let qualifiedId: string;
	if (existing) {
		qualifiedId = existing.tunnelId;
		const current = displayLabel(existing.labels);
		if (name && name !== current) {
			devtunnel.rename(qualifiedId, current, name);
		}
		log(`tunnel: ${qualifiedId} (reused${name && name !== current ? `, renamed to ${name}` : ""})`);
	} else {
		qualifiedId = devtunnel.createTunnel(name);
		log(`tunnel: ${qualifiedId} (new${name ? `, named ${name}` : ""})`);
	}
	devtunnel.ensurePort(qualifiedId);

	// The host must be up before the tunnel forwards to it, or the first client
	// through the relay hits a closed port.
	const server = await startHost({
		host: "127.0.0.1",
		port: TUNNEL_PORT,
		workingDirectory,
		...(verbose ? { log } : {}),
	});
	log(`listening on 127.0.0.1:${server.port}, working directory: ${workingDirectory}`);
	log("remote access control: Microsoft Dev Tunnels; local listener: no URL token");

	const host = spawn("devtunnel", ["host", qualifiedId], { stdio: "inherit" });
	let stopping = false;
	let hostFinished = false;

	// Shutting down goes through the child, not alongside it. Killing the child
	// and exiting in the same tick raced: `devtunnel host` outlives us, keeps the
	// relay connection, and the tunnel looks hosted by a process that is gone.
	const finish = (code: number, failure?: string): void => {
		if (hostFinished) return;
		hostFinished = true;
		if (!stopping && failure) log(failure);
		void server.close().then(() => process.exit(stopping ? 0 : code));
	};
	host.on("exit", (code) => finish(code ?? 1, `devtunnel host exited (${code}); shutting down`));
	host.on("error", (error) => finish(1, `devtunnel host failed: ${error.message}`));

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
	log("Connect from a Dev Tunnel-capable AHP client signed in to the same account.");
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
