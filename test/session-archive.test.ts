import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isSessionArchived, persistSessionArchived } from "../src/pi/session-archive.ts";

it("persists the latest archive marker in pi custom entries", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-archive-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const manager = SessionManager.create(root, join(root, "sessions"));

	assert.equal(isSessionArchived(manager), false);
	persistSessionArchived(manager, true);
	assert.equal(isSessionArchived(manager), true);
	persistSessionArchived(manager, false);
	assert.equal(isSessionArchived(manager), false);

	const file = manager.getSessionFile();
	assert.ok(file);
	assert.equal(isSessionArchived(SessionManager.open(file)), false);
});
