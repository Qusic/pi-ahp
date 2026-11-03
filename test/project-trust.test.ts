/**
 * Project trust resolution.
 *
 * The behaviour under test is a security default, not a convenience: pi's SDK
 * trusts a working directory unless told otherwise, and a host takes that
 * directory from a client over the network.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";
import { chooseProjectTrust, readProjectTrust } from "../src/pi/project-trust.ts";

describe("project trust", () => {
	let agentDir: string;
	let bare: string;
	let parent: string;
	let gated: string;

	before(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-ahp-trust-agent-"));
		bare = mkdtempSync(join(tmpdir(), "pi-ahp-trust-bare-"));
		parent = mkdtempSync(join(tmpdir(), "pi-ahp-trust-parent-"));
		gated = join(parent, "repo");
		// A project-level extension is exactly the thing trust gates: loading it
		// executes code from the directory.
		mkdirSync(join(gated, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(gated, ".pi", "extensions", "ext.ts"), "export default () => {};\n");
	});

	beforeEach(() => {
		// Every case starts without decisions or settings written by another test.
		rmSync(agentDir, { recursive: true, force: true });
		mkdirSync(agentDir, { recursive: true });
	});

	after(() => {
		for (const dir of [agentDir, bare, parent]) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const store = () => new ProjectTrustStore(agentDir);
	const setDefaultProjectTrust = (value: string) =>
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: value }));

	it("trusts a folder with nothing to gate", () => {
		const trust = readProjectTrust(bare, agentDir);
		assert.equal(trust.gated, false);
		assert.equal(trust.trusted, true);
	});

	it("applies a saved distrust even with nothing to gate, as pi does", () => {
		store().set(bare, false);
		assert.equal(readProjectTrust(bare, agentDir).trusted, false);
	});

	it("declines a gated folder without a decision, where pi would ask", () => {
		// The important case: the SDK's own default would return true here.
		const trust = readProjectTrust(gated, agentDir);
		assert.equal(trust.gated, true);
		assert.equal(trust.saved, null);
		assert.equal(trust.defaultProjectTrust, "ask");
		assert.equal(trust.trusted, false);
	});

	it("follows pi's defaultProjectTrust setting", () => {
		setDefaultProjectTrust("always");
		assert.equal(readProjectTrust(gated, agentDir).trusted, true);
	});

	it("ignores a folder's own settings when deciding whether to trust it", () => {
		// Project settings are trust-gated themselves; honouring this would let
		// any repository trust itself.
		const selfTrusting = mkdtempSync(join(tmpdir(), "pi-ahp-trust-self-"));
		try {
			mkdirSync(join(selfTrusting, ".pi"));
			writeFileSync(join(selfTrusting, ".pi", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
			const trust = readProjectTrust(selfTrusting, agentDir);
			assert.equal(trust.gated, true);
			assert.equal(trust.trusted, false);
		} finally {
			rmSync(selfTrusting, { recursive: true, force: true });
		}
	});

	it("prefers a saved decision over pi's default", () => {
		setDefaultProjectTrust("always");
		store().set(gated, false);
		assert.equal(readProjectTrust(gated, agentDir).trusted, false);
	});

	it("inherits the closest decision saved for a parent folder", () => {
		store().set(parent, true);
		const trust = readProjectTrust(gated, agentDir);
		assert.equal(trust.trusted, true);
		assert.equal(trust.saved?.path, realpathSync(parent));
	});

	it("saves an answer that differs from what the folder would get", () => {
		chooseProjectTrust(gated, true, agentDir);
		assert.equal(store().get(gated), true);
		chooseProjectTrust(gated, false, agentDir);
		assert.equal(store().get(gated), false);
	});

	it("saves nothing for an unchanged answer or a folder with nothing to gate", () => {
		chooseProjectTrust(gated, false, agentDir);
		chooseProjectTrust(bare, false, agentDir);
		assert.equal(existsSync(join(agentDir, "trust.json")), false);
	});

	it("applies the decision before pi loads project extensions", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const workspaces: string[] = [];
		try {
			for (const [saved, shouldLoad] of [
				[undefined, false],
				[true, true],
			] as const) {
				const cwd = mkdtempSync(join(tmpdir(), "pi-ahp-trust-load-"));
				workspaces.push(cwd);
				const marker = join(cwd, "extension-loaded");
				const extensions = join(cwd, ".pi", "extensions");
				mkdirSync(extensions, { recursive: true });
				writeFileSync(
					join(extensions, "probe.js"),
					`import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`,
				);
				if (saved !== undefined) {
					store().set(cwd, saved);
				}

				const backend = await InProcessPiBackend.create({ cwd, sessionManager: SessionManager.inMemory(cwd) });
				try {
					assert.equal(existsSync(marker), shouldLoad, `project extension execution with saved=${saved}`);
				} finally {
					backend.dispose();
				}
			}
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			for (const cwd of workspaces) rmSync(cwd, { recursive: true, force: true });
		}
	});
});
