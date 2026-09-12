/** VS Code discovery metadata and the `devtunnel` command boundary. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { createTunnel, ensurePort, findTunnel, rename, requireLogin, TunnelError } from "../src/tunnel/devtunnel.ts";
import {
	displayLabel,
	IDENTITY_LABEL,
	LAUNCHER_LABEL,
	nameLabel,
	PROTOCOL_LABEL,
	TUNNEL_PORT,
} from "../src/tunnel/vscode.ts";

interface FakeResponse {
	readonly status?: number;
	readonly stdout?: string;
	readonly stderr?: string;
}

function withFakeDevtunnel(responses: readonly FakeResponse[], run: () => void): string[][] {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-devtunnel-"));
	const executable = join(root, "devtunnel");
	const capture = join(root, "calls.jsonl");
	writeFileSync(
		executable,
		[
			`#!${process.execPath}`,
			'const fs = require("node:fs");',
			"const args = process.argv.slice(2);",
			"const capture = process.env.PI_AHP_TEST_DEVTUNNEL_ARGS;",
			'const previous = fs.existsSync(capture) ? fs.readFileSync(capture, "utf8").trim().split("\\n").filter(Boolean) : [];',
			'fs.appendFileSync(capture, JSON.stringify(args) + "\\n");',
			"const responses = JSON.parse(process.env.PI_AHP_TEST_DEVTUNNEL_RESPONSES);",
			"const response = responses[previous.length] || {};",
			"if (response.stdout) process.stdout.write(response.stdout);",
			"if (response.stderr) process.stderr.write(response.stderr);",
			"process.exit(response.status || 0);",
		].join("\n"),
		{ mode: 0o755 },
	);

	const previousPath = process.env.PATH;
	const previousCapture = process.env.PI_AHP_TEST_DEVTUNNEL_ARGS;
	const previousResponses = process.env.PI_AHP_TEST_DEVTUNNEL_RESPONSES;
	try {
		process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`;
		process.env.PI_AHP_TEST_DEVTUNNEL_ARGS = capture;
		process.env.PI_AHP_TEST_DEVTUNNEL_RESPONSES = JSON.stringify(responses);
		run();
		return readFileSync(capture, "utf8")
			.trimEnd()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string[]);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousCapture === undefined) delete process.env.PI_AHP_TEST_DEVTUNNEL_ARGS;
		else process.env.PI_AHP_TEST_DEVTUNNEL_ARGS = previousCapture;
		if (previousResponses === undefined) delete process.env.PI_AHP_TEST_DEVTUNNEL_RESPONSES;
		else process.env.PI_AHP_TEST_DEVTUNNEL_RESPONSES = previousResponses;
		rmSync(root, { recursive: true, force: true });
	}
}

const createPortCall = ["port", "create", "sample.usw2", "-p", "31546", "--protocol", "http", "--json"];
const showPortCall = ["port", "show", "sample.usw2", "-p", "31546", "--json"];

describe("tunnel discovery contract", () => {
	it("uses the labels and port VS Code looks for", () => {
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
				requireLogin,
				(error: unknown) => error instanceof TunnelError && /not found on PATH/u.test(error.message),
			);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("requires a logged-in account", () => {
		assert.deepEqual(withFakeDevtunnel([{ stdout: '{"user":"fixture"}' }], requireLogin), [["user", "show", "--json"]]);
		withFakeDevtunnel([{ stdout: "Not logged in" }], () => assert.throws(requireLogin, /not logged in/i));
	});

	it("finds this host's first labelled tunnel", () => {
		const tunnel = { tunnelId: "sample.usw2", labels: [IDENTITY_LABEL, LAUNCHER_LABEL, "sample"] };
		const calls = withFakeDevtunnel([{ stdout: JSON.stringify({ tunnels: [tunnel] }) }], () => {
			assert.deepEqual(findTunnel(), tunnel);
		});
		assert.deepEqual(calls, [["list", "--all-labels", IDENTITY_LABEL, "--all-labels", LAUNCHER_LABEL, "--json"]]);
	});

	it("treats an unsuccessful or empty listing as no tunnel", () => {
		for (const response of [{ status: 2, stderr: "failed" }, { stdout: '{"warning":"none"}' }]) {
			withFakeDevtunnel([response], () => assert.equal(findTunnel(), undefined));
		}
	});

	it("creates a tunnel with identity, protocol, launcher, and display labels", () => {
		const calls = withFakeDevtunnel([{ stdout: '{"tunnel":{"tunnelId":"sample.usw2"}}' }], () => {
			assert.equal(createTunnel("devbox"), "sample.usw2");
		});
		assert.deepEqual(calls, [
			["create", "--json", "-l", LAUNCHER_LABEL, "-l", PROTOCOL_LABEL, "-l", IDENTITY_LABEL, "-l", "devbox"],
		]);
	});

	it("rejects failed or incomplete tunnel creation", () => {
		for (const response of [{ status: 1, stderr: "denied" }, { stdout: "{}" }]) {
			withFakeDevtunnel([response], () => assert.throws(() => createTunnel(undefined), TunnelError));
		}
	});

	it("renames a tunnel without disturbing reserved labels", () => {
		const calls = withFakeDevtunnel([{}, {}], () => {
			rename("sample.usw2", "old", "new");
			rename("sample.usw2", undefined, "first");
		});
		assert.deepEqual(calls, [
			["update", "sample.usw2", "--add-labels", "new", "--remove-labels", "old"],
			["update", "sample.usw2", "--add-labels", "first"],
		]);
	});

	it("reports a failed rename", () => {
		withFakeDevtunnel([{ status: 1, stderr: "denied" }], () =>
			assert.throws(() => rename("sample.usw2", "old", "new"), /denied/),
		);
	});
});

describe("devtunnel port", () => {
	it("creates port 31546 with an HTTP origin", () => {
		const calls = withFakeDevtunnel([{ status: 2, stderr: "Tunnel port not found" }, {}], () =>
			ensurePort("sample.usw2"),
		);
		assert.deepEqual(calls, [showPortCall, createPortCall]);
	});

	it("keeps an existing HTTP port", () => {
		const calls = withFakeDevtunnel([{ stdout: '{"port":{"protocol":"http"}}' }], () => ensurePort("sample.usw2"));
		assert.deepEqual(calls, [showPortCall]);
	});

	it("replaces an old HTTPS port with an HTTP port", () => {
		const calls = withFakeDevtunnel([{ stdout: '{"port":{"protocol":"https"}}' }, {}, {}], () =>
			ensurePort("sample.usw2"),
		);
		assert.deepEqual(calls, [showPortCall, ["port", "delete", "sample.usw2", "-p", "31546", "--json"], createPortCall]);
	});

	it("does not discard port-specific access control while migrating", () => {
		const port = { protocol: "https", accessControl: [{ subject: "example" }] };
		const calls = withFakeDevtunnel([{ stdout: JSON.stringify({ port }) }], () =>
			assert.throws(() => ensurePort("sample.usw2"), /has port-specific access control/),
		);
		assert.deepEqual(calls, [showPortCall]);
	});

	it("rejects malformed port inspection output", () => {
		for (const stdout of ["not json", '{"port":{}}']) {
			withFakeDevtunnel([{ stdout }], () => assert.throws(() => ensurePort("sample.usw2"), TunnelError));
		}
	});

	it("reports inspection, deletion, and creation failures", () => {
		const cases: Array<[FakeResponse[], RegExp]> = [
			[[{ status: 1, stderr: "inspection failed" }], /port show failed/],
			[[{ stdout: '{"port":{"protocol":"https"}}' }, { status: 1, stderr: "delete failed" }], /delete failed/],
			[
				[
					{ status: 2, stderr: "Tunnel port not found" },
					{ status: 1, stderr: "create failed" },
				],
				/create failed/,
			],
		];
		for (const [responses, message] of cases) {
			withFakeDevtunnel(responses, () => assert.throws(() => ensurePort("sample.usw2"), message));
		}
	});
});
