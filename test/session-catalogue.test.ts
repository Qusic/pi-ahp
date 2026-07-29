/**
 * The session catalogue: ordering, pagination, and title derivation.
 *
 * Runs against a synthetic sessions directory so the tests never depend on
 * whatever the developer happens to have in `~/.pi/agent/sessions`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type ListSessionsResult, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { sessionUri } from "../src/core/channels.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";
import { checkSchema } from "./support/schema.ts";

interface FakeSessionOptions {
	readonly cwd: string;
	readonly firstUserMessage?: string;
	readonly name?: string;
	/** Seconds since the epoch; controls catalogue ordering. */
	readonly mtimeSeconds: number;
}

/**
 * Writes a minimal but genuine pi session file: a `session` header followed by
 * entries linked through `id`/`parentId`.
 */
function writeFakeSession(root: string, id: string, options: FakeSessionOptions): string {
	const dirName = `--${options.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const directory = join(root, dirName);
	mkdirSync(directory, { recursive: true });

	const timestamp = new Date(options.mtimeSeconds * 1000).toISOString();
	const lines: string[] = [
		JSON.stringify({
			type: "session",
			id,
			parentId: null,
			timestamp,
			version: 3,
			cwd: options.cwd,
		}),
	];

	let parentId: string | null = null;
	const push = (entry: Record<string, unknown>): void => {
		const entryId = randomUUID();
		lines.push(JSON.stringify({ ...entry, id: entryId, parentId, timestamp }));
		parentId = entryId;
	};

	if (options.firstUserMessage) {
		push({ type: "message", message: { role: "user", content: options.firstUserMessage, timestamp: 0 } });
	}
	if (options.name) {
		push({ type: "session_info", name: options.name });
	}

	const path = join(directory, `${options.mtimeSeconds}_${id}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	utimesSync(path, options.mtimeSeconds, options.mtimeSeconds);
	return path;
}

describe("session catalogue", () => {
	let root: string;
	let catalogue: PiSessionCatalogue;
	const ids: string[] = [];

	before(() => {
		root = mkdtempSync(join(tmpdir(), "pi-ahp-catalogue-"));
		// Interleave two working directories so the walk covers >1 session dir.
		for (let i = 0; i < 5; i++) {
			const id = randomUUID();
			ids.push(id);
			writeFakeSession(root, id, {
				cwd: i % 2 === 0 ? "/tmp/project-a" : "/tmp/project-b",
				firstUserMessage: `Message number ${i}`,
				mtimeSeconds: 1_700_000_000 + i,
			});
		}
		catalogue = new PiSessionCatalogue(root);
	});

	after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns most-recently-modified first, across working directories", async () => {
		const result = await catalogue.list(undefined, undefined);

		assert.equal(result.items.length, 5);
		assert.deepEqual(
			result.items.map((item) => item.resource),
			[...ids].reverse().map(sessionUri),
		);
	});

	it("paginates with an opaque cursor and stops at the end", async () => {
		const first: ListSessionsResult = await catalogue.list(2, undefined);
		assert.equal(first.items.length, 2);
		assert.ok(first.nextCursor);

		const second = await catalogue.list(2, first.nextCursor);
		assert.equal(second.items.length, 2);
		assert.ok(second.nextCursor);

		const third = await catalogue.list(2, second.nextCursor);
		assert.equal(third.items.length, 1);
		// A missing nextCursor is what signals the end of the catalogue.
		assert.equal(third.nextCursor, undefined);

		const seen = [...first.items, ...second.items, ...third.items].map((item) => item.resource);
		assert.equal(new Set(seen).size, 5, "pages must not overlap");
	});

	it("rejects a malformed cursor with InvalidParams", async () => {
		await assert.rejects(
			() => catalogue.list(2, "not-a-cursor"),
			(error: { code?: number }) => error.code === -32602,
		);
	});

	it("titles a session by its name, falling back to the first user message", async () => {
		const named = randomUUID();
		writeFakeSession(root, named, {
			cwd: "/tmp/project-c",
			firstUserMessage: "This should lose to the explicit name",
			name: "Nightly refactor",
			mtimeSeconds: 1_700_001_000,
		});

		const result = await catalogue.list(1, undefined);
		// Same rule pi's own /resume picker uses: `name ?? firstMessage`.
		assert.equal(result.items[0]?.title, "Nightly refactor");

		const unnamed = await catalogue.list(2, undefined);
		assert.equal(unnamed.items[1]?.title, "Message number 4");
	});

	it("skips files that are not readable pi sessions", async () => {
		const directory = join(root, "--tmp-project-broken--");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "1700002000_broken.jsonl"), "not json at all\n");

		// One corrupt file must not take down the whole catalogue.
		const result = await catalogue.list(undefined, undefined);
		assert.ok(result.items.length >= 5);
	});

	it("returns an empty catalogue when nothing exists yet", async () => {
		const empty = new PiSessionCatalogue(join(root, "does-not-exist"));
		assert.deepEqual(await empty.list(undefined, undefined), { items: [] });
	});
});

describe("listSessions over the wire", () => {
	let harness: Harness;
	let root: string;

	before(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-ahp-catalogue-wire-"));
		writeFakeSession(root, randomUUID(), {
			cwd: "/tmp/wire",
			firstUserMessage: "Explain this repository",
			mtimeSeconds: 1_700_100_000,
		});
		harness = await startHarness({ sessions: true, catalogueRoot: root });
	});

	after(async () => {
		await harness.dispose();
		rmSync(root, { recursive: true, force: true });
	});

	it("serves a schema-conforming page", async () => {
		const client = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

		const result = await client.request("listSessions", { channel: "ahp-root://" } as never);

		assert.equal(result.items.length, 1);
		assert.equal(result.items[0]?.title, "Explain this repository");
		assert.equal(checkSchema("commands", "ListSessionsResult", result), undefined);
	});
});
