/** Deterministic pool fan-out and handle lifetime without OS or protocol timing. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { ParcelWatchPool } from "../src/pi/parcel-watch-pool.ts";
import type { FileWatchChangeKind, FileWatchSource } from "../src/pi/watch-source.ts";
import { eventually } from "./support/async.ts";

class ControlledSource implements FileWatchSource {
	#change: ((path: string, kind: FileWatchChangeKind) => void) | undefined;
	#error: ((error: unknown) => void) | undefined;
	closes = 0;

	onChange(listener: (path: string, kind: FileWatchChangeKind) => void): void {
		this.#change = listener;
	}
	onError(listener: (error: unknown) => void): void {
		this.#error = listener;
	}
	async close(): Promise<void> {
		this.closes++;
	}

	change(path: string, kind: FileWatchChangeKind): void {
		this.#change?.(path, kind);
	}
	fail(error: Error): void {
		this.#error?.(error);
	}
}

it("coalesces concurrent opens and closes only after the last consumer", async () => {
	const first = new ControlledSource();
	const gate = Promise.withResolvers<FileWatchSource>();
	const sources = [first];
	let opens = 0;
	const pool = new ParcelWatchPool(async () => {
		opens++;
		if (opens === 1) return gate.promise;
		const next = new ControlledSource();
		sources.push(next);
		return next;
	});
	const firstPending = pool.acquire("/same/root");
	const secondPending = pool.acquire("/same/root");
	await eventually("shared opener", () => opens === 1);
	gate.resolve(first);
	const [a, b] = await Promise.all([firstPending, secondPending]);
	const aEvents: string[] = [];
	const bEvents: string[] = [];
	a.onChange((path) => aEvents.push(path));
	b.onChange((path) => bEvents.push(path));
	first.change("/same/root/a.txt", "added");
	assert.deepEqual(aEvents, ["/same/root/a.txt"]);
	assert.deepEqual(bEvents, ["/same/root/a.txt"]);

	await a.close();
	assert.equal(first.closes, 0);
	first.change("/same/root/b.txt", "updated");
	assert.deepEqual(aEvents, ["/same/root/a.txt"]);
	assert.deepEqual(bEvents, ["/same/root/a.txt", "/same/root/b.txt"]);
	await b.close();
	await b.close();
	assert.equal(first.closes, 1);

	const next = await pool.acquire("/same/root");
	assert.equal(opens, 2);
	await next.close();
	assert.equal(sources[1]?.closes, 1);
});

it("waits for the last close before reopening the same root", async (t) => {
	const firstSource = new ControlledSource();
	const gate = Promise.withResolvers<void>();
	let closeStarted = false;
	const originalClose = firstSource.close.bind(firstSource);
	t.mock.method(firstSource, "close", async () => {
		await originalClose();
		closeStarted = true;
		await gate.promise;
	});
	let opens = 0;
	const pool = new ParcelWatchPool(async () => {
		opens++;
		return opens === 1 ? firstSource : new ControlledSource();
	});
	const first = await pool.acquire("/same/root");
	const closing = first.close();
	await eventually("native close started", () => closeStarted);
	const reopening = pool.acquire("/same/root");
	let second: FileWatchSource | undefined;
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(opens, 1, "a new native subscribe must wait for the old unsubscribe");
		gate.resolve();
		await closing;
		second = await reopening;
		assert.equal(opens, 2);
	} finally {
		gate.resolve();
		await closing.catch(() => undefined);
		await (second ?? (await reopening.catch(() => undefined)))?.close();
	}
});

it("fans native errors out and lets a later explicit watch start a fresh source", async () => {
	const sources: ControlledSource[] = [];
	const pool = new ParcelWatchPool(async () => {
		const source = new ControlledSource();
		sources.push(source);
		return source;
	});
	const [a, b] = await Promise.all([pool.acquire("/same/root"), pool.acquire("/same/root")]);
	const errors: unknown[] = [];
	a.onError((error) => errors.push(error));
	b.onError((error) => errors.push(error));
	const failed = new Error("native watch failed");
	sources[0]?.fail(failed);
	assert.deepEqual(errors, [failed, failed]);
	await assert.rejects(pool.acquire("/same/root"), (error: unknown) => error === failed);
	assert.equal(sources.length, 1, "a failed source stays unavailable until its consumers release it");
	await Promise.all([a.close(), b.close()]);
	assert.equal(sources[0]?.closes, 1);
	const retry = await pool.acquire("/same/root");
	assert.equal(sources.length, 2);
	await retry.close();
});
