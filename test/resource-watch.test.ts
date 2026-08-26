/**
 * Filesystem watches.
 *
 * The interesting behaviour is lifetime: the protocol gives a watch no dispose
 * command, so the host has to reclaim an OS resource purely from subscription
 * signals — while still surviving the gap where a client drops and reconnects.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/resource-watch-channel
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	type ResourceChange,
	ResourceChangeType,
	type ResourceWatchState,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError, type Subscription } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { AhpHost } from "../src/core/host.ts";
import { ResourceWatchService } from "../src/pi/resource-watch.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { checkSchema } from "./support/schema.ts";

const uri = (path: string): string => pathToFileURL(path).toString();

interface Fixture {
	host: AhpHost;
	watches: ResourceWatchService;
	client: AhpClient;
	server: RunningServer;
	workspace: string;
	close(): Promise<void>;
}

async function startFixture(options: { graceMs?: number } = {}): Promise<Fixture> {
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-watch-"));
	const host = new AhpHost();
	installRootChannel(host, []);
	const watches = new ResourceWatchService(host, {
		// Short windows keep the lifetime tests honest without making them slow.
		graceMs: options.graceMs ?? 200,
		debounceMs: 20,
	});
	host.serve({ resourceWatches: watches });

	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	await client.initialize({ clientId: "watch-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

	return {
		host,
		watches,
		client,
		server,
		workspace,
		async close() {
			watches.dispose();
			await client.shutdown();
			await server.close();
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}

/** Collects the next batch of changes, failing fast on a stall. */
async function nextChanges(subscription: Subscription, timeoutMs = 4_000): Promise<ResourceChange[]> {
	const timer = new Promise<never>((_, reject) => {
		const handle = setTimeout(() => reject(new Error("no change arrived")), timeoutMs);
		handle.unref?.();
	});
	const next = (async () => {
		while (true) {
			const event = await subscription.next();
			if (event.done) {
				throw new Error("subscription ended early");
			}
			if (event.value.type === "action") {
				return (event.value.params.action as { changes: { items: ResourceChange[] } }).changes.items;
			}
		}
	})();
	return Promise.race([next, timer]);
}

/** Drains every batch that arrives within a window. */
async function collectBatches(subscription: Subscription, windowMs: number): Promise<ResourceChange[][]> {
	const batches: ResourceChange[][] = [];
	const deadline = Date.now() + windowMs;
	while (Date.now() < deadline) {
		const batch = await nextChanges(subscription, Math.max(1, deadline - Date.now())).catch(() => undefined);
		if (!batch) {
			break;
		}
		batches.push(batch);
	}
	return batches;
}

async function collectChanges(subscription: Subscription, windowMs: number): Promise<ResourceChange[]> {
	return (await collectBatches(subscription, windowMs)).flat();
}

async function settle(ms: number): Promise<void> {
	await new Promise((resolve) => {
		const handle = setTimeout(resolve, ms);
		handle.unref?.();
	});
}

describe("resource watch", () => {
	let fixture: Fixture;

	// Per test, not per suite: these share one directory, and a watch opened by
	// the next test sees whatever the previous one was still writing.
	beforeEach(async () => {
		fixture = await startFixture();
	});

	afterEach(async () => {
		await fixture.close();
	});

	it("returns a watch channel whose state describes what is watched", async () => {
		const result = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace), recursive: true });

		assert.match(result.channel, /^ahp-resource-watch:\//);
		const { result: subscribed } = await fixture.client.subscribe(result.channel);
		const state = subscribed.snapshot?.state as ResourceWatchState;
		assert.equal(state.root, uri(fixture.workspace));
		assert.equal(state.recursive, true);
		assert.equal(checkSchema("state", "ResourceWatchState", state), undefined);
	});

	it("reports a created file as a change", async () => {
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const { subscription } = await fixture.client.subscribe(channel);

		writeFileSync(join(fixture.workspace, "created.txt"), "hi");
		const changes = await collectChanges(subscription, 100);

		const created = changes.find((change) => change.uri.endsWith("created.txt"));
		assert.ok(created);
		assert.equal(checkSchema("state", "ResourceChange", created), undefined);
	});

	it("keeps reporting after its first action", async () => {
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const { subscription } = await fixture.client.subscribe(channel);

		writeFileSync(join(fixture.workspace, "first.txt"), "1");
		const first = await collectChanges(subscription, 100);
		writeFileSync(join(fixture.workspace, "second.txt"), "2");
		const second = await collectChanges(subscription, 100);

		assert.ok(first.some((change) => change.uri.endsWith("first.txt")));
		assert.ok(second.some((change) => change.uri.endsWith("second.txt")));
	});

	it("classifies a removed path as deleted", async () => {
		const target = join(fixture.workspace, "doomed.txt");
		writeFileSync(target, "x");
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const { subscription } = await fixture.client.subscribe(channel);

		rmSync(target);
		// `fs.watch` only says "rename" or "change", so the type comes from
		// stat-ing at flush time.
		const changes = await collectChanges(subscription, 100);
		assert.ok(
			changes.some((change) => change.uri.endsWith("doomed.txt") && change.type === ResourceChangeType.Deleted),
		);
	});

	it("batches a burst into one action", async () => {
		const { channel } = await fixture.client.createResourceWatch({ uri: uri(fixture.workspace) });
		const { subscription } = await fixture.client.subscribe(channel);

		for (let i = 0; i < 5; i++) {
			writeFileSync(join(fixture.workspace, `burst-${i}.txt`), "x");
		}
		const batches = await collectBatches(subscription, 100);

		assert.ok(
			batches.some((batch) => batch.filter((change) => change.uri.includes("burst-")).length >= 2),
			"expected at least two burst files in one action",
		);
	});

	it("honours exclude globs", async () => {
		const { channel } = await fixture.client.createResourceWatch({
			uri: uri(fixture.workspace),
			recursive: true,
			excludes: { items: ["**/node_modules/**"] },
		});
		const { subscription } = await fixture.client.subscribe(channel);

		mkdirSync(join(fixture.workspace, "node_modules"), { recursive: true });
		writeFileSync(join(fixture.workspace, "node_modules", "ignored.txt"), "x");
		writeFileSync(join(fixture.workspace, "noticed.txt"), "x");

		const changes = await collectChanges(subscription, 400);

		assert.ok(changes.some((change) => change.uri.endsWith("noticed.txt")));
		// `**/node_modules/**` matches paths *inside* the directory, not the
		// directory entry itself. Reporting that the folder appeared is useful
		// and leaks nothing; its contents stay excluded.
		assert.equal(
			changes.some((change) => change.uri.includes("/node_modules/")),
			false,
			"nothing inside an excluded directory may be reported",
		);
	});

	it("honours include globs", async () => {
		const { channel } = await fixture.client.createResourceWatch({
			uri: uri(fixture.workspace),
			recursive: true,
			includes: { items: ["**/*.md"] },
		});
		const { subscription } = await fixture.client.subscribe(channel);

		writeFileSync(join(fixture.workspace, "skipped.txt"), "x");
		writeFileSync(join(fixture.workspace, "kept.md"), "x");

		const changes = await collectChanges(subscription, 400);
		assert.ok(changes.length > 0, "expected the included file to be reported");
		assert.ok(changes.every((change) => change.uri.endsWith(".md")));
	});

	it("rejects watching something that does not exist", async () => {
		const error = await fixture.client.createResourceWatch({ uri: uri(join(fixture.workspace, "absent")) }).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32008);
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

	it("survives the grace window so a reconnect keeps its watch", async () => {
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
});
