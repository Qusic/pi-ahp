/** Deterministic concurrency and watcher lifecycle tests for Git changesets. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	ActionType,
	type ChangesetFile,
	type ChangesetState,
	ChangesetStatus,
	type ChatState,
	MessageKind,
	ResourceChangeType,
	SessionLifecycle,
	type SessionState,
	SessionStatus,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { initialChatState } from "../src/channels/chat.ts";
import { installRootChannel } from "../src/channels/root.ts";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import { ChangesetService, type ChangesetSession } from "../src/pi/changeset-service.ts";
import { piChangesetUri } from "../src/pi/changeset-uri.ts";
import { type ChokidarWatchFactory, openChokidarWatchTargets } from "../src/pi/chokidar-watch-source.ts";
import type { GitBlobRef, GitChangesBackend, GitWorkspace } from "../src/pi/git-changes.ts";
import { ParcelWatchPool } from "../src/pi/parcel-watch-pool.ts";
import { ResourceWatchService } from "../src/pi/resource-watch.ts";
import type { FileWatchChangeKind, FileWatchSource } from "../src/pi/watch-source.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { eventually } from "./support/async.ts";
import { WatchEvents } from "./support/watch-events.ts";

class ControlledWatcher extends EventEmitter {
	closes = 0;
	async close(): Promise<void> {
		this.closes++;
	}

	change(path: string): void {
		this.emit("change", path);
	}
}

class ControlledWatchFactory {
	readonly watchers: ControlledWatcher[] = [];
	readonly beforeReady: string[] = [];
	readonly create: ChokidarWatchFactory = () => {
		const watcher = new ControlledWatcher();
		this.watchers.push(watcher);
		queueMicrotask(() => {
			for (const path of this.beforeReady) watcher.change(path);
			watcher.emit("ready");
		});
		return watcher as unknown as ReturnType<ChokidarWatchFactory>;
	};

	get current(): ControlledWatcher {
		const watcher = this.watchers.at(-1);
		if (!watcher) throw new Error("watcher was not created");
		return watcher;
	}
}

class ControlledRecursiveSource implements FileWatchSource {
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
	change(path: string, kind: FileWatchChangeKind = "updated"): void {
		this.#change?.(path, kind);
	}
	fail(error: Error): void {
		this.#error?.(error);
	}
}

class ControlledRecursivePool {
	readonly sources: ControlledRecursiveSource[] = [];
	readonly openStarted = Promise.withResolvers<void>();
	openGate: Promise<void> | undefined;
	failOpen = false;
	readonly pool = new ParcelWatchPool(async () => {
		this.openStarted.resolve();
		if (this.openGate) await this.openGate;
		if (this.failOpen) throw new Error("native subscription unavailable");
		const source = new ControlledRecursiveSource();
		this.sources.push(source);
		return source;
	});

	get current(): ControlledRecursiveSource {
		const source = this.sources.at(-1);
		if (!source) throw new Error("recursive source was not created");
		return source;
	}
}

class ControlledGit implements GitChangesBackend {
	readonly computeStarted = Promise.withResolvers<void>();
	readonly computeGate = Promise.withResolvers<void>();
	readonly workspace: GitWorkspace;
	computeCalls = 0;
	failCompute = false;
	blockFirstCompute = true;

	constructor(workspace: GitWorkspace) {
		this.workspace = workspace;
	}

	async inspect(): Promise<GitWorkspace> {
		return this.workspace;
	}

	async compute(
		_workspace: GitWorkspace,
		_sessionId: string,
		_kind: "latest-commit" | "uncommitted",
		signal?: AbortSignal,
	): Promise<ChangesetFile[]> {
		this.computeCalls += 1;
		if (this.failCompute) throw new Error("Git diff failed");
		const version = this.computeCalls;
		if (version === 1 && this.blockFirstCompute) {
			this.computeStarted.resolve();
			await new Promise<void>((resolve, reject) => {
				const aborted = (): void => reject(signal?.reason ?? new Error("aborted"));
				signal?.addEventListener("abort", aborted, { once: true });
				void this.computeGate.promise
					.then(resolve, reject)
					.finally(() => signal?.removeEventListener("abort", aborted));
			});
		}
		const uri = pathToFileURL(join(this.workspace.cwd, "result.txt")).toString();
		return [{ id: uri, edit: { after: { uri, content: { uri } }, diff: { added: version, removed: 0 } } }];
	}

	pathForBlob(): string | undefined {
		return undefined;
	}

	async readBlob(_workspace: GitWorkspace, _blob: GitBlobRef): Promise<Buffer> {
		throw new Error("not used");
	}
}

interface ControlledFixture {
	readonly host: AhpHost;
	readonly client: AhpClient;
	readonly server: RunningServer;
	readonly service: ChangesetService;
	readonly resourceWatches: ResourceWatchService;
	readonly git: ControlledGit;
	readonly watches: ControlledWatchFactory;
	readonly recursive: ControlledRecursivePool;
	readonly logs: string[];
	readonly session: ChangesetSession;
	readonly chat: string;
	readonly channel: string;
	readonly workspace: string;
	close(): Promise<void>;
}

async function startControlledFixture(
	options: { failCompute?: boolean; blockFirstCompute?: boolean } = {},
): Promise<ControlledFixture> {
	// Production Git inspection and AHP resource watches both use canonical roots.
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "pi-ahp-changeset-controlled-")));
	const gitDirectory = join(workspace, ".git");
	mkdirSync(join(gitDirectory, "refs", "heads"), { recursive: true });
	mkdirSync(join(gitDirectory, "info"), { recursive: true });
	writeFileSync(join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(gitDirectory, "index"), "");
	writeFileSync(join(gitDirectory, "info", "exclude"), "");

	const id = randomUUID();
	const sessionChannel = sessionUri(id);
	const chatChannel = chatUri(id);
	const session: ChangesetSession = { uri: sessionChannel, sessionId: id, workingDirectory: workspace };
	const host = new AhpHost();
	installRootChannel(host, []);
	const sessionState: SessionState = {
		provider: "pi",
		title: "Controlled",
		status: SessionStatus.Idle,
		lifecycle: SessionLifecycle.Ready,
		workingDirectories: [pathToFileURL(workspace).toString()],
		activeClients: [],
		chats: [],
	};
	host.store.create(sessionChannel, sessionState, "session");
	host.store.create(chatChannel, initialChatState(chatChannel, "Controlled"), "chat");
	const git = new ControlledGit({
		cwd: workspace,
		repositoryRoot: workspace,
		gitDirectory,
		commonGitDirectory: gitDirectory,
		pathspec: ".",
		head: "a".repeat(40),
		parent: "b".repeat(40),
	});
	git.failCompute = options.failCompute ?? false;
	git.blockFirstCompute = options.blockFirstCompute ?? true;
	const logs: string[] = [];
	const watches = new ControlledWatchFactory();
	const recursive = new ControlledRecursivePool();
	const resourceWatches = new ResourceWatchService(host, { parcelPool: recursive.pool, debounceMs: 5 });
	const service = new ChangesetService(host, {
		getSession: (sessionId) => (sessionId === id ? session : undefined),
		getSessionByChat: (chat) => (chat === chatChannel ? session : undefined),
		hydrateSession: async (sessionId) => (sessionId === id ? session : undefined),
		git,
		parcelPool: recursive.pool,
		metadataWatchFactory: watches.create,
		debounceMs: 5,
		log: (message) => logs.push(message),
	});
	await service.attach(session);
	host.serve({ hydrator: service, resourceWatches });
	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	await client.initialize({ clientId: `controlled-${id}`, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	const channel = piChangesetUri(id, "uncommitted");
	return {
		host,
		client,
		server,
		service,
		resourceWatches,
		git,
		watches,
		recursive,
		logs,
		session,
		chat: chatChannel,
		channel,
		workspace,
		async close() {
			git.computeGate.resolve();
			await client.shutdown();
			await server.close();
			await Promise.all([service.dispose(), resourceWatches.dispose()]);
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}

it("observes changed ignore rules during a scan without rebuilding the watcher", async () => {
	const fixture = await startControlledFixture();
	try {
		await fixture.client.subscribe(fixture.channel);
		await fixture.git.computeStarted.promise;
		fixture.recursive.current.change(join(fixture.workspace, ".gitignore"));
		fixture.git.computeGate.resolve();

		await eventually("a follow-up changeset scan", () => {
			const state = fixture.host.store.get(fixture.channel) as ChangesetState | undefined;
			return (
				fixture.git.computeCalls >= 2 &&
				state?.status === ChangesetStatus.Ready &&
				state.files[0]?.edit.diff?.added === 2
			);
		});
		assert.equal(fixture.recursive.sources.length, 1);
		assert.equal(fixture.watches.watchers.length, 1);
	} finally {
		await fixture.close();
	}
});

it("replays a Git metadata change delivered before the Chokidar ready boundary", async () => {
	const fixture = await startControlledFixture();
	fixture.watches.beforeReady.push(join(fixture.git.workspace.gitDirectory, "HEAD"));
	try {
		await fixture.client.subscribe(fixture.channel);
		await fixture.git.computeStarted.promise;
		fixture.git.computeGate.resolve();
		await eventually("the follow-up scan", () => {
			const state = fixture.host.store.get(fixture.channel) as ChangesetState | undefined;
			return (
				fixture.git.computeCalls >= 2 &&
				state?.status === ChangesetStatus.Ready &&
				state.files[0]?.edit.diff?.added === 2
			);
		});
		assert.equal(fixture.watches.watchers.length, 1);
	} finally {
		await fixture.close();
	}
});

it("retains Chokidar changes and errors until the ready source has listeners", async () => {
	const watcher = new ControlledWatcher();
	const path = join("/metadata", "HEAD");
	const source = await openChokidarWatchTargets({ targets: [path], ignored: () => false }, () => {
		queueMicrotask(() => watcher.emit("ready"));
		return watcher as unknown as ReturnType<ChokidarWatchFactory>;
	});
	try {
		const error = new Error("watch failed after ready");
		watcher.change(path);
		watcher.emit("error", error);
		const changes: { path: string; kind: FileWatchChangeKind }[] = [];
		const errors: unknown[] = [];
		source.onChange((changedPath, kind) => changes.push({ path: changedPath, kind }));
		source.onError((cause) => errors.push(cause));
		await Promise.resolve();
		assert.deepEqual(changes, [{ path, kind: "updated" }]);
		assert.deepEqual(errors, [error]);
	} finally {
		await source.close();
	}
});

it("refreshes file changes while a turn is still active", async () => {
	const fixture = await startControlledFixture({ blockFirstCompute: false });
	try {
		await fixture.client.subscribe(fixture.channel);
		await eventually(
			"the initial changeset",
			() => (fixture.host.store.get(fixture.channel) as ChangesetState | undefined)?.status === ChangesetStatus.Ready,
		);
		const initialComputes = fixture.git.computeCalls;
		fixture.host.dispatchServerAction(fixture.chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "active-turn",
			startedAt: new Date().toISOString(),
			message: { text: "Keep working", origin: { kind: MessageKind.User } },
		});
		fixture.recursive.current.change(join(fixture.workspace, "during-turn.ts"));

		await eventually("a changeset refresh before turn completion", () => {
			const state = fixture.host.store.get(fixture.channel) as ChangesetState | undefined;
			return (
				fixture.git.computeCalls > initialComputes &&
				state?.status === ChangesetStatus.Ready &&
				(state.files[0]?.edit.diff?.added ?? 0) > initialComputes
			);
		});
		assert.equal((fixture.host.store.get(fixture.chat) as ChatState).activeTurn?.id, "active-turn");
	} finally {
		await fixture.close();
	}
});

it("shares a recursive source with resource watches without sharing their lifetimes", async () => {
	const fixture = await startControlledFixture({ blockFirstCompute: false });
	let events: WatchEvents | undefined;
	try {
		const { channel } = await fixture.client.createResourceWatch({
			uri: pathToFileURL(fixture.workspace).toString(),
			recursive: true,
		});
		const { subscription } = await fixture.client.subscribe(channel);
		events = new WatchEvents(subscription);
		await fixture.client.subscribe(fixture.channel);
		await eventually("the initial changeset", () => {
			const state = fixture.host.store.get(fixture.channel) as ChangesetState | undefined;
			return fixture.service.activeWatcherCount === 1 && state?.status === ChangesetStatus.Ready;
		});
		assert.equal(fixture.recursive.sources.length, 1);

		const first = join(fixture.workspace, "one.txt");
		const initialVersion = fixture.git.computeCalls;
		fixture.recursive.current.change(first, "added");
		await events.waitFor("the resource event", (changes) =>
			changes.some(
				(change) => change.uri === pathToFileURL(first).toString() && change.type === ResourceChangeType.Added,
			),
		);
		await eventually("the Git refresh", () => {
			const state = fixture.host.store.get(fixture.channel) as ChangesetState | undefined;
			return state?.status === ChangesetStatus.Ready && (state.files[0]?.edit.diff?.added ?? 0) > initialVersion;
		});

		await fixture.client.unsubscribe(fixture.channel);
		await eventually("the Git watcher to close", () => fixture.watches.current.closes === 1);
		assert.equal(fixture.service.activeWatcherCount, 0);
		assert.equal(fixture.recursive.current.closes, 0);

		const second = join(fixture.workspace, "two.txt");
		const since = events.mark();
		fixture.recursive.current.change(second, "added");
		await events.waitFor(
			"the remaining resource watch",
			(changes) =>
				changes.some(
					(change) => change.uri === pathToFileURL(second).toString() && change.type === ResourceChangeType.Added,
				),
			since,
		);
	} finally {
		try {
			await events?.close();
		} finally {
			await fixture.close();
		}
	}
});

it("closes both handles on native failure and can reopen after renewed interest", async () => {
	const fixture = await startControlledFixture({ blockFirstCompute: false });
	try {
		await fixture.client.subscribe(fixture.channel);
		await eventually("the initial changeset", () => {
			const state = fixture.host.store.get(fixture.channel) as ChangesetState | undefined;
			return fixture.service.activeWatcherCount === 1 && state?.status === ChangesetStatus.Ready;
		});
		const beforeFailure = fixture.git.computeCalls;
		const failed = fixture.recursive.current;
		failed.fail(new Error("native failure"));
		await eventually("both handles to close", () => failed.closes === 1 && fixture.watches.current.closes === 1);
		assert.equal(fixture.service.activeWatcherCount, 0);
		await fixture.client.unsubscribe(fixture.channel);
		await fixture.client.subscribe(fixture.channel);
		await eventually("the reopened changeset", () => {
			const state = fixture.host.store.get(fixture.channel) as ChangesetState | undefined;
			return (
				fixture.recursive.sources.length === 2 &&
				fixture.service.activeWatcherCount === 1 &&
				state?.status === ChangesetStatus.Ready &&
				(state.files[0]?.edit.diff?.added ?? 0) > beforeFailure
			);
		});
		const beforeChange = fixture.git.computeCalls;
		fixture.recursive.current.change(join(fixture.workspace, "after-reopen.txt"));
		await eventually("a live refresh after reopening", () => {
			const state = fixture.host.store.get(fixture.channel) as ChangesetState | undefined;
			return state?.status === ChangesetStatus.Ready && state.files[0]?.edit.diff?.added === beforeChange + 1;
		});
	} finally {
		await fixture.close();
	}
});

it("releases the recursive handle when the narrow metadata watcher fails", async () => {
	const fixture = await startControlledFixture({ blockFirstCompute: false });
	try {
		await fixture.client.subscribe(fixture.channel);
		await eventually("the initial watcher", () => fixture.service.activeWatcherCount === 1);
		const recursive = fixture.recursive.current;
		const metadata = fixture.watches.current;
		metadata.emit("error", new Error("metadata failure"));
		await eventually("both handles to close", () => recursive.closes === 1 && metadata.closes === 1);
		assert.equal(fixture.service.activeWatcherCount, 0);
		assert.ok(fixture.logs.some((message) => message.includes("metadata failure")));
	} finally {
		await fixture.close();
	}
});

it("keeps the one-shot changeset when the recursive source cannot start", async () => {
	const fixture = await startControlledFixture({ blockFirstCompute: false });
	fixture.recursive.failOpen = true;
	try {
		await fixture.client.subscribe(fixture.channel);
		await eventually(
			"the one-shot changeset",
			() => (fixture.host.store.get(fixture.channel) as ChangesetState | undefined)?.status === ChangesetStatus.Ready,
		);
		assert.equal(fixture.service.activeWatcherCount, 0);
		assert.equal(fixture.recursive.sources.length, 0);
		assert.equal(fixture.watches.current.closes, 1);
		assert.ok(fixture.logs.some((message) => message.includes("native subscription unavailable")));
	} finally {
		await fixture.close();
	}
});

it("publishes an explicit error when Git cannot compute the changeset", async () => {
	const fixture = await startControlledFixture({ failCompute: true, blockFirstCompute: false });
	try {
		await fixture.client.subscribe(fixture.channel);
		await eventually("the failed changeset", () => {
			return (fixture.host.store.get(fixture.channel) as ChangesetState | undefined)?.status === ChangesetStatus.Error;
		});
		const state = fixture.host.store.get(fixture.channel) as ChangesetState;
		assert.equal(state.error?.errorType, "gitChangesFailed");
		assert.equal(state.error?.message, "Git diff failed");
	} finally {
		await fixture.close();
	}
});

it("drains a blocked recursive startup before deleting its channel", { timeout: 10_000 }, async () => {
	const fixture = await startControlledFixture();
	const gate = Promise.withResolvers<void>();
	fixture.recursive.openGate = gate.promise;
	let deletion: Promise<void> | undefined;
	try {
		await fixture.client.subscribe(fixture.channel);
		await fixture.recursive.openStarted.promise;
		assert.equal(fixture.recursive.sources.length, 0);
		assert.equal(fixture.watches.watchers.length, 1);

		deletion = fixture.service.removeSession(fixture.session.sessionId);
		let settled = false;
		const markSettled = (): void => {
			settled = true;
		};
		void deletion.then(markSettled, markSettled);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(settled, false, "session deletion must await the blocked source");

		gate.resolve();
		await deletion;
		assert.equal(fixture.recursive.sources.length, 1);
		assert.equal(fixture.recursive.current.closes, 1);
		assert.equal(fixture.watches.current.closes, 1);
		assert.equal(fixture.service.activeWatcherCount, 0);
		assert.equal(fixture.host.store.has(fixture.channel), false);
		assert.equal(fixture.git.computeCalls, 0);
	} finally {
		gate.resolve();
		try {
			await deletion?.catch(() => undefined);
		} finally {
			await fixture.close();
		}
	}
});

it("drains an in-flight scan before deleting its channel", async () => {
	const fixture = await startControlledFixture();
	try {
		await fixture.client.subscribe(fixture.channel);
		await fixture.git.computeStarted.promise;
		await fixture.service.removeSession(fixture.session.sessionId);
		assert.equal(fixture.host.store.has(fixture.channel), false);
		fixture.git.computeGate.resolve();
		await Promise.resolve();
		assert.equal(fixture.host.store.has(fixture.channel), false);
	} finally {
		await fixture.close();
	}
});
