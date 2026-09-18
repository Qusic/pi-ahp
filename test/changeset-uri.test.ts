import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePiChangesetUri, piChangesetCatalogue, piChangesetUri } from "../src/pi/changeset-uri.ts";

describe("pi changeset URIs", () => {
	it("builds stable static catalogue channels", () => {
		assert.deepEqual(piChangesetCatalogue("session-1", true), [
			{
				label: "Latest Commit",
				description: "Changes introduced by the current HEAD commit",
				changeKind: "branch",
				uriTemplate: "ahp-changeset:/session-1/latest-commit",
			},
			{
				label: "Uncommitted Changes",
				description: "Current staged, unstaged, and untracked changes",
				changeKind: "uncommitted",
				uriTemplate: "ahp-changeset:/session-1/uncommitted",
			},
		]);
		assert.deepEqual(parsePiChangesetUri(piChangesetUri("session-1", "uncommitted")), {
			sessionId: "session-1",
			kind: "uncommitted",
		});
	});

	it("rejects channels the host did not advertise", () => {
		for (const uri of [
			"ahp-changeset:/session-1/turn",
			"ahp-changeset:/session-1/uncommitted/extra",
			"ahp-changeset:/session%2Fother/uncommitted",
			"ahp-changeset:/session-1/uncommitted?ref=HEAD",
		]) {
			assert.equal(parsePiChangesetUri(uri), undefined);
		}
	});
});
