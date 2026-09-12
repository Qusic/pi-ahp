/**
 * Project trust resolution.
 *
 * The behaviour under test is a security default, not a convenience: pi's SDK
 * trusts a working directory unless told otherwise, and a host takes that
 * directory from a client over the network.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";
import { resolveProjectTrust } from "../src/pi/project-trust.ts";

describe("project trust", () => {
	let agentDir: string;
	let bare: string;
	let withResources: string;

	before(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-ahp-trust-agent-"));
		bare = mkdtempSync(join(tmpdir(), "pi-ahp-trust-bare-"));
		withResources = mkdtempSync(join(tmpdir(), "pi-ahp-trust-proj-"));
		// A project-level extension is exactly the thing trust gates: loading it
		// executes code from the directory.
		mkdirSync(join(withResources, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(withResources, ".pi", "extensions", "ext.ts"), "export default () => {};\n");
	});

	beforeEach(() => {
		// Every policy case starts without a decision written by another test.
		rmSync(agentDir, { recursive: true, force: true });
		mkdirSync(agentDir, { recursive: true });
	});

	after(() => {
		for (const dir of [agentDir, bare, withResources]) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("trusts by default, matching raw pi SDK construction", () => {
		const decision = resolveProjectTrust(withResources, undefined, agentDir);
		assert.equal(decision.trusted, true);
		assert.equal(decision.reason, "policy");
	});

	it("trusts a directory with nothing to gate", () => {
		const decision = resolveProjectTrust(bare, "inherit", agentDir);
		assert.equal(decision.trusted, true);
		assert.equal(decision.reason, "no-project-resources");
	});

	it("declines a project nobody has approved, under `inherit`", () => {
		// The important case: the SDK's own default would return true here.
		const decision = resolveProjectTrust(withResources, "inherit", agentDir);
		assert.equal(decision.trusted, false);
		assert.equal(decision.reason, "unknown-project");
	});

	it("inherits a decision the user made with pi's CLI", () => {
		new ProjectTrustStore(agentDir).set(withResources, true);
		const decision = resolveProjectTrust(withResources, "inherit", agentDir);

		// Reusing pi's store means trusting once covers both tools, and
		// revoking in either revokes in both.
		assert.equal(decision.trusted, true);
		assert.equal(decision.reason, "user-trusted");
	});

	it("honours an explicit distrust from pi's CLI", () => {
		new ProjectTrustStore(agentDir).set(withResources, false);
		const decision = resolveProjectTrust(withResources, "inherit", agentDir);
		assert.equal(decision.trusted, false);
		assert.equal(decision.reason, "user-untrusted");
	});

	it("the `never` policy overrides a stored trust decision", () => {
		new ProjectTrustStore(agentDir).set(withResources, true);
		const decision = resolveProjectTrust(withResources, "never", agentDir);
		assert.equal(decision.trusted, false);
		assert.equal(decision.reason, "policy");
	});

	it("applies the decision before pi loads project extensions", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const workspaces: string[] = [];
		try {
			for (const [policy, shouldLoad] of [
				["never", false],
				["trust", true],
			] as const) {
				const cwd = mkdtempSync(join(tmpdir(), `pi-ahp-trust-${policy}-`));
				workspaces.push(cwd);
				const marker = join(cwd, "extension-loaded");
				const extensions = join(cwd, ".pi", "extensions");
				mkdirSync(extensions, { recursive: true });
				writeFileSync(
					join(extensions, "probe.js"),
					`import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`,
				);

				const backend = await InProcessPiBackend.create({
					cwd,
					sessionManager: SessionManager.inMemory(cwd),
					projectTrustPolicy: policy,
				});
				try {
					assert.equal(backend.projectTrust.trusted, shouldLoad);
					assert.equal(existsSync(marker), shouldLoad, `${policy} project extension execution`);
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
