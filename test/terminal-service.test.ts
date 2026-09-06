import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type ActionEnvelope,
	ActionType,
	JsonRpcErrorCodes,
	ReconnectResultType,
	type RootState,
	SUPPORTED_PROTOCOL_VERSIONS,
	TerminalClaimKind,
	TerminalLifecycleStatus,
	type TerminalState,
} from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError, type Subscription } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { ROOT_CHANNEL } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import { pathToFileUri } from "../src/core/uri.ts";
import { TerminalService } from "../src/host/terminal-service.ts";
import { serveWebSocket } from "../src/transport/websocket.ts";
import { checkSchema } from "./support/schema.ts";

const EXPECTED_SCROLLBACK_CHARS = 1_000_000;

class FakePty {
	readonly writes: string[] = [];
	readonly resizes: Array<{ cols: number; rows: number }> = [];
	kills = 0;
	readonly #dataListeners = new Set<(data: string) => unknown>();
	readonly #exitListeners = new Set<(event: { exitCode: number; signal?: number }) => unknown>();

	onData(listener: (data: string) => unknown): { dispose(): void } {
		this.#dataListeners.add(listener);
		return { dispose: () => this.#dataListeners.delete(listener) };
	}

	onExit(listener: (event: { exitCode: number; signal?: number }) => unknown): { dispose(): void } {
		this.#exitListeners.add(listener);
		return { dispose: () => this.#exitListeners.delete(listener) };
	}

	write(data: string | Buffer): void {
		this.writes.push(data.toString());
	}

	resize(cols: number, rows: number): void {
		this.resizes.push({ cols, rows });
	}

	kill(): void {
		this.kills += 1;
	}

	emitData(data: string): void {
		for (const listener of this.#dataListeners) listener(data);
	}

	emitExit(exitCode: number): void {
		for (const listener of this.#exitListeners) listener({ exitCode });
	}
}

interface FakeSpawnOptions {
	name: string;
	cols: number;
	rows: number;
	cwd: string;
}

type SpawnCall = {
	file: string;
	args: string[];
	options: FakeSpawnOptions;
	pty: FakePty;
};

class FakeSpawner {
	readonly calls: SpawnCall[] = [];
	readonly spawn = (file: string, args: string[], options: FakeSpawnOptions): FakePty => {
		const pty = new FakePty();
		this.calls.push({ file, args, options, pty });
		return pty;
	};
}

interface Fixture {
	readonly directory: string;
	readonly host: AhpHost;
	readonly spawner: FakeSpawner;
	readonly terminals: TerminalService;
	open(): Promise<AhpClient>;
	connect(clientId: string): Promise<AhpClient>;
	dispose(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
	const directory = mkdtempSync(join(tmpdir(), "pi-ahp-terminal-"));
	const host = new AhpHost({ replayBufferCapacity: 4 });
	installRootChannel(host, []);
	const spawner = new FakeSpawner();
	const terminals = new TerminalService(
		host,
		{
			defaultWorkingDirectory: directory,
			shell: "test-shell",
		},
		spawner.spawn,
	);
	host.serve({ terminals });
	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const clients: AhpClient[] = [];
	const open = async (): Promise<AhpClient> => {
		const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
		clients.push(client);
		return client;
	};

	return {
		directory,
		host,
		spawner,
		terminals,
		open,
		async connect(clientId) {
			const client = await open();
			await client.initialize({ clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
			return client;
		},
		async dispose() {
			await Promise.allSettled(clients.map((client) => client.shutdown()));
			terminals.shutdown();
			await server.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function terminalState(fixture: Fixture, channel: string): TerminalState {
	const state = fixture.host.store.get(channel);
	assert.ok(state, `missing terminal state for ${channel}`);
	return state as TerminalState;
}

function rootState(fixture: Fixture): RootState {
	return fixture.host.store.get(ROOT_CHANNEL) as RootState;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition never became true");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function nextAction(subscription: Subscription, clientSeq: number): Promise<ActionEnvelope> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("timed out waiting for terminal action")), 2_000);
	});
	const next = (async () => {
		while (true) {
			const event = await subscription.next();
			if (event.done) throw new Error("terminal subscription ended early");
			if (event.value.type !== "action") continue;
			const envelope = event.value.params as ActionEnvelope;
			if (envelope.origin?.clientSeq === clientSeq) return envelope;
		}
	})();
	return Promise.race([next, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

describe("terminal service", () => {
	let fixture: Fixture;
	let owner: AhpClient;
	const ownerId = "terminal-owner";

	beforeEach(async () => {
		fixture = await startFixture();
		owner = await fixture.connect(ownerId);
	});

	afterEach(async () => {
		await fixture.dispose();
	});

	async function createTerminal(params: Record<string, unknown> = {}): Promise<{ channel: string; pty: FakePty }> {
		const channel = (params.channel as string | undefined) ?? `agenthost-terminal:/${randomUUID()}`;
		await owner.request("createTerminal", {
			channel,
			claim: { kind: TerminalClaimKind.Client, clientId: ownerId },
			...params,
		} as never);
		const pty = fixture.spawner.calls.at(-1)?.pty;
		assert.ok(pty);
		return { channel, pty };
	}

	it("creates a client-owned terminal and publishes its authoritative state", async () => {
		const cwd = pathToFileUri(fixture.directory);
		const { channel } = await createTerminal({ name: "Build", cwd, cols: 100, rows: 30 });
		const call = fixture.spawner.calls[0];
		assert.ok(call);
		assert.deepEqual(
			{ file: call.file, args: call.args, options: call.options },
			{
				file: "test-shell",
				args: [],
				options: { name: "xterm-256color", cwd: fixture.directory, cols: 100, rows: 30 },
			},
		);

		const state = terminalState(fixture, channel);
		assert.deepEqual(state, {
			title: "Build",
			cwd,
			cols: 100,
			rows: 30,
			content: [],
			lifecycle: { status: TerminalLifecycleStatus.Running },
			claim: { kind: TerminalClaimKind.Client, clientId: ownerId },
			isPty: true,
		});
		assert.equal(checkSchema("state", "TerminalState", state), undefined);
		const root = rootState(fixture);
		assert.deepEqual(root.terminals, [
			{
				resource: channel,
				title: "Build",
				claim: state.claim,
				lifecycle: state.lifecycle,
			},
		]);
		assert.equal(checkSchema("state", "RootState", root), undefined);

		const { result } = await owner.subscribe(channel);
		assert.equal(result.snapshot?.resource, channel);
		assert.deepEqual(result.snapshot?.state, state);
	});

	it("forwards output, input, resize, title, and clear without interpreting VT data", async () => {
		const { channel, pty } = await createTerminal();
		const { subscription } = await owner.subscribe(channel);
		assert.equal(terminalState(fixture, channel).title, "test-shell");
		pty.emitData("hello\u001b[31m red");
		await waitFor(() => terminalState(fixture, channel).content.length > 0);
		assert.deepEqual(terminalState(fixture, channel).content, [{ type: "unclassified", value: "hello\u001b[31m red" }]);

		owner.dispatch(channel, { type: ActionType.TerminalInput, data: "echo hi\r" });
		await waitFor(() => pty.writes.length === 1);
		assert.deepEqual(pty.writes, ["echo hi\r"]);

		owner.dispatch(channel, { type: ActionType.TerminalResized, cols: 120, rows: 40 });
		await waitFor(() => pty.resizes.length === 1);
		assert.deepEqual(pty.resizes, [{ cols: 120, rows: 40 }]);
		assert.equal(terminalState(fixture, channel).cols, 120);
		assert.equal(terminalState(fixture, channel).rows, 40);

		owner.dispatch(channel, { type: ActionType.TerminalTitleChanged, title: "Tests" });
		await waitFor(() => rootState(fixture).terminals?.[0]?.title === "Tests");
		assert.equal(terminalState(fixture, channel).title, "Tests");

		pty.emitData("stale pending output");
		const clear = owner.dispatch(channel, { type: ActionType.TerminalCleared });
		await nextAction(subscription, clear.clientSeq);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(terminalState(fixture, channel).content, []);
	});

	it("batches burst output and flushes pending data before exit", async () => {
		const { channel, pty } = await createTerminal();
		const before = fixture.host.serverSeq;
		for (let index = 0; index < 100; index += 1) pty.emitData("x");
		await waitFor(() => terminalState(fixture, channel).content.length > 0);
		assert.equal(fixture.host.serverSeq, before + 1);
		assert.deepEqual(terminalState(fixture, channel).content, [{ type: "unclassified", value: "x".repeat(100) }]);

		pty.emitData("tail");
		pty.emitExit(0);
		assert.deepEqual(terminalState(fixture, channel).content, [
			{ type: "unclassified", value: `${"x".repeat(100)}tail` },
		]);
		assert.deepEqual(terminalState(fixture, channel).lifecycle, {
			status: TerminalLifecycleStatus.Exited,
			exitCode: 0,
		});
	});

	it("restricts interaction and claim transfer without preventing cleanup", async () => {
		const { channel, pty } = await createTerminal();
		const observer = await fixture.connect("terminal-observer");
		await Promise.all([owner.subscribe(channel), observer.subscribe(channel)]);

		const observerEvents = observer.attachSubscription(channel);
		const input = observer.dispatch(channel, { type: ActionType.TerminalInput, data: "nope" });
		const rejectedInput = await nextAction(observerEvents, input.clientSeq);
		assert.match(rejectedInput.rejectionReason ?? "", /claimed by another client/);
		assert.deepEqual(pty.writes, []);

		const ownerEvents = owner.attachSubscription(channel);
		const claim = owner.dispatch(channel, {
			type: ActionType.TerminalClaimed,
			claim: { kind: TerminalClaimKind.Client, clientId: "terminal-observer" },
		});
		const rejectedClaim = await nextAction(ownerEvents, claim.clientSeq);
		assert.match(rejectedClaim.rejectionReason ?? "", /does not support transferring terminal claims/);
		assert.deepEqual(terminalState(fixture, channel).claim, {
			kind: TerminalClaimKind.Client,
			clientId: ownerId,
		});

		await observer.request("disposeTerminal", { channel } as never);
		assert.equal(pty.kills, 1);
		assert.equal(fixture.host.store.has(channel), false);
		assert.deepEqual(rootState(fixture).terminals, []);
	});

	it("spawns only once when duplicate creates race", async () => {
		const params = {
			channel: `ahp-terminal:/${randomUUID()}`,
			claim: { kind: TerminalClaimKind.Client, clientId: ownerId },
		};
		const results = await Promise.allSettled([
			owner.request("createTerminal", params as never),
			owner.request("createTerminal", params as never),
		]);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal(results.filter((result) => result.status === "rejected").length, 1);
		assert.equal(fixture.spawner.calls.length, 1);
	});

	it("rejects unsupported claims and invalid creation parameters before spawning", async () => {
		const channel = `ahp-terminal:/${randomUUID()}`;
		for (const params of [
			{ channel, claim: { kind: TerminalClaimKind.Session, session: "ahp-session:/s", chat: "ahp-chat:/s" } },
			{ channel, claim: { kind: TerminalClaimKind.Client, clientId: "someone-else" } },
			{ channel, claim: { kind: TerminalClaimKind.Client, clientId: ownerId }, cols: 0 },
			{ channel, claim: { kind: TerminalClaimKind.Client, clientId: ownerId }, cwd: "https://example.com" },
			{ channel, claim: { kind: TerminalClaimKind.Client, clientId: ownerId }, cwd: "file://remote/share" },
		]) {
			await assert.rejects(owner.request("createTerminal", params as never), RpcError);
		}
		assert.deepEqual(fixture.spawner.calls, []);
	});

	it("records natural exit and disposes exited or running terminals", async () => {
		const first = await createTerminal({ name: "First" });
		first.pty.emitExit(7);
		assert.deepEqual(terminalState(fixture, first.channel).lifecycle, {
			status: TerminalLifecycleStatus.Exited,
			exitCode: 7,
		});
		assert.equal(rootState(fixture).terminals?.[0]?.lifecycle.status, TerminalLifecycleStatus.Exited);

		await owner.request("disposeTerminal", { channel: first.channel } as never);
		assert.equal(fixture.host.store.has(first.channel), false);
		assert.equal(first.pty.kills, 0);
		assert.deepEqual(rootState(fixture).terminals, []);

		const second = await createTerminal({ name: "Second" });
		await owner.request("disposeTerminal", { channel: second.channel } as never);
		assert.equal(second.pty.kills, 1);
		assert.equal(fixture.host.store.has(second.channel), false);
		await owner.request("disposeTerminal", { channel: second.channel } as never);
	});

	it("keeps the PTY attached across a same-host reconnect", async () => {
		const { channel, pty } = await createTerminal();
		await owner.subscribe(channel);
		const lastSeenServerSeq = fixture.host.serverSeq;
		await owner.shutdown();
		pty.emitData("offline output");
		await waitFor(() => fixture.host.serverSeq > lastSeenServerSeq);

		const resumed = await fixture.open();
		const result = await resumed.reconnect({
			clientId: ownerId,
			lastSeenServerSeq,
			subscriptions: [channel],
		});
		assert.equal(result.type, ReconnectResultType.Replay);
		assert.deepEqual(
			result.actions.map((envelope) => envelope.action),
			[{ type: ActionType.TerminalData, data: "offline output" }],
		);
		assert.equal(fixture.spawner.calls.length, 1);

		resumed.dispatch(channel, { type: ActionType.TerminalInput, data: "continued" });
		await waitFor(() => pty.writes.includes("continued"));
	});

	it("falls back to a live terminal snapshot after replay eviction", async () => {
		const { channel, pty } = await createTerminal();
		await owner.subscribe(channel);
		const lastSeenServerSeq = fixture.host.serverSeq;
		await owner.shutdown();
		const chunks = ["zero", "one", "two", "three", "four", "five"];
		for (const chunk of chunks) {
			const before = fixture.host.serverSeq;
			pty.emitData(chunk);
			await waitFor(() => fixture.host.serverSeq > before);
		}

		const resumed = await fixture.open();
		const result = await resumed.reconnect({
			clientId: ownerId,
			lastSeenServerSeq,
			subscriptions: [channel],
		});
		assert.equal(result.type, ReconnectResultType.Snapshot);
		const snapshot = result.snapshots[0];
		assert.ok(snapshot);
		assert.equal(snapshot.resource, channel);
		assert.equal(snapshot.fromSeq, fixture.host.serverSeq);
		const state = snapshot.state as TerminalState;
		assert.deepEqual(state.content, [{ type: "unclassified", value: chunks.join("") }]);
		assert.deepEqual(state.lifecycle, { status: TerminalLifecycleStatus.Running });
		assert.deepEqual(state.claim, { kind: TerminalClaimKind.Client, clientId: ownerId });
		assert.deepEqual([state.cols, state.rows], [80, 24]);
		assert.equal(fixture.spawner.calls.length, 1);

		resumed.dispatch(channel, { type: ActionType.TerminalInput, data: "after snapshot" });
		await waitFor(() => pty.writes.includes("after snapshot"));
	});

	it("bounds snapshot scrollback while retaining the newest VT stream", async () => {
		const { channel, pty } = await createTerminal();
		pty.emitData(`discard${"x".repeat(EXPECTED_SCROLLBACK_CHARS)}`);
		await waitFor(() => terminalState(fixture, channel).content.length > 0);
		const [part] = terminalState(fixture, channel).content;
		assert.ok(part?.type === "unclassified");
		assert.equal(part.value.length, EXPECTED_SCROLLBACK_CHARS);
		assert.equal(part.value, "x".repeat(EXPECTED_SCROLLBACK_CHARS));
	});

	it("kills running PTYs during service shutdown", async () => {
		const { channel, pty } = await createTerminal();
		fixture.terminals.shutdown();
		assert.equal(pty.kills, 1);
		assert.equal(fixture.host.store.has(channel), false);
		assert.deepEqual(rootState(fixture).terminals, []);
		fixture.terminals.shutdown();
	});
});

it("returns MethodNotFound when terminal support is not wired", async () => {
	const host = new AhpHost();
	installRootChannel(host, []);
	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	await client.initialize({ clientId: "no-terminals", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	try {
		await assert.rejects(
			client.request("createTerminal", {
				channel: "ahp-terminal:/none",
				claim: { kind: TerminalClaimKind.Client, clientId: "no-terminals" },
			} as never),
			{ code: JsonRpcErrorCodes.MethodNotFound },
		);
	} finally {
		await client.shutdown();
		await server.close();
	}
});
