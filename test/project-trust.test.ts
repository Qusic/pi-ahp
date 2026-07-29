/**
 * Project trust resolution.
 *
 * The behaviour under test is a security default, not a convenience: pi's SDK
 * trusts a working directory unless told otherwise, and a host takes that
 * directory from a client over the network.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
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

	after(() => {
		for (const dir of [agentDir, bare, withResources]) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("trusts by default, matching pi itself", () => {
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

	it("never overrides an explicit distrust, whatever the policy", () => {
		new ProjectTrustStore(agentDir).set(withResources, true);
		const decision = resolveProjectTrust(withResources, "never", agentDir);
		assert.equal(decision.trusted, false);
		assert.equal(decision.reason, "policy");
	});

	it("trusts unconditionally under the `trust` policy", () => {
		const fresh = mkdtempSync(join(tmpdir(), "pi-ahp-trust-fresh-"));
		try {
			mkdirSync(join(fresh, ".pi", "extensions"), { recursive: true });
			writeFileSync(join(fresh, ".pi", "extensions", "ext.ts"), "export default () => {};\n");
			const decision = resolveProjectTrust(fresh, "trust", agentDir);
			assert.equal(decision.trusted, true);
			assert.equal(decision.reason, "policy");
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});
});
