/**
 * Filesystem watches: typed changes, recursive scope, filtering, path policy,
 * and subscription-owned native watcher lifetime.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/resource-watch-channel
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	ActionType,
	type ResourceChange,
	ResourceChangeType,
	type ResourceWatchState,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError, type Subscription } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { AhpHost } from "../src/core/host.ts";
import { ResourcePathPolicy } from "../src/pi/resource-paths.ts";
import { ResourceWatchService } from "../src/pi/resource-watch.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { checkSchema } from "./support/schema.ts";

const uri = (path: string): string => pathToFileURL(path).toString();
const EVENT_SETTLE_MS = 150;

interface Fixture {
	host: AhpHost;
	watches: ResourceWatchService;
	client: AhpClient;
	server: RunningServer;
	workspace: string;
	close(): Promise<void>;
}

async function connectClient(server: RunningServer, clientId = "watch-client"): Promise<AhpClient> {
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	await client.initialize({ clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	return client;
}

async function startFixture(options: { graceMs?: number; restrictToWorkspace?: boolean } = {}): Promise<Fixture> {
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-watch-"));
	const host = new AhpHost();
	installRootChannel(host, []);
	const watches = new ResourceWatchService(host, {
		pathPolicy: new ResourcePathPolicy(options.restrictToWorkspace ? [workspace] : []),
		// Short windows keep the lifetime tests honest without making them slow.
		graceMs: options.graceMs ?? 200,
		debounceMs: 20,
	});
	host.serve({ resourceWatches: watches });

	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const client = await connectClient(server);

	return {
		host,
		watches,
		client,
		server,
		workspace,
		async close() {
			await watches.dispose();
			await client.shutdown();
			await server.close();
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}

/** Collects the next batch of changes, failing fast on a stall. */
async function nextChanges(subscription: Subscription, timeoutMs = 4_000): Promise<ResourceChange[]> {
	let handle: ReturnType<typeof setTimeout>;
	const timer = new Promise<never>((_, reject) => {
		handle = setTimeout(() => reject(new Error("no change arrived")), timeoutMs);
		handle.unref?.();
	});
	const next = (async () => {
		while (true) {
			const event = await subscription.next();
			if (event.done) {
				throw new Error("subscription ended early");
			}
			if (event.value.type === "action") {
				const { action } = event.value.params;
				assert.equal(action.type, ActionType.ResourceWatchChanged);
				return action.changes.items;
			}
		}
	})();
	return Promise.race([next, timer]).finally(() => clearTimeout(handle));
}

async function nextMatchingChange(
	subscription: Subscription,
	matches: (change: ResourceChange) => boolean,
	timeoutMs = 4_000,
): Promise<ResourceChange> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const change = (await nextChanges(subscription, Math.max(1, deadline - Date.now()))).find(matches);
		if (change) {
			return change;
		}
		if (Date.now() >= deadline) {
			throw new Error("no matching change arrived");
		}
	}
}

async function expectChange(
	subscription: Subscription,
	path: string,
	type: ResourceChangeType,
): Promise<ResourceChange> {
	const expected = { uri: uri(path), type };
	const change = await nextMatchingChange(subscription, (item) => item.uri === expected.uri);
	assert.deepEqual(change, expected);
	return change;
}

async function collectChanges(
	subscription: Subscription,
	complete: (changes: readonly ResourceChange[]) => boolean,
	timeoutMs = 4_000,
): Promise<ResourceChange[]> {
	const changes: ResourceChange[] = [];
	const deadline = Date.now() + timeoutMs;
	while (!complete(changes)) {
		changes.push(...(await nextChanges(subscription, Math.max(1, deadline - Date.now()))));
	}
	return changes;
}

async function expectRpcError(promise: Promise<unknown>, code: number): Promise<RpcError> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	assert.ok(error instanceof RpcError);
	assert.equal(error.code, code);
	return error;
}

async function settle(ms: number): Promise<void> {
	await new Promise((resolve) => {
		const handle = setTimeout(resolve, ms);
		handle.unref?.();
	});
}

describe("resource watch", () => {
	let fixture: Fixture;

	// Keep native watcher callbacks from one case out of the next case's directory.
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
		const { subscription } = await fixture.client.subscribe(channel);

		const target = join(fixture.workspace, "created.txt");
		writeFileSync(target, "hi");
		const created = await expectChange(subscription, target, ResourceChangeType.Added);

		assert.equal(checkSchema("state", "ResourceChange", created), undefined);
	});

	it("classifies changes to existing paths as updated", async () => {
		const target = join(fixture.workspace, "existing.txt");
		writeFileSync(target, "before");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const { subscription } = await fixture.client.subscribe(channel);

		writeFileSync(target, "after");
		await expectChange(subscription, target, ResourceChangeType.Updated);
	});

	it("watches a single file at its actual URI", async () => {
		const target = join(fixture.workspace, "watched.txt");
		writeFileSync(target, "before");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(target) });
		const { subscription } = await fixture.client.subscribe(channel);

		const sibling = join(fixture.workspace, "sibling.txt");
		writeFileSync(sibling, "unrelated");
		await settle(EVENT_SETTLE_MS);
		writeFileSync(target, "after");
		const changes = await collectChanges(subscription, (items) => items.some((change) => change.uri === uri(target)));

		assert.deepEqual(changes, [{ uri: uri(target), type: ResourceChangeType.Updated }]);
	});

	it("reports deletion and recreation of the watched file", async () => {
		const target = join(fixture.workspace, "recreated.txt");
		writeFileSync(target, "before");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(target) });
		const { subscription } = await fixture.client.subscribe(channel);

		rmSync(target);
		await expectChange(subscription, target, ResourceChangeType.Deleted);

		writeFileSync(target, "after");
		await expectChange(subscription, target, ResourceChangeType.Added);
	});

	it("keeps a single-file watch attached across an atomic replacement", async () => {
		const target = join(fixture.workspace, "atomic.txt");
		const replacement = join(fixture.workspace, ".atomic.txt.tmp");
		writeFileSync(target, "before");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(target) });
		const { subscription } = await fixture.client.subscribe(channel);

		writeFileSync(replacement, "replacement");
		renameSync(replacement, target);
		await expectChange(subscription, target, ResourceChangeType.Updated);

		// Chokidar intentionally suppresses duplicate native change notifications
		// for a short interval; wait past that window before proving it reattached.
		await settle(EVENT_SETTLE_MS);
		writeFileSync(target, "after");
		await expectChange(subscription, target, ResourceChangeType.Updated);
	});

	it("keeps a directory watch attached across deletion and recreation", async () => {
		const target = join(fixture.workspace, "folder");
		mkdirSync(target);
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(target) });
		const { subscription } = await fixture.client.subscribe(channel);

		rmSync(target, { recursive: true });
		await expectChange(subscription, target, ResourceChangeType.Deleted);

		mkdirSync(target);
		await expectChange(subscription, target, ResourceChangeType.Added);

		const child = join(target, "child.txt");
		writeFileSync(child, "content");
		await expectChange(subscription, child, ResourceChangeType.Added);
	});

	it("reports both sides of a rename", async () => {
		const source = join(fixture.workspace, "before.txt");
		const destination = join(fixture.workspace, "after.txt");
		writeFileSync(source, "content");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const { subscription } = await fixture.client.subscribe(channel);

		renameSync(source, destination);
		const changes = await collectChanges(subscription, (items) => {
			const added = items.some((change) => change.uri === uri(destination) && change.type === ResourceChangeType.Added);
			const deleted = items.some((change) => change.uri === uri(source) && change.type === ResourceChangeType.Deleted);
			return added && deleted;
		});

		assert.deepEqual(
			changes
				.filter((change) => change.uri === uri(source) || change.uri === uri(destination))
				.sort((left, right) => left.uri.localeCompare(right.uri)),
			[
				{ uri: uri(destination), type: ResourceChangeType.Added },
				{ uri: uri(source), type: ResourceChangeType.Deleted },
			].sort((left, right) => left.uri.localeCompare(right.uri)),
		);
	});

	it("does not lose paths from a burst", async () => {
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const { subscription } = await fixture.client.subscribe(channel);
		const expected = Array.from({ length: 5 }, (_, index) => `burst-${index}.txt`);

		for (const name of expected) {
			writeFileSync(join(fixture.workspace, name), "x");
		}
		const seen = new Set<string>();
		const expectedUris = expected.map((name) => uri(join(fixture.workspace, name)));
		const deadline = Date.now() + 4_000;
		while (seen.size < expectedUris.length) {
			if (Date.now() >= deadline) {
				assert.fail(`missing burst paths: ${expectedUris.filter((path) => !seen.has(path)).join(", ")}`);
			}
			for (const change of await nextChanges(subscription, Math.max(1, deadline - Date.now()))) {
				if (expectedUris.includes(change.uri)) {
					assert.equal(change.type, ResourceChangeType.Added);
					seen.add(change.uri);
				}
			}
		}

		assert.deepEqual([...seen].sort(), expectedUris.sort());
	});

	it("limits non-recursive watches to direct children", async () => {
		const nested = join(fixture.workspace, "nested");
		mkdirSync(nested);
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const { subscription } = await fixture.client.subscribe(channel);

		const nestedTarget = join(nested, "deep.txt");
		writeFileSync(nestedTarget, "deep");
		await settle(EVENT_SETTLE_MS);

		const directTarget = join(fixture.workspace, "direct.txt");
		const collecting = collectChanges(subscription, (items) =>
			items.some((change) => change.uri === uri(directTarget)),
		);
		writeFileSync(directTarget, "direct");
		const changes = await collecting;
		assert.equal(
			changes.some((change) => change.uri === uri(nestedTarget)),
			false,
		);
		assert.deepEqual(
			changes.find((change) => change.uri === uri(directTarget)),
			{ uri: uri(directTarget), type: ResourceChangeType.Added },
		);
	});

	it("reports grandchildren for recursive watches", async () => {
		const nested = join(fixture.workspace, "nested");
		mkdirSync(nested);
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace), recursive: true });
		const { subscription } = await fixture.client.subscribe(channel);
		const nestedTarget = join(nested, "deep.txt");

		const observing = expectChange(subscription, nestedTarget, ResourceChangeType.Added);
		writeFileSync(nestedTarget, "deep");
		await observing;
	});

	it("honours exclude globs", async () => {
		const { channel } = await fixture.client.createResourceWatch({
			uri: uri(fixture.workspace),
			recursive: true,
			excludes: { items: ["**/node_modules/**"] },
		});
		const { subscription } = await fixture.client.subscribe(channel);

		const ignored = join(fixture.workspace, "node_modules", "ignored.txt");
		const noticed = join(fixture.workspace, "noticed.txt");
		mkdirSync(join(fixture.workspace, "node_modules"), { recursive: true });
		writeFileSync(ignored, "x");
		await settle(EVENT_SETTLE_MS);
		writeFileSync(noticed, "x");

		const changes = await collectChanges(subscription, (items) => items.some((change) => change.uri === uri(noticed)));
		// The directory entry itself may be reported; nothing inside it may.
		assert.equal(
			changes.some((change) => change.uri === uri(ignored)),
			false,
		);
		assert.deepEqual(
			changes.find((change) => change.uri === uri(noticed)),
			{ uri: uri(noticed), type: ResourceChangeType.Added },
		);
	});

	it("honours include globs", async () => {
		const { channel } = await fixture.client.createResourceWatch({
			uri: uri(fixture.workspace),
			recursive: true,
			includes: { items: ["**/*.md"] },
		});
		const { subscription } = await fixture.client.subscribe(channel);

		const skipped = join(fixture.workspace, "skipped.txt");
		const kept = join(fixture.workspace, "kept.md");
		writeFileSync(skipped, "x");
		await settle(EVENT_SETTLE_MS);
		writeFileSync(kept, "x");

		const changes = await collectChanges(subscription, (items) => items.some((change) => change.uri === uri(kept)));
		assert.deepEqual(changes, [{ uri: uri(kept), type: ResourceChangeType.Added }]);
	});

	it("rejects watching something that does not exist", async () => {
		await expectRpcError(fixture.client.createResourceWatch({ uri: uri(join(fixture.workspace, "absent")) }), -32008);
		assert.equal(fixture.watches.activeCount, 0);
	});

	it("rejects a recursive watch on a file", async () => {
		const target = join(fixture.workspace, "file.txt");
		writeFileSync(target, "content");

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
			const { subscription } = await fixture.client.subscribe(channel);

			writeFileSync(child, "after");
			await expectChange(subscription, join(link, "watched.txt"), ResourceChangeType.Updated);
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

			const escapedLink = join(fixture.workspace, "escape");
			symlinkSync(outside, escapedLink, "dir");
			await expectRpcError(fixture.client.createResourceWatch({ uri: uri(escapedLink) }), -32009);

			assert.equal(fixture.watches.activeCount, 1, "rejected requests must not allocate watchers");
		} finally {
			await fixture.close();
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("resource watch — lifetime", () => {
	it("releases a watch once its last subscriber goes away", async () => {
		const fixture = await startFixture({ graceMs: 120 });
		try {
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			await fixture.client.subscribe(channel);
			assert.equal(fixture.watches.activeCount, 1);

			await fixture.client.unsubscribe(channel);
			await settle(300);

			// There is no `disposeResourceWatch`: interest is the only signal.
			assert.equal(fixture.watches.activeCount, 0);
			assert.equal(fixture.host.store.has(channel), false);
		} finally {
			await fixture.close();
		}
	});

	it("waits for the last subscriber before scheduling release", async () => {
		const fixture = await startFixture({ graceMs: 120 });
		const other = await connectClient(fixture.server, "other-watch-client");
		try {
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			await fixture.client.subscribe(channel);
			await other.subscribe(channel);

			await fixture.client.unsubscribe(channel);
			await settle(300);
			assert.equal(fixture.watches.activeCount, 1);

			await other.unsubscribe(channel);
			await settle(300);
			assert.equal(fixture.watches.activeCount, 0);
			assert.equal(fixture.host.store.has(channel), false);
		} finally {
			await other.shutdown();
			await fixture.close();
		}
	});

	it("cancels deferred release when the channel is resubscribed", async () => {
		const fixture = await startFixture({ graceMs: 1_000 });
		try {
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			await fixture.client.subscribe(channel);
			await fixture.client.unsubscribe(channel);

			// Still alive mid-window — dropping it instantly would punish any
			// client whose socket blipped.
			await settle(200);
			assert.equal(fixture.watches.activeCount, 1);

			await fixture.client.subscribe(channel);
			await settle(1_200);
			assert.equal(fixture.watches.activeCount, 1, "resubscribing must cancel the release");
		} finally {
			await fixture.close();
		}
	});

	it("releases a watch when the client disconnects without unsubscribing", async () => {
		const fixture = await startFixture({ graceMs: 120 });
		try {
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			await fixture.client.subscribe(channel);

			await fixture.client.shutdown();
			await settle(400);

			assert.equal(fixture.watches.activeCount, 0);
		} finally {
			await fixture.close();
		}
	});

	it("releases a watch nobody ever subscribed to", async () => {
		const fixture = await startFixture({ graceMs: 120 });
		try {
			await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			// Opened and abandoned: without an initial grace timer this would
			// leak an OS watcher for the life of the process.
			await settle(400);
			assert.equal(fixture.watches.activeCount, 0);
		} finally {
			await fixture.close();
		}
	});

	it("disposes every watch and can be shut down twice", async () => {
		const fixture = await startFixture();
		try {
			const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
			await fixture.client.subscribe(channel);

			await fixture.watches.dispose();
			await fixture.watches.dispose();

			assert.equal(fixture.watches.activeCount, 0);
			assert.equal(fixture.host.store.has(channel), false);
		} finally {
			await fixture.close();
		}
	});
});
