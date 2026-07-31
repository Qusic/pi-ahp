/**
 * The tunnel connection token is not exchanged — VS Code computes it from the
 * tunnel id and presents it, so our derivation has to match theirs bit for bit
 * or the upgrade is rejected with a 401 that names nothing.
 *
 * Reference: `deriveConnectionToken` in VS Code's
 * `platform/agentHost/node/tunnelAgentHostService.ts`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	deriveConnectionToken,
	displayLabel,
	IDENTITY_LABEL,
	LAUNCHER_LABEL,
	nameLabel,
	PROTOCOL_LABEL,
	splitTunnelId,
	TUNNEL_PORT,
} from "../src/tunnel/vscode.ts";

/** VS Code's implementation, transcribed. */
function vscodeDerive(tunnelId: string): string {
	const hash = createHash("sha256");
	hash.update(tunnelId);
	let result = hash.digest("base64url");
	if (result.startsWith("-")) {
		result = `a${result}`;
	}
	return result;
}

describe("tunnel discovery contract", () => {
	it("uses the labels and port VS Code looks for", () => {
		assert.equal(LAUNCHER_LABEL, "vscode-server-launcher");
		assert.equal(PROTOCOL_LABEL, "protocolv5");
		assert.equal(TUNNEL_PORT, 31546);
	});

	for (const id of ["abc123", "test-tunnel", "x", "musical-panda-7f3k9x2"]) {
		it(`matches VS Code for ${id}`, () => {
			assert.equal(deriveConnectionToken(id), vscodeDerive(id));
		});
	}

	it("hashes the bare id, not the CLI's qualified form", () => {
		// `devtunnel` prints `<id>.<cluster>`, but the REST contract documents
		// tunnelId as unique *within* the cluster, and VS Code reads it and
		// clusterId as separate fields. Verified live: hashing the dotted form
		// produced a token the host rejected.
		assert.deepEqual(splitTunnelId("amusing-ant-rc7ndkh.usw2"), {
			tunnelId: "amusing-ant-rc7ndkh",
			clusterId: "usw2",
		});
		assert.deepEqual(splitTunnelId("no-cluster"), { tunnelId: "no-cluster", clusterId: undefined });
		assert.equal(deriveConnectionToken("amusing-ant-rc7ndkh"), "oGrC0_NsvbB_93kf9mBbyeQSQUwBkHxBntvl48yEPcQ");
	});

	it("keeps the identity label out of the display name", () => {
		// `TunnelTags` takes the first label that is not the launcher label, not
		// `protocolvN`, and does not start with `_`. Ours starts with `_` so the
		// user's own name wins and renaming never orphans the tunnel.
		assert.ok(IDENTITY_LABEL.startsWith("_"));
		assert.equal(displayLabel([LAUNCHER_LABEL, PROTOCOL_LABEL, IDENTITY_LABEL]), undefined);
		assert.equal(displayLabel([LAUNCHER_LABEL, PROTOCOL_LABEL, IDENTITY_LABEL, "devbox"]), "devbox");
		// A real tunnel of the user's, to pin the transcription.
		assert.equal(displayLabel(["banl", "protocolv5", LAUNCHER_LABEL, "_flag3"]), "banl");
	});

	it("folds a name the way VS Code folds its own", () => {
		// `tunnelHostMainService._getTunnelName`: strip leading dashes, drop
		// anything outside \w-, cap at 20.
		assert.equal(nameLabel("my box"), "mybox");
		assert.equal(nameLabel("--weird--"), "weird--");
		assert.equal(nameLabel("a".repeat(40)), "a".repeat(20));
		// Nothing usable left rather than a silently mangled label.
		assert.equal(nameLabel(".."), undefined);
	});

	it("never starts with a dash", () => {
		// base64url can begin with `-`, which some readers treat as a flag.
		// VS Code prefixes an `a`; a token that did not would be rejected.
		let found = false;
		for (let i = 0; i < 5000 && !found; i++) {
			const raw = createHash("sha256").update(`t${i}`).digest("base64url");
			if (raw.startsWith("-")) {
				found = true;
				assert.equal(deriveConnectionToken(`t${i}`), `a${raw}`);
			}
		}
		assert.ok(found, "no dash-leading digest in range — widen the search");
	});
});
