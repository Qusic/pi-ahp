/** VS Code discovery metadata and the `devtunnel` command boundary. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { ensurePort } from "../src/tunnel/devtunnel.ts";
import {
	displayLabel,
	IDENTITY_LABEL,
	LAUNCHER_LABEL,
	nameLabel,
	PROTOCOL_LABEL,
	TUNNEL_PORT,
} from "../src/tunnel/vscode.ts";

function withFakeDevtunnel(
	existingPort: { protocol: string; accessControl?: unknown[] } | undefined,
	run: (capture: string) => void,
): void {
	const directory = mkdtempSync(join(tmpdir(), "pi-ahp-devtunnel-"));
	const executable = join(directory, "devtunnel");
	const capture = join(directory, "calls");
	writeFileSync(
		executable,
		[
			`#!${process.execPath}`,
			'const fs = require("node:fs");',
			"const args = process.argv.slice(2);",
			'const port = JSON.parse(process.env.PI_AHP_TEST_DEVTUNNEL_PORT || "null");',
			'fs.appendFileSync(process.env.PI_AHP_TEST_DEVTUNNEL_ARGS, JSON.stringify(args) + "\\n");',
			'if (args[1] === "show" && !port) { console.error("Tunnel port not found"); process.exit(2); }',
			'if (args[1] === "show") console.log(JSON.stringify({ port }));',
		].join("\n"),
		{ mode: 0o755 },
	);

	const oldPath = process.env.PATH;
	const oldCapture = process.env.PI_AHP_TEST_DEVTUNNEL_ARGS;
	const oldPort = process.env.PI_AHP_TEST_DEVTUNNEL_PORT;
	try {
		process.env.PATH = `${directory}${delimiter}${oldPath ?? ""}`;
		process.env.PI_AHP_TEST_DEVTUNNEL_ARGS = capture;
		if (existingPort === undefined) delete process.env.PI_AHP_TEST_DEVTUNNEL_PORT;
		else process.env.PI_AHP_TEST_DEVTUNNEL_PORT = JSON.stringify(existingPort);
		run(capture);
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		if (oldCapture === undefined) delete process.env.PI_AHP_TEST_DEVTUNNEL_ARGS;
		else process.env.PI_AHP_TEST_DEVTUNNEL_ARGS = oldCapture;
		if (oldPort === undefined) delete process.env.PI_AHP_TEST_DEVTUNNEL_PORT;
		else process.env.PI_AHP_TEST_DEVTUNNEL_PORT = oldPort;
		rmSync(directory, { recursive: true, force: true });
	}
}

function recordedCalls(path: string): string[][] {
	return readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as string[]);
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

describe("devtunnel command", () => {
	it("creates port 31546 with an HTTP origin", () => {
		withFakeDevtunnel(undefined, (capture) => {
			ensurePort("sample.usw2");
			assert.deepEqual(recordedCalls(capture), [showPortCall, createPortCall]);
		});
	});

	it("keeps an existing HTTP port", () => {
		withFakeDevtunnel({ protocol: "http" }, (capture) => {
			ensurePort("sample.usw2");
			assert.deepEqual(recordedCalls(capture), [showPortCall]);
		});
	});

	it("replaces an old HTTPS port with an HTTP port", () => {
		withFakeDevtunnel({ protocol: "https" }, (capture) => {
			ensurePort("sample.usw2");
			assert.deepEqual(recordedCalls(capture), [
				showPortCall,
				["port", "delete", "sample.usw2", "-p", "31546", "--json"],
				createPortCall,
			]);
		});
	});

	it("does not discard port-specific access control while migrating", () => {
		withFakeDevtunnel({ protocol: "https", accessControl: [{ subject: "example" }] }, (capture) => {
			assert.throws(() => ensurePort("sample.usw2"), /has port-specific access control/);
			assert.deepEqual(recordedCalls(capture), [showPortCall]);
		});
	});
});
