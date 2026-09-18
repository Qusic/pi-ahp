/** Deterministic concurrency and watcher lifecycle tests for Git changesets. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { ChangesetService, type ChangesetSession, type ChangesetWatchFactory } from "../src/pi/changeset-service.ts";
import { piChangesetUri } from "../src/pi/changeset-uri.ts";
import type { GitBlobRef, GitChangesBackend, GitWorkspace } from "../src/pi/git-changes.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { eventually } from "./support/async.ts";

class ControlledWatcher extends EventEmitter {
	async close(): Promise<void> {}

	change(path: string): void {
		this.emit("change", path);
	}
}

class ControlledWatchFactory {
	readonly watchers: ControlledWatcher[] = [];
	readonly create: ChangesetWatchFactory = () => {
		const watcher = new ControlledWatcher();
		this.watchers.push(watcher);
		queueMicrotask(() => watcher.emit("ready"));
		return watcher as unknown as ReturnType<ChangesetWatchFactory>;
	};

	get current(): ControlledWatcher {
		const watcher = this.watchers.at(-1);
		if (!watcher) throw new Error("watcher was not created");
		return watcher;
	}
}

class ControlledGit implements GitChangesBackend {
	readonly computeStarted = Promise.withResolvers<void>();
	readonly computeGate = Promise.withResolvers<void>();
	readonly workspace: GitWorkspace;
	computeCalls = 0;
	ignoredCalls = 0;
	failCompute = false;
	failIgnored = false;
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

	async ignoredDirectories(): Promise<string[]> {
		this.ignoredCalls += 1;
		if (this.failIgnored) throw new Error("ignored paths unavailable");
		return [];
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
	readonly git: ControlledGit;
	readonly watches: ControlledWatchFactory;
	readonly session: ChangesetSession;
	readonly chat: string;
	readonly channel: string;
	readonly workspace: string;
	close(): Promise<void>;
}

async function startControlledFixture(
	options: { failCompute?: boolean; failIgnored?: boolean; blockFirstCompute?: boolean } = {},
): Promise<ControlledFixture> {
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-changeset-controlled-"));
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
	git.failIgnored = options.failIgnored ?? false;
	git.blockFirstCompute = options.blockFirstCompute ?? true;
	const logs: string[] = [];
	const watches = new ControlledWatchFactory();
	const service = new ChangesetService(host, {
		getSession: (sessionId) => (sessionId === id ? session : undefined),
		getSessionByChat: (chat) => (chat === chatChannel ? session : undefined),
		hydrateSession: async (sessionId) => (sessionId === id ? session : undefined),
		git,
		watchFactory: watches.create,
		debounceMs: 5,
		log: (message) => logs.push(message),
	});
	await service.attach(session);
	host.serve({ hydrator: service });
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
		git,
		watches,
		session,
		chat: chatChannel,
		channel,
		workspace,
		async close() {
			git.computeGate.resolve();
			await client.shutdown();
			await server.close();
			await service.dispose();
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}

it("observes changes during the initial scan and rebuilds changed ignore rules", async () => {
	const fixture = await startControlledFixture();
	try {
		await fixture.client.subscribe(fixture.channel);
		await fixture.git.computeStarted.promise;
		fixture.watches.current.change(join(fixture.workspace, ".gitignore"));
		fixture.git.computeGate.resolve();

		await eventually("a follow-up changeset scan", () => fixture.git.computeCalls >= 2, {
			describe: () => ({ computes: fixture.git.computeCalls, ignoredReads: fixture.git.ignoredCalls }),
		});
		await eventually("the rebuilt watcher", () => fixture.git.ignoredCalls >= 2);
		const state = fixture.host.store.get(fixture.channel) as ChangesetState;
		assert.equal(state.status, ChangesetStatus.Ready);
		assert.equal(state.files[0]?.edit.diff?.added, 2);
	} finally {
		await fixture.close();
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
		fixture.watches.current.change(join(fixture.workspace, "during-turn.ts"));

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

it("does not recursively watch when ignored paths cannot be determined", async () => {
	const fixture = await startControlledFixture({ failIgnored: true, blockFirstCompute: false });
	try {
		await fixture.client.subscribe(fixture.channel);
		await eventually(
			"the one-shot changeset scan",
			() => (fixture.host.store.get(fixture.channel) as ChangesetState | undefined)?.status === ChangesetStatus.Ready,
		);
		assert.ok(fixture.git.ignoredCalls > 0);
		assert.equal(fixture.watches.watchers.length, 0);
		assert.equal(fixture.service.activeWatcherCount, 0);
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
