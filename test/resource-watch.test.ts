/** Real filesystem / WebSocket integration. Pure filtering and batching rules have separate tests. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	ResourceChangeType,
	type ResourceWatchState,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { FSWatcher } from "chokidar";
import { installRootChannel } from "../src/channels/root.ts";
import { AhpHost } from "../src/core/host.ts";
import { ResourcePathPolicy } from "../src/pi/resource-paths.ts";
import { ResourceWatchService } from "../src/pi/resource-watch.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { checkSchema } from "./support/schema.ts";
import { WatchEvents } from "./support/watch-events.ts";

const uri = (path: string): string => pathToFileURL(path).toString();

async function connectClient(server: RunningServer, clientId = "watch-client"): Promise<AhpClient> {
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	await client.initialize({ clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	return client;
}

async function startFixture(options: { graceMs?: number; restrictToWorkspace?: boolean } = {}) {
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-watch-"));
	const host = new AhpHost();
	installRootChannel(host, []);
	const watches = new ResourceWatchService(host, {
		pathPolicy: new ResourcePathPolicy(options.restrictToWorkspace ? [workspace] : []),
		// Ordinary integration cases use production grace, not lifetime-test timing.
		...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
		debounceMs: 20,
	});
	host.serve({ resourceWatches: watches });
	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const client = await connectClient(server);
	const collectors: WatchEvents[] = [];
	return {
		host,
		watches,
		client,
		server,
		workspace,
		async observe(channel: string) {
			const { result, subscription } = await client.subscribe(channel);
			assert.ok(result.snapshot, "watch must still exist when subscription is accepted");
			const events = new WatchEvents(subscription, () => ({
				channel,
				exists: host.store.has(channel),
				activeCount: watches.activeCount,
			}));
			collectors.push(events);
			return events;
		},
		async close() {
			try {
				await Promise.all(collectors.map((events) => events.close()));
			} finally {
				await watches.dispose();
				await client.shutdown();
				await server.close();
				rmSync(workspace, { recursive: true, force: true });
			}
		},
	};
}

async function expectChange(events: WatchEvents, path: string, type: ResourceChangeType, since = 0) {
	const expected = { uri: uri(path), type };
	const changes = await events.waitFor(
		`${type}: ${expected.uri}`,
		(items) => items.some((item) => item.uri === expected.uri),
		since,
	);
	const change = changes.find((item) => item.uri === expected.uri);
	assert.deepEqual(change, expected);
	return change;
}

async function expectRpcError(promise: Promise<unknown>, code: number): Promise<void> {
	await assert.rejects(promise, (error: unknown) => error instanceof RpcError && error.code === code);
}

async function settle(ms: number): Promise<void> {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

describe("resource watch", () => {
	let fixture: Awaited<ReturnType<typeof startFixture>>;
	beforeEach(async () => {
		fixture = await startFixture();
	});
	afterEach(async () => {
		await fixture.close();
	});

	it("returns a watch channel whose state describes what is watched", async () => {
		const result = await fixture.client.createResourceWatch({
			uri: uri(fixture.workspace),
			recursive: true,
			excludes: { items: ["**/.git/**"] },
			includes: { items: ["**/*.ts"] },
		});
		assert.match(result.channel, /^ahp-resource-watch:\//);
		const { result: subscribed } = await fixture.client.subscribe(result.channel);
		assert.ok(subscribed.snapshot);
		const state = subscribed.snapshot.state as ResourceWatchState;
		assert.deepEqual(state, {
			root: uri(fixture.workspace),
			recursive: true,
			excludes: { items: ["**/.git/**"] },
			includes: { items: ["**/*.ts"] },
		});
		assert.equal(checkSchema("state", "ResourceWatchState", state), undefined);
	});

	it("classifies newly created paths as added", async () => {
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const events = await fixture.observe(channel);
		const target = join(fixture.workspace, "created.txt");
		writeFileSync(target, "hi");
		assert.equal(
			checkSchema("state", "ResourceChange", await expectChange(events, target, ResourceChangeType.Added)),
			undefined,
		);
	});

	it("classifies changes to existing paths as updated", async () => {
		const target = join(fixture.workspace, "existing.txt");
		writeFileSync(target, "before");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const events = await fixture.observe(channel);
		writeFileSync(target, "after");
		await expectChange(events, target, ResourceChangeType.Updated);
	});

	it("watches a single file at its actual URI", async () => {
		const target = join(fixture.workspace, "watched.txt");
		writeFileSync(target, "before");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(target) });
		const events = await fixture.observe(channel);
		writeFileSync(join(fixture.workspace, "sibling.txt"), "unrelated");
		writeFileSync(target, "after");
		await expectChange(events, target, ResourceChangeType.Updated);
		// Check delivered traffic; exhaustive sibling exclusion is a pure policy test.
		assert.ok(events.changes.every((change) => change.uri === uri(target)));
	});

	it("reports deletion and recreation of the watched file", async () => {
		const target = join(fixture.workspace, "recreated.txt");
		writeFileSync(target, "before");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(target) });
		const events = await fixture.observe(channel);
		rmSync(target);
		await expectChange(events, target, ResourceChangeType.Deleted);
		const since = events.mark();
		writeFileSync(target, "after");
		await expectChange(events, target, ResourceChangeType.Added, since);
	});

	it("keeps a single-file watch attached across an atomic replacement", async () => {
		const target = join(fixture.workspace, "atomic.txt");
		const replacement = join(fixture.workspace, ".atomic.txt.tmp");
		writeFileSync(target, "before");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(target) });
		const events = await fixture.observe(channel);
		writeFileSync(replacement, "replacement");
		renameSync(replacement, target);
		await expectChange(events, target, ResourceChangeType.Updated);
		// Chokidar suppresses duplicate change callbacks for 50ms. This second
		// save deliberately happens outside that documented implementation window.
		await settle(150);
		const since = events.mark();
		writeFileSync(target, "after");
		await expectChange(events, target, ResourceChangeType.Updated, since);
	});

	it("keeps a directory watch attached across deletion and recreation", async () => {
		const target = join(fixture.workspace, "folder");
		mkdirSync(target);
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(target) });
		const events = await fixture.observe(channel);
		rmSync(target, { recursive: true });
		await expectChange(events, target, ResourceChangeType.Deleted);
		const since = events.mark();
		mkdirSync(target);
		await expectChange(events, target, ResourceChangeType.Added, since);
		const child = join(target, "child.txt");
		writeFileSync(child, "content");
		await expectChange(events, child, ResourceChangeType.Added, since);
	});

	it("reports both sides of a rename without assuming batch boundaries", async () => {
		const source = join(fixture.workspace, "before.txt");
		const destination = join(fixture.workspace, "after.txt");
		writeFileSync(source, "content");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const events = await fixture.observe(channel);
		renameSync(source, destination);
		await Promise.all([
			expectChange(events, source, ResourceChangeType.Deleted),
			expectChange(events, destination, ResourceChangeType.Added),
		]);
	});

	it("does not lose paths from a burst", async () => {
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const events = await fixture.observe(channel);
		const paths = Array.from({ length: 5 }, (_, i) => join(fixture.workspace, `burst-${i}.txt`));
		for (const path of paths) writeFileSync(path, "x");
		await Promise.all(paths.map((path) => expectChange(events, path, ResourceChangeType.Added)));
	});

	for (const recursive of [false, true]) {
		it(`reports ${recursive ? "grandchildren" : "direct children"} with recursive=${recursive}`, async () => {
			const nested = join(fixture.workspace, "nested");
			mkdirSync(nested);
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace), recursive });
			const events = await fixture.observe(channel);
			const direct = join(fixture.workspace, "direct.txt");
			const deep = join(nested, "deep.txt");
			writeFileSync(deep, "deep");
			writeFileSync(direct, "direct");
			await expectChange(events, recursive ? deep : direct, ResourceChangeType.Added);
			if (!recursive) assert.ok(events.changes.every((change) => change.uri !== uri(deep)));
		});
	}

	for (const filter of ["includes", "excludes"] as const) {
		it(`wires ${filter} into native watch delivery`, async () => {
			const { channel } = await fixture.client.createResourceWatch({
				uri: uri(fixture.workspace),
				recursive: true,
				...(filter === "includes"
					? { includes: { items: ["**/*.md"] } }
					: { excludes: { items: ["**/node_modules/**"] } }),
			});
			const events = await fixture.observe(channel);
			const ignoredDir = join(fixture.workspace, "node_modules");
			mkdirSync(ignoredDir);
			writeFileSync(join(ignoredDir, "ignored.txt"), "x");
			const target = join(fixture.workspace, "kept.md");
			writeFileSync(target, "x");
			await expectChange(events, target, ResourceChangeType.Added);
			assert.ok(
				events.changes.every((change) =>
					filter === "includes" ? change.uri.endsWith(".md") : !change.uri.includes("/node_modules/"),
				),
			);
		});
	}

	it("rejects watching something that does not exist", async () => {
		await expectRpcError(fixture.client.createResourceWatch({ uri: uri(join(fixture.workspace, "missing")) }), -32008);
		assert.equal(fixture.watches.activeCount, 0);
	});

	it("rejects a recursive watch on a file", async () => {
		const target = join(fixture.workspace, "file.txt");
		writeFileSync(target, "x");
		await expectRpcError(fixture.client.createResourceWatch({ uri: uri(target), recursive: true }), -32602);
		assert.equal(fixture.watches.activeCount, 0);
	});

	it("rejects malformed filter parameters", async () => {
		await expectRpcError(
			fixture.client.request("createResourceWatch", {
				channel: "ahp-root://",
				uri: uri(fixture.workspace),
				includes: { items: [42] },
			} as never),
			-32602,
		);
		assert.equal(fixture.watches.activeCount, 0);
	});
});

describe("resource watch — roots", () => {
	it("maps a permitted directory symlink back to the requested URI", async () => {
		const fixture = await startFixture({ restrictToWorkspace: true });
		try {
			const target = join(fixture.workspace, "target");
			const link = join(fixture.workspace, "link");
			mkdirSync(target);
			const child = join(target, "watched.txt");
			writeFileSync(child, "before");
			symlinkSync(target, link, "dir");
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(link), recursive: true });
			const events = await fixture.observe(channel);
			writeFileSync(child, "after");
			await expectChange(events, join(link, "watched.txt"), ResourceChangeType.Updated);
		} finally {
			await fixture.close();
		}
	});

	it("uses the same root and symlink policy as resource operations", async () => {
		const fixture = await startFixture({ restrictToWorkspace: true });
		const outside = mkdtempSync(join(tmpdir(), "pi-ahp-watch-outside-"));
		try {
			const inside = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			assert.match(inside.channel, /^ahp-resource-watch:\//);
			await expectRpcError(fixture.client.createResourceWatch({ uri: uri(outside) }), -32009);
			const link = join(fixture.workspace, "escape");
			symlinkSync(outside, link, "dir");
			await expectRpcError(fixture.client.createResourceWatch({ uri: uri(link) }), -32009);
			assert.equal(fixture.watches.activeCount, 1);
		} finally {
			await fixture.close();
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("resource watch — lifetime", { timeout: 10_000 }, () => {
	it("waits for the last subscriber before scheduling release", async (t) => {
		const fixture = await startFixture({ graceMs: 120 });
		const other = await connectClient(fixture.server, "other-watch-client");
		try {
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			await fixture.client.subscribe(channel);
			await other.subscribe(channel);
			// Native setup has completed. Only the host's grace timer is driven by ticks.
			t.mock.timers.enable({ apis: ["setTimeout"] });
			await fixture.client.unsubscribe(channel);
			await fixture.client.ping();
			t.mock.timers.tick(120);
			assert.equal(fixture.watches.activeCount, 1);
			await other.unsubscribe(channel);
			await other.ping();
			t.mock.timers.tick(119);
			assert.equal(fixture.watches.activeCount, 1);
			t.mock.timers.tick(1);
			assert.equal(fixture.watches.activeCount, 0);
			assert.equal(fixture.host.store.has(channel), false);
		} finally {
			t.mock.timers.reset();
			await other.shutdown();
			await fixture.close();
		}
	});

	for (const method of ["subscribe", "initialize", "reconnect"] as const) {
		it(`cancels grace on ${method} and grants a full window after the next unsubscribe`, async (t) => {
			const fixture = await startFixture({ graceMs: 120 });
			let replacement: AhpClient | undefined;
			try {
				const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
				await fixture.client.subscribe(channel);
				const counts: number[] = [];
				const unhook = fixture.host.onSubscriberCountChanged((changed, count) => {
					if (changed === channel) counts.push(count);
				});
				t.after(unhook);
				t.mock.timers.enable({ apis: ["setTimeout"] });
				await fixture.client.unsubscribe(channel);
				await fixture.client.ping();
				t.mock.timers.tick(60);
				let owner = fixture.client;
				if (method === "subscribe") await owner.subscribe(channel);
				else {
					replacement = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${fixture.server.port}`));
					replacement.connect();
					owner = replacement;
					if (method === "initialize")
						await owner.initialize({
							clientId: "replacement",
							protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
							initialSubscriptions: [channel],
						});
					else
						await owner.reconnect({
							clientId: "replacement",
							lastSeenServerSeq: fixture.host.serverSeq,
							subscriptions: [channel],
						});
				}
				assert.deepEqual(counts, [0, 1]);
				t.mock.timers.tick(120);
				assert.equal(fixture.watches.activeCount, 1);
				await owner.unsubscribe(channel);
				await owner.ping();
				t.mock.timers.tick(119);
				assert.equal(fixture.watches.activeCount, 1);
				t.mock.timers.tick(1);
				assert.equal(fixture.watches.activeCount, 0);
				assert.deepEqual(counts, [0, 1, 0]);
			} finally {
				t.mock.timers.reset();
				await replacement?.shutdown();
				await fixture.close();
			}
		});
	}

	it("releases a watch when the client disconnects without unsubscribing", async (t) => {
		const fixture = await startFixture({ graceMs: 120 });
		try {
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			await fixture.client.subscribe(channel);
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const disconnected = Promise.withResolvers<void>();
			const unhook = fixture.host.onSubscriberCountChanged((changed, count) => {
				if (changed === channel && count === 0) disconnected.resolve();
			});
			t.after(unhook);
			await fixture.client.shutdown();
			await disconnected.promise;
			t.mock.timers.tick(119);
			assert.equal(fixture.watches.activeCount, 1);
			t.mock.timers.tick(1);
			assert.equal(fixture.watches.activeCount, 0);
			assert.equal(fixture.host.store.has(channel), false);
		} finally {
			t.mock.timers.reset();
			await fixture.close();
		}
	});

	it("releases a watch nobody ever subscribed to", async (t) => {
		const fixture = await startFixture({ graceMs: 120 });
		try {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			t.mock.timers.tick(119);
			assert.equal(fixture.watches.activeCount, 1);
			t.mock.timers.tick(1);
			assert.equal(fixture.watches.activeCount, 0);
			assert.equal(fixture.host.store.has(channel), false);
		} finally {
			t.mock.timers.reset();
			await fixture.close();
		}
	});

	it("disposes every watch and returns the same shutdown promise", async () => {
		const fixture = await startFixture();
		try {
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			await fixture.client.subscribe(channel);
			const closing = fixture.watches.dispose();
			assert.equal(fixture.watches.dispose(), closing);
			await closing;
			assert.equal(fixture.watches.activeCount, 0);
			assert.equal(fixture.host.store.has(channel), false);
		} finally {
			await fixture.close();
		}
	});

	it("waits for a blocked creation to settle before completing shutdown", async (t) => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-watch-shutdown-"));
		const policy = new ResourcePathPolicy();
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const pathFor = policy.pathFor.bind(policy);
		t.mock.method(policy, "pathFor", async (value: unknown) => {
			const path = await pathFor(value);
			entered.resolve();
			await gate.promise;
			return path;
		});
		const service = new ResourceWatchService(new AhpHost(), { pathPolicy: policy });
		try {
			const creating = service.create({ channel: "ahp-root://", uri: uri(workspace) });
			const rejected = assert.rejects(creating, /disposed/);
			await entered.promise;
			let finished = false;
			const closing = service.dispose();
			void closing.then(() => {
				finished = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(finished, false, "shutdown must drain the admitted create operation");
			gate.resolve();
			await closing;
			await rejected;
			assert.equal(service.activeCount, 0);
		} finally {
			gate.resolve();
			await service.dispose();
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("closes a native watcher if shutdown wins at its ready boundary", async (t) => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-watch-ready-"));
		const service = new ResourceWatchService(new AhpHost());
		let shutdown: Promise<void> | undefined;
		let closed = 0;
		const emit = FSWatcher.prototype.emit;
		const close = FSWatcher.prototype.close;
		// Observe the real ready event; no synthetic watcher or backend factory.
		t.mock.method(FSWatcher.prototype, "emit", function (this: FSWatcher, event: string | symbol, ...args: unknown[]) {
			if (event === "ready") shutdown = service.dispose();
			return Reflect.apply(emit, this, [event, ...args]);
		});
		t.mock.method(FSWatcher.prototype, "close", async function (this: FSWatcher) {
			await close.call(this);
			closed++;
		});
		try {
			await assert.rejects(service.create({ channel: "ahp-root://", uri: uri(workspace) }), /disposed/);
			assert.ok(shutdown, "the real watcher must have reached ready");
			await shutdown;
			assert.equal(closed, 1);
			assert.equal(service.activeCount, 0);
		} finally {
			await service.dispose();
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("drains in-flight creations and rejects new ones after shutdown", async () => {
		const fixture = await startFixture();
		try {
			const params = { channel: "ahp-root://", uri: uri(fixture.workspace) } as const;
			const creating = fixture.watches.create(params);
			const rejected = assert.rejects(creating, /disposed/);
			const closing = fixture.watches.dispose();
			assert.equal(fixture.watches.dispose(), closing);
			await closing;
			await rejected;
			assert.equal(fixture.watches.activeCount, 0);
			await assert.rejects(fixture.watches.create(params), /disposed/);
		} finally {
			await fixture.close();
		}
	});
});
