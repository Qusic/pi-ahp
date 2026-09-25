import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { ActionType, SessionStatus } from "@microsoft/agent-host-protocol";
import { ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { MetadataStore } from "../src/pi/metadata-store.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { startHydratedSessionFixture } from "./support/hydrated-session.ts";

it("persists archive state independently of other session and client data", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-archive-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "metadata.json");
	writeFileSync(path, JSON.stringify({ sessions: { a: { label: "keep" } }, clients: { vscode: { theme: "dark" } } }));
	const store = new MetadataStore(path);
	assert.equal(store.getSessionArchived("a"), false);
	store.setSessionArchived("a", true);
	store.setSessionArchived("b", true);
	assert.equal(new MetadataStore(path).getSessionArchived("a"), true);
	store.setSessionArchived("a", false);
	assert.equal(new MetadataStore(path).getSessionArchived("a"), false);
	assert.equal(new MetadataStore(path).getSessionArchived("b"), true);
	store.deleteSession("b");
	assert.equal(new MetadataStore(path).getSessionArchived("b"), false);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		sessions: { a: { label: "keep" } },
		clients: { vscode: { theme: "dark" } },
	});
});

it("rejects malformed metadata instead of silently overwriting it", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-invalid-metadata-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "metadata.json");
	writeFileSync(path, "{broken");
	assert.throws(() => new MetadataStore(path));
	assert.equal(readFileSync(path, "utf8"), "{broken");
});

it("archives a listed disk session before any client subscribes to it", async () => {
	const fixture = await startHydratedSessionFixture();
	try {
		const uri = sessionUri(fixture.sessionId);
		const catalogue = new PiSessionCatalogue(fixture.root, fixture.metadata);
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
		while (!fixture.metadata.getSessionArchived(fixture.sessionId) && Date.now() < deadline) {
			await setTimeout(10);
		}
		assert.equal(fixture.metadata.getSessionArchived(fixture.sessionId), true);
		assert.equal(fixture.host.store.has(uri), true);

		const freshCatalogue = await new PiSessionCatalogue(
			fixture.root,
			new MetadataStore(join(fixture.root, "metadata.json")),
		).list(undefined, undefined);
		const archived = freshCatalogue.items.find((item) => item.resource === uri);
		assert.ok(archived);
		assert.notEqual(archived.status & SessionStatus.IsArchived, 0);
	} finally {
		await fixture.close();
	}
});
