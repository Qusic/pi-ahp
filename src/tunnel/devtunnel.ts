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

export class TunnelError extends Error {}

interface CommandResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface PortDetails {
	readonly protocol?: unknown;
	readonly accessControl?: unknown;
}

/** Both streams: the CLI reports success as JSON on stdout and errors on stderr. */
function devtunnel(args: string[]): CommandResult {
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

function createPort(id: string): CommandResult {
	return devtunnel(["port", "create", id, "-p", String(TUNNEL_PORT), "--protocol", "http", "--json"]);
}

/**
 * Ensures the fixed port uses an HTTP origin. The relay terminates TLS, while
 * pi-ahp's local listener speaks HTTP/WebSocket. Since the CLI cannot update a
 * port's protocol, an old uncustomized `https` port is replaced; a port-specific
 * ACL is never discarded automatically.
 */
export function ensurePort(id: string): void {
	const shown = devtunnel(["port", "show", id, "-p", String(TUNNEL_PORT), "--json"]);
	if (shown.status === 0) {
		let port: PortDetails | undefined;
		try {
			port = (JSON.parse(shown.stdout) as { port?: PortDetails }).port;
		} catch {
			throw new TunnelError(`devtunnel port show returned invalid JSON:\n${shown.stdout.trim()}`);
		}
		if (port?.protocol === "http") return;
		if (typeof port?.protocol !== "string") {
			throw new TunnelError(`devtunnel port show returned no protocol:\n${shown.stdout.trim()}`);
		}
		const hasPortAcl = Array.isArray(port.accessControl) ? port.accessControl.length > 0 : port.accessControl != null;
		if (hasPortAcl) {
			throw new TunnelError(
				`devtunnel port ${TUNNEL_PORT} uses ${port.protocol} and has port-specific access control; replace it manually`,
			);
		}

		const removed = devtunnel(["port", "delete", id, "-p", String(TUNNEL_PORT), "--json"]);
		if (removed.status !== 0) {
			throw new TunnelError(`devtunnel port delete failed:\n${(removed.stderr || removed.stdout).trim()}`);
		}
	} else if (!/tunnel port not found/i.test(shown.stderr || shown.stdout)) {
		throw new TunnelError(`devtunnel port show failed:\n${(shown.stderr || shown.stdout).trim()}`);
	}

	const created = createPort(id);
	if (created.status !== 0) {
		throw new TunnelError(`devtunnel port create failed:\n${(created.stderr || created.stdout).trim()}`);
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
