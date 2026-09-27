/** Real native-backend behavior before it is exposed on an AHP channel. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import parcel from "@parcel/watcher";
import { openParcelWatchSource } from "../src/pi/parcel-watch-source.ts";
import { eventually } from "./support/async.ts";

type Change = { path: string; kind: "added" | "updated" | "deleted" };

async function start(t: { after: (fn: () => Promise<void>) => void }) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-ahp-parcel-source-")));
	const root = join(base, "watched");
	mkdirSync(root);
	let source: Awaited<ReturnType<typeof openParcelWatchSource>>;
	try {
		source = await openParcelWatchSource({ root });
	} catch (error) {
		rmSync(base, { recursive: true, force: true });
		throw error;
	}
	t.after(async () => {
		try {
			await source.close();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	const changes: Change[] = [];
	const errors: unknown[] = [];
	source.onChange((path, kind) => changes.push({ path, kind }));
	source.onError((error) => errors.push(error));
	const mark = (): number => changes.length;
	const expect = async (path: string, kind: Change["kind"], since: number): Promise<void> => {
		await eventually(
			`${kind} ${path}`,
			() => {
				assert.deepEqual(errors, [], "watch source failed before the expected event");
				return changes.slice(since).some((change) => change.path === path && change.kind === kind);
			},
			{ timeoutMs: 4_000, describe: () => ({ changes, errors }) },
		);
		assert.deepEqual(errors, []);
	};
	return { base, root, changes, mark, expect };
}

it("maps native recursive create, update, and delete events", { timeout: 15_000 }, async (t) => {
	const { root, mark, expect } = await start(t);
	const nested = join(root, "nested");
	const beforeDirectory = mark();
	mkdirSync(nested);
	await expect(nested, "added", beforeDirectory);
	const file = join(nested, "file.txt");
	const beforeCreate = mark();
	writeFileSync(file, "first");
	await expect(file, "added", beforeCreate);
	const beforeUpdate = mark();
	writeFileSync(file, "second");
	await expect(file, "updated", beforeUpdate);
	const beforeDelete = mark();
	rmSync(file);
	await expect(file, "deleted", beforeDelete);
});

it("reports changes to the root without treating them as replacement", { timeout: 15_000 }, async (t) => {
	const { root, changes, mark, expect } = await start(t);
	const beforeUpdate = mark();
	utimesSync(root, new Date(1_700_000_000_000), new Date(Date.now() + 3_600_000));
	await expect(root, "updated", beforeUpdate);
	assert.ok(
		changes
			.slice(beforeUpdate)
			.filter((change) => change.path === root)
			.every((change) => change.kind === "updated"),
	);
	const child = join(root, "still-attached.txt");
	const beforeChild = mark();
	writeFileSync(child, "x");
	await expect(child, "added", beforeChild);
});

it("resumes observing children when the watched root is removed and recreated", { timeout: 15_000 }, async (t) => {
	const { root, mark, expect } = await start(t);
	const beforeDelete = mark();
	rmSync(root, { recursive: true });
	await expect(root, "deleted", beforeDelete);
	const beforeRecreate = mark();
	mkdirSync(root);
	await expect(root, "added", beforeRecreate);
	const child = join(root, "after.txt");
	const beforeChild = mark();
	writeFileSync(child, "new");
	await expect(child, "added", beforeChild);
});

it("reattaches to an atomic directory replacement", { timeout: 15_000 }, async (t) => {
	const { base, root, mark, expect } = await start(t);
	const old = join(base, "old");
	const replacement = join(base, "replacement");
	mkdirSync(replacement);
	const beforeReplace = mark();
	renameSync(root, old);
	renameSync(replacement, root);
	await expect(root, "updated", beforeReplace);
	const child = join(root, "after.txt");
	const beforeChild = mark();
	writeFileSync(child, "new");
	await expect(child, "added", beforeChild);
});

it("rejects a native error delivered before subscribe resolves", async (t) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-ahp-parcel-early-error-")));
	const root = join(base, "watched");
	mkdirSync(root);
	let unsubscribes = 0;
	t.mock.method(parcel, "subscribe", async (...args: Parameters<typeof parcel.subscribe>) => {
		const [, callback] = args;
		callback(new Error("early native failure"), []);
		return {
			unsubscribe: async () => {
				unsubscribes++;
			},
		};
	});
	try {
		await assert.rejects(openParcelWatchSource({ root }), /early native failure/);
		assert.equal(unsubscribes, 1);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

it("drains a late native subscribe before closing", { timeout: 10_000 }, async (t) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-ahp-parcel-late-close-")));
	const root = join(base, "watched");
	const old = join(base, "old");
	const replacement = join(base, "replacement");
	mkdirSync(root);
	mkdirSync(replacement);
	const callbacks: Array<Parameters<typeof parcel.subscribe>[1]> = [];
	const unsubscribes = [0, 0];
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	t.mock.method(parcel, "subscribe", async (...args: Parameters<typeof parcel.subscribe>) => {
		const [, callback] = args;
		const index = callbacks.push(callback) - 1;
		if (index === 1) {
			entered.resolve();
			await gate.promise;
		}
		return {
			unsubscribe: async () => {
				unsubscribes[index] = (unsubscribes[index] ?? 0) + 1;
			},
		};
	});
	let source: Awaited<ReturnType<typeof openParcelWatchSource>> | undefined;
	try {
		source = await openParcelWatchSource({ root });
		renameSync(root, old);
		renameSync(replacement, root);
		callbacks[0]?.(null, [{ path: root, type: "create" }]);
		await eventually("replacement subscribe started", () => callbacks.length === 2, { timeoutMs: 4_000 });
		await entered.promise;
		let closed = false;
		const closing = source.close().then(() => {
			closed = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(closed, false, "close must wait for the pending subscribe");
		gate.resolve();
		await closing;
		assert.deepEqual(unsubscribes, [1, 1]);
	} finally {
		gate.resolve();
		try {
			await source?.close();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}
});
