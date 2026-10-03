/** Synthetic Pi history plus a real AHP host; no agent or user profile is involved. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import type { Subscription, SubscriptionEvent } from "@microsoft/agent-host-protocol/client";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../../src/core/channels.ts";
import type { SessionFileDeletionResult } from "../../src/pi/session-registry.ts";
import { type Harness, nextClientId, startHarness } from "../harness.ts";
import { must } from "./assertions.ts";
import { writeSessionFixture } from "./session-files.ts";

export async function withArchiveTimeout<Value>(promise: Promise<Value>, label: string): Promise<Value> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
				timer.unref();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function nextArchiveEvent(subscription: Subscription): Promise<SubscriptionEvent> {
	const result = await withArchiveTimeout(subscription.next(), "an archive event");
	assert.equal(result.done, false, "subscription must remain open");
	return result.value;
}

export async function archiveSessionFixture(
	t: TestContext,
	options: {
		loaded?: boolean;
		deleteFile?: (path: string) => SessionFileDeletionResult | Promise<SessionFileDeletionResult>;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-archive-action-"));
	const workspace = join(root, "workspace");
	const sessionRoot = join(root, "sessions");
	let harness: Harness | undefined;
	t.after(async () => {
		try {
			await harness?.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	mkdirSync(workspace);
	const id = randomUUID();
	const file = writeSessionFixture(sessionRoot, id, workspace);
	const timestamp = new Date("2025-06-01T12:00:00.000Z");
	utimesSync(file, timestamp, timestamp);
	const history = readFileSync(file);
	const createBackend = t.mock.fn(() => {
		throw new Error("archiving must not start an agent");
	});
	const hostOptions = {
		sessions: true,
		sessionRoot,
		workingDirectory: workspace,
		createBackend,
		deleteFile:
			options.deleteFile ??
			((path: string) => {
				rmSync(path, { force: true });
				return { ok: true };
			}),
	};
	harness = await startHarness(hostOptions);
	const metadata = must(harness.metadata);
	const catalogue = must(harness.catalogue);
	const sessions = must(harness.sessions);
	const client = await harness.connect();
	const observer = await harness.connect();
	const clientId = nextClientId();
	await client.initialize({
		clientId,
		protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
		initialSubscriptions: [ROOT_CHANNEL],
	});
	await observer.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	const session = sessionUri(id);
	const chat = chatUri(id);
	if (options.loaded !== false) await Promise.all([client.subscribe(session), observer.subscribe(session)]);
	const initialHost = harness.host;
	return {
		id,
		file,
		history,
		timestamp,
		metadata,
		catalogue,
		sessions,
		client,
		observer,
		clientId,
		session,
		chat,
		sessionRoot,
		workspace,
		initialHost,
		createBackend,
		connect: () => must(harness).connect(),
		async settle(targetId = id) {
			// Ping confirms receipt, then the queue marker waits for the whole routed operation.
			await client.ping();
			await sessions.operations.run(targetId, () => undefined);
		},
		async restart() {
			await harness?.dispose();
			harness = undefined;
			harness = await startHarness(hostOptions);
			const fresh = await harness.connect();
			await fresh.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
			return fresh;
		},
	};
}
