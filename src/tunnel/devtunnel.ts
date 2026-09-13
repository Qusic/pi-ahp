/**
 * Driving the `devtunnel` CLI.
 *
 * Not bundled: it is a separate .NET CLI that only tunnel users need, and it
 * must be installed and logged in before these operations can run.
 *
 * The CLI's JSON is decoded at this boundary. Decoders accept additive fields
 * but reject missing or malformed fields that the host relies on.
 */

import { spawnSync } from "node:child_process";
import { IDENTITY_LABEL, LAUNCHER_LABEL, PROTOCOL_LABEL, TUNNEL_PORT } from "./discovery.ts";

export class TunnelError extends Error {}

export interface DevTunnelCommandResult {
	readonly status: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type DevTunnelRunner = (args: readonly string[]) => DevTunnelCommandResult;

interface PortDetails {
	readonly portNumber: number;
	readonly protocol: string;
	readonly accessControl?: unknown;
}

export interface Tunnel {
	readonly tunnelId: string;
	readonly labels: readonly string[];
}

// Process boundary ----------------------------------------------------------

function missingCliError(): TunnelError {
	return new TunnelError(
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

function spawnDevtunnel(args: readonly string[]): DevTunnelCommandResult {
	const result = spawnSync("devtunnel", [...args], { encoding: "utf8" });
	if (result.error) {
		const error = result.error as NodeJS.ErrnoException;
		if (error.code === "ENOENT") {
			throw missingCliError();
		}
		throw new TunnelError(`failed to start devtunnel:\n${error.message}`);
	}
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function failureDetail(result: DevTunnelCommandResult): string {
	const termination = result.signal
		? `signal ${result.signal}`
		: result.status === null
			? "no exit status"
			: `exit status ${result.status}`;
	const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean);
	return [termination, ...output].join("\n");
}

function payload(stdout: string): string {
	return stdout.trim() || "<empty output>";
}

function parseObject(command: string, stdout: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new TunnelError(`devtunnel ${command} returned invalid JSON:\n${payload(stdout)}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TunnelError(`devtunnel ${command} returned an unexpected JSON value:\n${payload(stdout)}`);
	}
	return value as Record<string, unknown>;
}

// Command-specific JSON decoders -------------------------------------------

function unexpectedResponse(command: string, stdout: string): TunnelError {
	return new TunnelError(`devtunnel ${command} returned an unexpected response:\n${payload(stdout)}`);
}

function decodeLoginStatus(value: Record<string, unknown>, stdout: string): "logged-in" | "logged-out" {
	if (typeof value.status !== "string") {
		throw unexpectedResponse("user show", stdout);
	}
	switch (value.status.trim().toLowerCase()) {
		case "logged in":
			return "logged-in";
		case "not logged in":
			return "logged-out";
		default:
			throw unexpectedResponse("user show", stdout);
	}
}

function decodeTunnels(value: Record<string, unknown>, stdout: string): Tunnel[] {
	if (Array.isArray(value.tunnels)) {
		return value.tunnels.map((item) => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				throw unexpectedResponse("list", stdout);
			}
			const tunnel = item as Record<string, unknown>;
			if (
				typeof tunnel.tunnelId !== "string" ||
				tunnel.tunnelId.length === 0 ||
				!Array.isArray(tunnel.labels) ||
				!tunnel.labels.every((label) => typeof label === "string")
			) {
				throw unexpectedResponse("list", stdout);
			}
			return { tunnelId: tunnel.tunnelId, labels: tunnel.labels };
		});
	}
	if (typeof value.warning === "string" && /\bno tunnels? found\b/i.test(value.warning)) {
		return [];
	}
	throw unexpectedResponse("list", stdout);
}

function decodeCreatedTunnelId(value: Record<string, unknown>, stdout: string): string {
	if (typeof value.tunnel !== "object" || value.tunnel === null || Array.isArray(value.tunnel)) {
		throw unexpectedResponse("create", stdout);
	}
	const id = (value.tunnel as Record<string, unknown>).tunnelId;
	if (typeof id !== "string" || id.length === 0) {
		throw unexpectedResponse("create", stdout);
	}
	return id;
}

function decodePort(value: unknown, command: "port list" | "port show", stdout: string): PortDetails {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw unexpectedResponse(command, stdout);
	}
	const port = value as Record<string, unknown>;
	const protocol = typeof port.protocol === "string" ? port.protocol.trim().toLowerCase() : "";
	if (
		typeof port.portNumber !== "number" ||
		!Number.isSafeInteger(port.portNumber) ||
		port.portNumber < 1 ||
		port.portNumber > 65_535 ||
		protocol.length === 0
	) {
		throw unexpectedResponse(command, stdout);
	}
	return { portNumber: port.portNumber, protocol, accessControl: port.accessControl };
}

function decodePortList(value: Record<string, unknown>, stdout: string): PortDetails[] {
	if (Array.isArray(value.ports)) {
		return value.ports.map((port) => decodePort(port, "port list", stdout));
	}
	if (typeof value.warning === "string" && /\bno (?:tunnel )?ports? found\b/i.test(value.warning)) {
		return [];
	}
	throw unexpectedResponse("port list", stdout);
}

function decodePortDetails(value: Record<string, unknown>, stdout: string): PortDetails {
	return decodePort(value.port, "port show", stdout);
}

// Domain adapter ------------------------------------------------------------

export class DevTunnelCli {
	readonly #runner: DevTunnelRunner;

	constructor(runner: DevTunnelRunner = spawnDevtunnel) {
		this.#runner = runner;
	}

	#run(command: string, args: readonly string[]): DevTunnelCommandResult {
		const result = this.#runner(args);
		if (result.status !== 0) {
			throw new TunnelError(`devtunnel ${command} failed:\n${failureDetail(result)}`);
		}
		return result;
	}

	#runJson(command: string, args: readonly string[]): { value: Record<string, unknown>; stdout: string } {
		const result = this.#run(command, args);
		return { value: parseObject(command, result.stdout), stdout: result.stdout };
	}

	requireLogin(): void {
		const { value, stdout } = this.#runJson("user show", ["user", "show", "--json"]);
		if (decodeLoginStatus(value, stdout) === "logged-out") {
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

	/** Returns this host's first labelled tunnel, if a previous run made one. */
	findTunnel(): Tunnel | undefined {
		const { value, stdout } = this.#runJson("list", [
			"list",
			"--all-labels",
			IDENTITY_LABEL,
			"--all-labels",
			LAUNCHER_LABEL,
			"--json",
		]);
		const found = decodeTunnels(value, stdout)[0];
		if (found && (!found.labels.includes(IDENTITY_LABEL) || !found.labels.includes(LAUNCHER_LABEL))) {
			throw unexpectedResponse("list", stdout);
		}
		return found;
	}

	createTunnel(name: string | undefined): string {
		const labels = [LAUNCHER_LABEL, PROTOCOL_LABEL, IDENTITY_LABEL, ...(name ? [name] : [])];
		const { value, stdout } = this.#runJson("create", [
			"create",
			"--json",
			...labels.flatMap((label) => ["-l", label]),
		]);
		return decodeCreatedTunnelId(value, stdout);
	}

	#createPort(id: string): void {
		this.#run("port create", ["port", "create", id, "-p", String(TUNNEL_PORT), "--protocol", "http", "--json"]);
	}

	/**
	 * Ensures the fixed port uses an HTTP origin. The relay terminates TLS, while
	 * pi-ahp's local listener speaks HTTP/WebSocket. A wrong-protocol port is
	 * replaced only after confirming that it has no port-specific ACL.
	 */
	ensurePort(id: string): void {
		const listed = this.#runJson("port list", ["port", "list", id, "--json"]);
		const current = decodePortList(listed.value, listed.stdout).find((port) => port.portNumber === TUNNEL_PORT);
		if (!current) {
			this.#createPort(id);
			return;
		}
		if (current.protocol === "http") return;

		// List output does not carry port-specific ACLs. Re-read the details before
		// a destructive protocol migration, and trust the newer response if the
		// port changed concurrently.
		const shown = this.#runJson("port show", ["port", "show", id, "-p", String(TUNNEL_PORT), "--json"]);
		const details = decodePortDetails(shown.value, shown.stdout);
		if (details.portNumber !== TUNNEL_PORT) {
			throw unexpectedResponse("port show", shown.stdout);
		}
		if (details.protocol === "http") return;
		const hasPortAcl = Array.isArray(details.accessControl)
			? details.accessControl.length > 0
			: details.accessControl != null;
		if (hasPortAcl) {
			throw new TunnelError(
				`devtunnel port ${TUNNEL_PORT} uses ${details.protocol} and has port-specific access control; replace it manually`,
			);
		}

		this.#run("port delete", ["port", "delete", id, "-p", String(TUNNEL_PORT), "--json"]);
		this.#createPort(id);
	}

	/** Swaps the display label, leaving the identity and protocol labels alone. */
	rename(id: string, from: string | undefined, to: string): void {
		const args = ["update", id, "--add-labels", to];
		if (from) args.push("--remove-labels", from);
		this.#run("update", args);
	}
}
