/** Dev Tunnel command handling and compatible-client discovery metadata. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DevTunnelCli, type DevTunnelCommandResult, TunnelError } from "../src/tunnel/devtunnel.ts";
import {
	displayLabel,
	IDENTITY_LABEL,
	LAUNCHER_LABEL,
	nameLabel,
	PROTOCOL_LABEL,
	TUNNEL_PORT,
} from "../src/tunnel/discovery.ts";

interface FakeResponse {
	readonly status?: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly stdout?: string;
	readonly stderr?: string;
}

function withFakeDevtunnel(responses: readonly FakeResponse[], run: (cli: DevTunnelCli) => void): string[][] {
	const calls: string[][] = [];
	let index = 0;
	const cli = new DevTunnelCli((args): DevTunnelCommandResult => {
		const response = responses[index++];
		if (!response) throw new Error(`unexpected devtunnel call: ${args.join(" ")}`);
		calls.push([...args]);
		return {
			status: response.status === undefined ? 0 : response.status,
			signal: response.signal ?? null,
			stdout: response.stdout ?? "",
			stderr: response.stderr ?? "",
		};
	});
	run(cli);
	assert.equal(index, responses.length, "every fake devtunnel response should be consumed");
	return calls;
}

const tunnelListCall = ["list", "--all-labels", IDENTITY_LABEL, "--all-labels", LAUNCHER_LABEL, "--json"];
const createPortCall = ["port", "create", "sample.usw2", "-p", "31546", "--protocol", "http", "--json"];
const listPortsCall = ["port", "list", "sample.usw2", "--json"];
const showPortCall = ["port", "show", "sample.usw2", "-p", "31546", "--json"];
const wrongPort = { portNumber: TUNNEL_PORT, protocol: "https" };
const wrongPortDetails = { portNumber: TUNNEL_PORT, protocol: "https", accessControl: [] };

describe("tunnel discovery contract", () => {
	it("uses the shared discovery labels and port", () => {
		assert.equal(LAUNCHER_LABEL, "vscode-server-launcher");
		assert.equal(PROTOCOL_LABEL, "protocolv5");
		assert.equal(TUNNEL_PORT, 31546);
	});

	it("keeps the identity label out of the display name", () => {
		assert.ok(IDENTITY_LABEL.startsWith("_"));
		assert.equal(displayLabel([LAUNCHER_LABEL, PROTOCOL_LABEL, IDENTITY_LABEL]), undefined);
		assert.equal(displayLabel([LAUNCHER_LABEL, PROTOCOL_LABEL, IDENTITY_LABEL, "devbox"]), "devbox");
		assert.equal(displayLabel(["banl", "protocolv5", LAUNCHER_LABEL, "_flag3"]), "banl");
	});

	it("folds a name the way VS Code does", () => {
		assert.equal(nameLabel("my box"), "mybox");
		assert.equal(nameLabel("--weird--"), "weird--");
		assert.equal(nameLabel("a".repeat(40)), "a".repeat(20));
		assert.equal(nameLabel(".."), undefined);
	});
});

describe("devtunnel account and catalogue", () => {
	it("reports when the CLI is not installed", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-no-devtunnel-"));
		const previousPath = process.env.PATH;
		try {
			process.env.PATH = root;
			assert.throws(
				() => new DevTunnelCli().requireLogin(),
				(error: unknown) => error instanceof TunnelError && /not found on PATH/u.test(error.message),
			);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("requires a logged-in account", () => {
		assert.deepEqual(
			withFakeDevtunnel([{ stdout: '{"status":"Logged in"}' }], (cli) => cli.requireLogin()),
			[["user", "show", "--json"]],
		);
		withFakeDevtunnel([{ stdout: '{"status":"Not logged in"}' }], (cli) =>
			assert.throws(() => cli.requireLogin(), /not logged in/i),
		);
	});

	it("reports account inspection failures", () => {
		for (const [response, message] of [
			[{ status: 2, stderr: "credential store failed" }, /user show failed.*credential store failed/su],
			[{ stdout: "not json" }, /user show returned invalid JSON/su],
			[{ stdout: "{}" }, /user show returned an unexpected response/su],
		] as const) {
			withFakeDevtunnel([response], (cli) => assert.throws(() => cli.requireLogin(), message));
		}
	});

	it("finds this host's first labelled tunnel", () => {
		const tunnel = { tunnelId: "sample.usw2", labels: [IDENTITY_LABEL, LAUNCHER_LABEL, "sample"] };
		const calls = withFakeDevtunnel([{ stdout: JSON.stringify({ tunnels: [tunnel] }) }], (cli) => {
			assert.deepEqual(cli.findTunnel(), tunnel);
		});
		assert.deepEqual(calls, [tunnelListCall]);
	});

	it("returns no tunnel for a successful empty listing", () => {
		for (const stdout of ['{"warning":"No tunnels found."}', '{"tunnels":[]}']) {
			withFakeDevtunnel([{ stdout }], (cli) => assert.equal(cli.findTunnel(), undefined));
		}
	});

	it("reports tunnel listing failures and malformed responses", () => {
		for (const [response, message] of [
			[{ status: 2, stderr: "listing failed" }, /list failed.*listing failed/su],
			[{ stdout: "not json" }, /list returned invalid JSON/su],
			[{ stdout: '{"warning":"partial results"}' }, /list returned an unexpected response/su],
			[{ stdout: '{"tunnels":[{"tunnelId":42,"labels":[]}]}' }, /list returned an unexpected response/su],
			[
				{ stdout: '{"tunnels":[{"tunnelId":"other.usw2","labels":["unrelated"]}]}' },
				/list returned an unexpected response/su,
			],
		] as const) {
			withFakeDevtunnel([response], (cli) => assert.throws(() => cli.findTunnel(), message));
		}
	});

	it("creates a tunnel with identity, protocol, launcher, and display labels", () => {
		const calls = withFakeDevtunnel([{ stdout: '{"tunnel":{"tunnelId":"sample.usw2"}}' }], (cli) =>
			assert.equal(cli.createTunnel("devbox"), "sample.usw2"),
		);
		assert.deepEqual(calls, [
			["create", "--json", "-l", LAUNCHER_LABEL, "-l", PROTOCOL_LABEL, "-l", IDENTITY_LABEL, "-l", "devbox"],
		]);
	});

	it("rejects failed or malformed tunnel creation", () => {
		for (const [response, message] of [
			[{ status: 1, stderr: "denied" }, /create failed.*denied/su],
			[{ stdout: "not json" }, /create returned invalid JSON/su],
			[{ stdout: "{}" }, /create returned an unexpected response/su],
		] as const) {
			withFakeDevtunnel([response], (cli) => assert.throws(() => cli.createTunnel(undefined), message));
		}
	});

	it("renames a tunnel without disturbing reserved labels", () => {
		const calls = withFakeDevtunnel([{}, {}], (cli) => {
			cli.rename("sample.usw2", "old", "new");
			cli.rename("sample.usw2", undefined, "first");
		});
		assert.deepEqual(calls, [
			["update", "sample.usw2", "--add-labels", "new", "--remove-labels", "old"],
			["update", "sample.usw2", "--add-labels", "first"],
		]);
	});

	it("reports a failed rename", () => {
		withFakeDevtunnel([{ status: 1, stderr: "denied" }], (cli) =>
			assert.throws(() => cli.rename("sample.usw2", "old", "new"), /update failed.*denied/su),
		);
	});
});

describe("devtunnel port", () => {
	it("creates port 31546 when a successful listing is empty", () => {
		for (const stdout of ['{"ports":[]}', '{"warning":"No ports found."}']) {
			const calls = withFakeDevtunnel([{ stdout }, {}], (cli) => cli.ensurePort("sample.usw2"));
			assert.deepEqual(calls, [listPortsCall, createPortCall]);
		}
	});

	it("keeps an existing HTTP port", () => {
		const calls = withFakeDevtunnel(
			[{ stdout: JSON.stringify({ ports: [{ portNumber: TUNNEL_PORT, protocol: " HTTP " }] }) }],
			(cli) => cli.ensurePort("sample.usw2"),
		);
		assert.deepEqual(calls, [listPortsCall]);
	});

	it("replaces an old HTTPS port with an HTTP port", () => {
		const calls = withFakeDevtunnel(
			[
				{ stdout: JSON.stringify({ ports: [wrongPort] }) },
				{ stdout: JSON.stringify({ port: wrongPortDetails }) },
				{},
				{},
			],
			(cli) => cli.ensurePort("sample.usw2"),
		);
		assert.deepEqual(calls, [
			listPortsCall,
			showPortCall,
			["port", "delete", "sample.usw2", "-p", "31546", "--json"],
			createPortCall,
		]);
	});

	it("does not discard port-specific access control while migrating", () => {
		const details = { ...wrongPortDetails, accessControl: [{ subject: "example" }] };
		const calls = withFakeDevtunnel(
			[{ stdout: JSON.stringify({ ports: [wrongPort] }) }, { stdout: JSON.stringify({ port: details }) }],
			(cli) => assert.throws(() => cli.ensurePort("sample.usw2"), /has port-specific access control/),
		);
		assert.deepEqual(calls, [listPortsCall, showPortCall]);
	});

	it("uses current port details when the protocol changes during inspection", () => {
		const calls = withFakeDevtunnel(
			[
				{ stdout: JSON.stringify({ ports: [wrongPort] }) },
				{ stdout: JSON.stringify({ port: { portNumber: TUNNEL_PORT, protocol: "http", accessControl: [] } }) },
			],
			(cli) => cli.ensurePort("sample.usw2"),
		);
		assert.deepEqual(calls, [listPortsCall, showPortCall]);
	});

	it("rejects malformed port inspection output", () => {
		for (const responses of [
			[{ stdout: "not json" }],
			[{ stdout: '{"ports":[{"portNumber":31546}]}' }],
			[{ stdout: JSON.stringify({ ports: [wrongPort] }) }, { stdout: '{"port":{}}' }],
		]) {
			withFakeDevtunnel(responses, (cli) => assert.throws(() => cli.ensurePort("sample.usw2"), TunnelError));
		}
	});

	it("reports listing, inspection, deletion, and creation failures", () => {
		const cases: Array<[FakeResponse[], RegExp]> = [
			[[{ status: 1, stderr: "list failed" }], /port list failed/],
			[[{ stdout: JSON.stringify({ ports: [wrongPort] }) }, { status: 1, stderr: "show failed" }], /port show failed/],
			[
				[
					{ stdout: JSON.stringify({ ports: [wrongPort] }) },
					{ stdout: JSON.stringify({ port: wrongPortDetails }) },
					{ status: 1, stderr: "delete failed" },
				],
				/port delete failed/,
			],
			[[{ stdout: '{"ports":[]}' }, { status: 1, stderr: "create failed" }], /port create failed/],
		];
		for (const [responses, message] of cases) {
			withFakeDevtunnel(responses, (cli) => assert.throws(() => cli.ensurePort("sample.usw2"), message));
		}
	});
});
