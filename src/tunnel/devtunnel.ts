/**
 * Driving the `devtunnel` CLI.
 *
 * Not bundled: it is a 59 MB .NET binary that only tunnel users need, and it
 * has to be logged in before any of this works, so it is expected on PATH.
 *
 * Its interface has several edges worth knowing, and each function below
 * carries the one it works around.
 */

import { spawnSync } from "node:child_process";
import { IDENTITY_LABEL, LAUNCHER_LABEL, PROTOCOL_LABEL, TUNNEL_PORT } from "./vscode.ts";

export function log(message: string): void {
	process.stderr.write(`${message}\n`);
}

export class TunnelError extends Error {}

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

export function requireLogin(): void {
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

export interface Tunnel {
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
export function findTunnel(): Tunnel | undefined {
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

export function createTunnel(name: string | undefined): string {
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
export function ensurePort(id: string): void {
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
export function rename(id: string, from: string | undefined, to: string): void {
	const args = ["update", id, "--add-labels", to];
	if (from) {
		args.push("--remove-labels", from);
	}
	const { status, stdout, stderr } = devtunnel(args);
	if (status !== 0) {
		throw new TunnelError(`devtunnel update failed:\n${(stderr || stdout).trim()}`);
	}
}
