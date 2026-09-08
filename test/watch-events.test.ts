/** Regression tests for the watch test reader itself, independent of OS delivery. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { ActionType, type ResourceChange, ResourceChangeType } from "@microsoft/agent-host-protocol";
import type { SubscriptionEvent } from "@microsoft/agent-host-protocol/client";
import { WatchEvents } from "./support/watch-events.ts";

function source() {
	let pending: ReturnType<typeof Promise.withResolvers<IteratorResult<SubscriptionEvent>>> | undefined;
	let reads = 0;
	return {
		get reads() {
			return reads;
		},
		next(): Promise<IteratorResult<SubscriptionEvent>> {
			assert.equal(pending, undefined, "only one next() may be outstanding");
			reads++;
			pending = Promise.withResolvers<IteratorResult<SubscriptionEvent>>();
			return pending.promise;
		},
		async return(): Promise<IteratorResult<SubscriptionEvent>> {
			const result: IteratorResult<SubscriptionEvent> = { done: true, value: undefined };
			// Match the SDK: detaching does not settle an outstanding next().
			pending = undefined;
			return result;
		},
		fail(error: Error): void {
			assert.ok(pending);
			pending.reject(error);
			pending = undefined;
		},
		push(items: ResourceChange[]): void {
			assert.ok(pending);
			pending.resolve({
				done: false,
				value: {
					type: "action",
					params: {
						channel: "ahp-resource-watch:/test",
						serverSeq: reads,
						origin: undefined,
						action: { type: ActionType.ResourceWatchChanged, changes: { items } },
					},
				},
			});
			pending = undefined;
		},
	};
}
const added = (name: string): ResourceChange => ({ uri: `file:///${name}`, type: ResourceChangeType.Added });

it("watch assertions share a reader and retain the entire batch, even after a match", async () => {
	const input = source();
	const events = new WatchEvents(input);
	try {
		const first = events.waitFor("a", (items) => items.some((item) => item.uri === "file:///a"));
		const second = events.waitFor("b", (items) => items.some((item) => item.uri === "file:///b"));
		assert.equal(input.reads, 1);
		input.push([added("a"), added("b")]);
		assert.deepEqual(await first, [added("a"), added("b")]);
		assert.deepEqual(await second, [added("a"), added("b")]);
		assert.deepEqual(events.batches, [[added("a"), added("b")]]);
		assert.deepEqual(
			await events.waitFor("already received b", (items) => items.some((item) => item.uri === "file:///b")),
			events.changes,
		);
	} finally {
		await events.close();
	}
});

it("a timed-out assertion neither steals the next batch nor accepts events before its checkpoint", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const input = source();
	const events = new WatchEvents(input, () => ({ exists: true }));
	try {
		input.push([added("a")]);
		await events.waitFor("first a", (items) => items.length === 1);
		const since = events.mark();
		const rejected = assert.rejects(
			events.waitFor("second a", (items) => items.length > 0, since, 10),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /second a/);
				assert.match(error.message, /"exists":true/);
				assert.match(error.message, /file:\/\/\/a/);
				return true;
			},
		);
		t.mock.timers.tick(10);
		await rejected;
		assert.equal(input.reads, 2, "timeout must not start another reader");
		const next = events.waitFor("second a", (items) => items.length > 0, since);
		input.push([added("a")]);
		assert.deepEqual(await next, [added("a")]);
		assert.equal(events.batches.length, 2);
	} finally {
		await events.close();
	}
});

it("reports a reader failure during cleanup even without a waiting assertion", async () => {
	const input = source();
	const events = new WatchEvents(input);
	const error = new Error("subscription read failed");
	input.fail(error);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await assert.rejects(events.close(), (received: unknown) => received === error);
});

it("closing the journal settles pending assertions and the sole subscription reader", async () => {
	const input = source();
	const events = new WatchEvents(input);
	const rejected = assert.rejects(events.waitFor("never arrives", (items) => items.length > 0));
	await events.close();
	await rejected;
	assert.equal(input.reads, 1);
});
