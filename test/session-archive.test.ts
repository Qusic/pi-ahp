import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ActionType, SessionStatus } from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { isSessionArchived, persistSessionArchived } from "../src/pi/session-archive.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { startHydratedSessionFixture } from "./support/hydrated-session.ts";

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

it("archives a listed disk session before any client subscribes to it", async () => {
	const fixture = await startHydratedSessionFixture();
	try {
		const uri = sessionUri(fixture.sessionId);
		const catalogue = new PiSessionCatalogue(fixture.root);
		const file = await catalogue.findSessionFile(fixture.sessionId);
		assert.ok(file);
		const before = await fixture.client.request("listSessions", { channel: ROOT_CHANNEL });
		assert.ok(before.items.some((item) => item.resource === uri));
		assert.equal(fixture.host.store.has(uri), false);

		const vscode = await fixture.connectAsVSCode();
		vscode.dispatch(`pi:/${fixture.sessionId}`, {
			type: ActionType.SessionIsArchivedChanged,
			isArchived: true,
		});

		const deadline = Date.now() + 2_000;
		while (!isSessionArchived(SessionManager.open(file)) && Date.now() < deadline) {
			await setTimeout(10);
		}
		assert.equal(isSessionArchived(SessionManager.open(file)), true);
		assert.equal(fixture.host.store.has(uri), true);

		const freshCatalogue = await new PiSessionCatalogue(fixture.root).list(undefined, undefined);
		const archived = freshCatalogue.items.find((item) => item.resource === uri);
		assert.ok(archived);
		assert.notEqual(archived.status & SessionStatus.IsArchived, 0);
	} finally {
		await fixture.close();
	}
});
