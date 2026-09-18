/** Static Git changesets over the complete AHP subscribe/resourceRead path. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	AhpErrorCodes,
	type ChangesetState,
	ChangesetStatus,
	ContentEncoding,
	JsonRpcErrorCodes,
	type SessionState,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { sessionUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import { createPiHost, type PiHost } from "../src/host/pi-host.ts";
import { ChangesetService } from "../src/pi/changeset-service.ts";
import { piChangesetUri } from "../src/pi/changeset-uri.ts";
import { GitChanges } from "../src/pi/git-changes.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { SessionHydrator } from "../src/pi/session-hydrator.ts";
import { SessionRegistry } from "../src/pi/session-registry.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { expectRpcError, must } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";
import { startHydratedSessionFixture } from "./support/hydrated-session.ts";
import { assertValid } from "./support/schema.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fileName(file: ChangesetState["files"][number]): string {
	return basename(decodeURIComponent(new URL(file.edit.after?.uri ?? file.edit.before?.uri ?? "").pathname));
}

async function readyState(client: AhpClient, host: AhpHost, channel: string): Promise<ChangesetState> {
	await eventually(`${channel} to become ready`, () => {
		return (host.store.get(channel) as ChangesetState | undefined)?.status === ChangesetStatus.Ready;
	});
	const { result } = await client.subscribe(channel);
	const state = must(result.snapshot, `${channel} snapshot`).state as ChangesetState;
	assertValid("state", "ChangesetState", state);
	return state;
}

describe("Git changesets", () => {
	let workspace: string;
	let built: PiHost;
	let server: RunningServer;
	let client: AhpClient;

	before(async () => {
		workspace = mkdtempSync(join(tmpdir(), "pi-ahp-changeset-"));
		git(workspace, "init", "-q");
		git(workspace, "config", "user.email", "test@example.com");
		git(workspace, "config", "user.name", "pi-ahp test");
		writeFileSync(join(workspace, "edited.txt"), "base\n");
		writeFileSync(join(workspace, "deleted.txt"), "deleted\n");
		writeFileSync(join(workspace, "old-name.txt"), "renamed\n");
		writeFileSync(join(workspace, "tab\tname.txt"), "tab base\n");
		git(workspace, "add", ".");
		git(workspace, "commit", "-qm", "base");

		appendFileSync(join(workspace, "edited.txt"), "committed\n");
		unlinkSync(join(workspace, "deleted.txt"));
		renameSync(join(workspace, "old-name.txt"), join(workspace, "new-name.txt"));
		writeFileSync(join(workspace, "committed-only.txt"), "committed only\n");
		appendFileSync(join(workspace, "tab\tname.txt"), "tab committed\n");
		git(workspace, "add", ".");
		git(workspace, "commit", "-qm", "latest");

		appendFileSync(join(workspace, "edited.txt"), "dirty\n");
		appendFileSync(join(workspace, "tab\tname.txt"), "tab dirty\n");
		writeFileSync(join(workspace, "untracked.txt"), "untracked\n");

		built = await createPiHost({
			workingDirectory: workspace,
			modelRuntime: { getAvailable: async () => [] },
			createBackend: () => ({
				subscribe: () => () => {},
				prompt: async () => {},
				steer: async () => {},
				abort: async () => {},
			}),
			deleteFile: () => ({ ok: true }),
		});
		server = await serveWebSocket(built.host, { host: "127.0.0.1", port: 0 });
		client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
		await client.initialize({ clientId: "changeset-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	});

	after(async () => {
		await client.shutdown();
		await server.close();
		built.terminals.shutdown();
		await Promise.all([built.changesets.dispose(), built.watches.dispose()]);
		rmSync(workspace, { recursive: true, force: true });
	});

	it("keeps the latest commit separate from uncommitted work and refreshes it", async () => {
		const session = sessionUri(randomUUID());
		await client.request("createSession", { channel: session });
		await client.subscribe(session);
		await eventually("the Git changeset catalogue", () => {
			return ((built.host.store.get(session) as SessionState).changesets?.length ?? 0) === 2;
		});
		const sessionState = built.host.store.get(session) as SessionState;
		assertValid("state", "SessionState", sessionState);
		assert.deepEqual(
			sessionState.changesets?.map(({ label, changeKind }) => ({ label, changeKind })),
			[
				{ label: "Latest Commit", changeKind: "branch" },
				{ label: "Uncommitted Changes", changeKind: "uncommitted" },
			],
		);
		const [latestChannel, uncommittedChannel] = sessionState.changesets?.map((item) => item.uriTemplate) ?? [];
		assert.ok(latestChannel);
		assert.ok(uncommittedChannel);

		await Promise.all([client.subscribe(latestChannel), client.subscribe(uncommittedChannel)]);
		const latest = await readyState(client, built.host, latestChannel);
		const uncommitted = await readyState(client, built.host, uncommittedChannel);
		assert.deepEqual(latest.files.map(fileName).sort(), [
			"committed-only.txt",
			"deleted.txt",
			"edited.txt",
			"new-name.txt",
			"tab\tname.txt",
		]);
		assert.deepEqual(uncommitted.files.map(fileName).sort(), ["edited.txt", "tab\tname.txt", "untracked.txt"]);

		const latestEdit = must(latest.files.find((file) => fileName(file) === "edited.txt"));
		const uncommittedEdit = must(uncommitted.files.find((file) => fileName(file) === "edited.txt"));
		const latestAfter = must(latestEdit.edit.after);
		const uncommittedBeforeRef = must(uncommittedEdit.edit.before);
		assert.ok(latestAfter.content.uri.startsWith("git-blob:"));
		assert.match(new URL(latestAfter.content.uri).search, /^\?[A-Za-z0-9_-]+$/u);
		assert.ok(uncommittedBeforeRef.content.uri.startsWith("git-blob:"));
		const committedContent = await client.resourceRead({
			uri: latestAfter.content.uri,
			encoding: ContentEncoding.Utf8,
		});
		const uncommittedBefore = await client.resourceRead({
			uri: uncommittedBeforeRef.content.uri,
			encoding: ContentEncoding.Utf8,
		});
		assert.equal(committedContent.data, "base\ncommitted\n");
		assert.equal(uncommittedBefore.data, committedContent.data);
		assert.equal(built.changesets.activeWatcherCount, 1);

		appendFileSync(join(workspace, "edited.txt"), "later\n");
		await eventually("the uncommitted changeset to refresh", () => {
			const state = built.host.store.get(uncommittedChannel) as ChangesetState | undefined;
			return (
				state?.status === ChangesetStatus.Ready &&
				state.files.find((file) => fileName(file) === "edited.txt")?.edit.diff?.added === 2
			);
		});
		const unchangedLatest = built.host.store.get(latestChannel) as ChangesetState;
		const unchangedLatestFile = must(unchangedLatest.files.find((file) => fileName(file) === "edited.txt"));
		const latestAfterRefresh = await client.resourceRead({
			uri: must(unchangedLatestFile.edit.after).content.uri,
			encoding: ContentEncoding.Utf8,
		});
		assert.equal(latestAfterRefresh.data, "base\ncommitted\n");

		const liveFile = join(workspace, "live-list.txt");
		writeFileSync(liveFile, "live\n");
		await eventually("a newly added file to enter the changeset", () => {
			const state = built.host.store.get(uncommittedChannel) as ChangesetState | undefined;
			return state?.status === ChangesetStatus.Ready && state.files.some((file) => fileName(file) === "live-list.txt");
		});
		appendFileSync(liveFile, "updated\n");
		await eventually("the added file to receive live updates", () => {
			const state = built.host.store.get(uncommittedChannel) as ChangesetState | undefined;
			return state?.files.find((file) => fileName(file) === "live-list.txt")?.edit.diff?.added === 2;
		});
		unlinkSync(liveFile);
		await eventually("a deleted untracked file to leave the changeset", () => {
			const state = built.host.store.get(uncommittedChannel) as ChangesetState | undefined;
			return state?.status === ChangesetStatus.Ready && !state.files.some((file) => fileName(file) === "live-list.txt");
		});

		git(workspace, "add", ".");
		git(workspace, "commit", "-qm", "move uncommitted work into latest");
		await eventually("the committed work to move between changesets", () => {
			const latestState = built.host.store.get(latestChannel) as ChangesetState | undefined;
			const uncommittedState = built.host.store.get(uncommittedChannel) as ChangesetState | undefined;
			return (
				latestState?.status === ChangesetStatus.Ready &&
				latestState.files.some((file) => fileName(file) === "untracked.txt") &&
				uncommittedState?.status === ChangesetStatus.Ready &&
				uncommittedState.files.length === 0
			);
		});
		await Promise.all([client.unsubscribe(latestChannel), client.unsubscribe(uncommittedChannel)]);
		await eventually("the unobserved Git watcher to close", () => built.changesets.activeWatcherCount === 0);
		await client.subscribe(uncommittedChannel);
		await eventually("the observed Git watcher to reopen", () => built.changesets.activeWatcherCount === 1);

		await client.request("disposeSession", { channel: session });
		assert.equal(built.host.store.has(latestChannel), false);
		assert.equal(built.host.store.has(uncommittedChannel), false);
		assert.equal(built.changesets.activeWatcherCount, 0);
	});

	it("limits changes to the session working-directory subtree", async () => {
		const scopedDirectory = join(workspace, "scope");
		const siblingDirectory = join(workspace, "sibling");
		mkdirSync(scopedDirectory);
		mkdirSync(siblingDirectory);
		writeFileSync(join(scopedDirectory, "inside.txt"), "base\n");
		writeFileSync(join(siblingDirectory, "outside.txt"), "base\n");
		git(workspace, "add", ".");
		git(workspace, "commit", "-qm", "add scoped files");
		appendFileSync(join(scopedDirectory, "inside.txt"), "changed\n");
		appendFileSync(join(siblingDirectory, "outside.txt"), "changed\n");

		const session = sessionUri(randomUUID());
		try {
			await client.request("createSession", {
				channel: session,
				workingDirectories: [pathToFileURL(scopedDirectory).toString()],
			});
			await built.changesets.attach(must(built.sessions.get(session)));
			const state = built.host.store.get(session) as SessionState;
			const channel = must(state.changesets?.find(({ changeKind }) => changeKind === "uncommitted")).uriTemplate;
			await client.subscribe(channel);
			assert.deepEqual((await readyState(client, built.host, channel)).files.map(fileName), ["inside.txt"]);
			await client.request("disposeSession", { channel: session });
		} finally {
			rmSync(scopedDirectory, { recursive: true, force: true });
			rmSync(siblingDirectory, { recursive: true, force: true });
		}
	});

	it("ignores ambient Git repository overrides", async () => {
		const other = mkdtempSync(join(tmpdir(), "pi-ahp-other-git-"));
		git(other, "init", "-q");
		const previous = {
			GIT_DIR: process.env.GIT_DIR,
			GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
			GIT_WORK_TREE: process.env.GIT_WORK_TREE,
		};
		try {
			process.env.GIT_DIR = join(other, ".git");
			process.env.GIT_INDEX_FILE = join(other, "foreign-index");
			process.env.GIT_WORK_TREE = other;
			const inspected = await new GitChanges().inspect(workspace);
			assert.equal(inspected?.repositoryRoot, realpathSync(workspace));
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("omits changesets when Git is unavailable", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-ahp-changeset-no-git-"));
		const emptyPath = mkdtempSync(join(tmpdir(), "pi-ahp-empty-path-"));
		const session = sessionUri(randomUUID());
		const previousPath = process.env.PATH;
		try {
			process.env.PATH = emptyPath;
			await client.request("createSession", {
				channel: session,
				workingDirectories: [pathToFileURL(directory).toString()],
			});
			await built.changesets.attach(must(built.sessions.get(session)));
			assert.equal((built.host.store.get(session) as SessionState).changesets, undefined);
		} finally {
			process.env.PATH = previousPath;
			if (built.sessions.has(session)) await client.request("disposeSession", { channel: session });
			rmSync(directory, { recursive: true, force: true });
			rmSync(emptyPath, { recursive: true, force: true });
		}
	});

	it("omits changesets outside Git workspaces", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-ahp-changeset-plain-"));
		const session = sessionUri(randomUUID());
		try {
			await client.request("createSession", {
				channel: session,
				workingDirectories: [pathToFileURL(directory).toString()],
			});
			await built.changesets.attach(must(built.sessions.get(session)));
			assert.equal((built.host.store.get(session) as SessionState).changesets, undefined);
			await client.request("disposeSession", { channel: session });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("omits Latest Commit before the repository has a commit", async () => {
		const emptyRepository = mkdtempSync(join(tmpdir(), "pi-ahp-changeset-empty-"));
		git(emptyRepository, "init", "-q");
		writeFileSync(join(emptyRepository, "first.txt"), "first\n");
		const session = sessionUri(randomUUID());
		try {
			await client.request("createSession", {
				channel: session,
				workingDirectories: [pathToFileURL(emptyRepository).toString()],
			});
			await built.changesets.attach(must(built.sessions.get(session)));
			const state = built.host.store.get(session) as SessionState;
			assert.deepEqual(
				state.changesets?.map(({ label }) => label),
				["Uncommitted Changes"],
			);
			const channel = must(state.changesets?.[0]).uriTemplate;
			await client.subscribe(channel);
			assert.deepEqual((await readyState(client, built.host, channel)).files.map(fileName), ["first.txt"]);
			await client.request("disposeSession", { channel: session });
		} finally {
			rmSync(emptyRepository, { recursive: true, force: true });
		}
	});
});

it("resumes changeset updates when durable session deletion fails", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-changeset-delete-failure-"));
	git(workspace, "init", "-q");
	git(workspace, "config", "user.email", "test@example.com");
	git(workspace, "config", "user.name", "pi-ahp test");
	const file = join(workspace, "tracked.txt");
	writeFileSync(file, "base\n");
	git(workspace, "add", ".");
	git(workspace, "commit", "-qm", "base");
	appendFileSync(file, "before failure\n");
	let deletionAttempts = 0;
	const built = await createPiHost({
		workingDirectory: workspace,
		modelRuntime: { getAvailable: async () => [] },
		createBackend: () => ({
			subscribe: () => () => {},
			prompt: async () => {},
			steer: async () => {},
			abort: async () => {},
		}),
		deleteFile: () => {
			deletionAttempts += 1;
			return { ok: false, error: "deletion blocked" };
		},
	});
	const server = await serveWebSocket(built.host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	const session = sessionUri(randomUUID());

	try {
		await client.initialize({ clientId: "changeset-delete-failure", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		await client.request("createSession", { channel: session });
		await built.changesets.attach(must(built.sessions.get(session)));
		const state = built.host.store.get(session) as SessionState;
		const channel = must(state.changesets?.find(({ changeKind }) => changeKind === "uncommitted")).uriTemplate;
		await client.subscribe(channel);
		await readyState(client, built.host, channel);

		await expectRpcError(
			client.request("disposeSession", { channel: session }),
			JsonRpcErrorCodes.InternalError,
			"failed durable deletion",
		);
		assert.equal(deletionAttempts, 1);
		assert.equal(built.host.store.has(session), true);
		assert.equal(built.host.store.has(channel), true);
		await eventually("the changeset watcher to resume", () => built.changesets.activeWatcherCount === 1);

		appendFileSync(file, "after failure\n");
		await eventually("changes after failed deletion", () => {
			const changeset = built.host.store.get(channel) as ChangesetState | undefined;
			return changeset?.status === ChangesetStatus.Ready && changeset.files[0]?.edit.diff?.added === 2;
		});
	} finally {
		await client.shutdown();
		await server.close();
		built.terminals.shutdown();
		await Promise.all([built.changesets.dispose(), built.watches.dispose()]);
		rmSync(workspace, { recursive: true, force: true });
	}
});

it("hydrates the parent session when its changeset is subscribed directly", async () => {
	const source = await startHydratedSessionFixture();
	git(source.workspace, "init", "-q");
	git(source.workspace, "config", "user.email", "test@example.com");
	git(source.workspace, "config", "user.name", "pi-ahp test");
	writeFileSync(join(source.workspace, "tracked.txt"), "tracked\n");
	git(source.workspace, "add", ".");
	git(source.workspace, "commit", "-qm", "tracked");

	const host = new AhpHost();
	installRootChannel(host, []);
	const catalogue = new PiSessionCatalogue(source.root);
	const sessions = new SessionRegistry({
		host,
		findSessionFile: (sessionId) => catalogue.findSessionFile(sessionId),
		deleteFile: () => ({ ok: true }),
	});
	const sessionHydrator = new SessionHydrator({
		host,
		catalogue,
		isLive: (session) => sessions.has(session),
		isDisposing: (session) => sessions.isDisposing(session),
		adopt: (session) => void sessions.adopt(session),
	});
	const changesets = new ChangesetService(host, {
		getSession: (sessionId) => sessions.get(sessionUri(sessionId)),
		getSessionByChat: (chat) => sessions.getByChat(chat),
		hydrateSession: async (sessionId) => {
			await sessionHydrator.hydrate(sessionUri(sessionId));
			return sessions.get(sessionUri(sessionId));
		},
		onSessionAvailable: (listener) => sessions.onSessionAvailable(listener),
		onSessionDeletionCommitted: (listener) => sessions.onSessionDeletionCommitted(listener),
		stateGraceMs: 0,
	});
	host.serve({
		hydrator: {
			async hydrate(channel) {
				return (await changesets.hydrate(channel)) || sessionHydrator.hydrate(channel);
			},
		},
	});
	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();

	try {
		await client.initialize({ clientId: "direct-changeset-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		await expectRpcError(
			client.subscribe(`ahp-changeset:/${source.sessionId}/unknown`),
			AhpErrorCodes.NotFound,
			"unknown changeset",
		);
		assert.equal(sessions.has(sessionUri(source.sessionId)), false);

		const channel = piChangesetUri(source.sessionId, "latest-commit");
		const { result } = await client.subscribe(channel);
		assert.equal(result.snapshot?.resource, channel);
		assert.equal(sessions.has(sessionUri(source.sessionId)), true);
		assert.deepEqual((await readyState(client, host, channel)).files.map(fileName), ["tracked.txt"]);

		await client.unsubscribe(channel);
		await eventually("the unobserved changeset state to be evicted", () => !host.store.has(channel));
		const restored = await client.subscribe(channel);
		assert.equal(restored.result.snapshot?.resource, channel);
		assert.deepEqual((await readyState(client, host, channel)).files.map(fileName), ["tracked.txt"]);
	} finally {
		await client.shutdown();
		await server.close();
		await changesets.dispose();
		await source.close();
	}
});
