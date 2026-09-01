import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	type ActionEnvelope,
	ActionType,
	type ChatState,
	PendingMessageKind,
	type ReconnectReplayResult,
	ReconnectResultType,
	type ReconnectSnapshotResult,
	ResponsePartKind,
	SUPPORTED_PROTOCOL_VERSIONS,
	TurnState,
} from "@microsoft/agent-host-protocol";
import type { AhpClient, Subscription } from "@microsoft/agent-host-protocol/client";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";

const CLIENT_ID = "active-turn-reconnect-client";
const TURN_ID = "active-turn";

class ControlledBackend implements PiBackend {
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	aborts = 0;
	readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
	}

	async steer(text: string): Promise<void> {
		this.steers.push(text);
	}

	async abort(): Promise<void> {
		this.aborts += 1;
	}

	startResponse(text: string): void {
		this.#emit({ type: "agent_start" });
		this.#emit({ type: "message_start", message: { role: "assistant" } });
		this.#emit({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
		});
	}

	finishResponse(): void {
		this.#emit({ type: "message_end", message: { role: "assistant" } });
		this.#emit({ type: "agent_end", messages: [], willRetry: false });
		this.#emit({ type: "agent_settled" });
	}

	#emit(event: object): void {
		for (const listener of this.#listeners) {
			listener(event as AgentSessionEvent);
		}
	}
}

interface ActiveTurnFixture {
	readonly backend: ControlledBackend;
	readonly baseline: number;
	readonly chat: string;
	readonly client: AhpClient;
	readonly harness: Harness;
	readonly session: string;
	readonly workspace: string;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("condition never became true");
		}
		await new Promise((resolve) => {
			const handle = setTimeout(resolve, 5);
			handle.unref?.();
		});
	}
}

async function nextEnvelope(
	subscription: Subscription,
	matches: (envelope: ActionEnvelope) => boolean,
	timeoutMs = 2_000,
): Promise<ActionEnvelope> {
	let handle: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		handle = setTimeout(() => reject(new Error("no matching action arrived")), timeoutMs);
		handle.unref?.();
	});
	const next = (async () => {
		while (true) {
			const event = await subscription.next();
			if (event.done) {
				throw new Error("subscription ended early");
			}
			if (event.value.type === "action") {
				const envelope = event.value.params as ActionEnvelope;
				if (matches(envelope)) {
					return envelope;
				}
			}
		}
	})();
	return Promise.race([next, timeout]).finally(() => clearTimeout(handle));
}

async function startActiveTurn(replayBufferCapacity = 64): Promise<ActiveTurnFixture> {
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-active-reconnect-"));
	const backend = new ControlledBackend();
	const harness = await startHarness({
		sessions: true,
		workingDirectory: workspace,
		replayBufferCapacity,
		createBackend: () => backend,
	});
	const client = await harness.connect();
	await client.initialize({ clientId: CLIENT_ID, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

	const id = randomUUID();
	const session = sessionUri(id);
	const chat = chatUri(id);
	await client.request("createSession", { channel: session } as never);
	await client.subscribe(session);
	await client.subscribe(chat);
	client.dispatch(chat, {
		type: ActionType.ChatTurnStarted,
		turnId: TURN_ID,
		startedAt: new Date().toISOString(),
		message: { text: "keep working", origin: { kind: "user" } },
	} as never);
	await waitFor(() => backend.prompts.length === 1);
	assert.equal((harness.host.store.get(chat) as ChatState).activeTurn?.id, TURN_ID);

	return { backend, baseline: harness.host.serverSeq, chat, client, harness, session, workspace };
}

async function dispose(fixture: ActiveTurnFixture): Promise<void> {
	await fixture.harness.dispose();
	rmSync(fixture.workspace, { recursive: true, force: true });
}

function responseText(state: ChatState): string | undefined {
	const turn = state.activeTurn ?? state.turns.at(-1);
	const part = turn?.responseParts.find((candidate) => candidate.kind === ResponsePartKind.Markdown);
	return part?.kind === ResponsePartKind.Markdown ? part.content : undefined;
}

describe("active-turn reconnect", () => {
	it("replays offline output and accepts steering and cancellation after reconnect", async () => {
		const fixture = await startActiveTurn();
		try {
			const observer = await fixture.harness.connect();
			await observer.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
			const { subscription: observerEvents } = await observer.subscribe(fixture.chat);

			await fixture.client.shutdown();
			await waitFor(() => fixture.harness.host.subscriberCount(fixture.chat) === 1);
			fixture.backend.startResponse("offline partial");
			const observed = await nextEnvelope(
				observerEvents,
				(envelope) => envelope.action.type === ActionType.ChatResponsePart,
			);

			const resumed = await fixture.harness.connect();
			const result = (await resumed.reconnect({
				clientId: CLIENT_ID,
				lastSeenServerSeq: fixture.baseline,
				subscriptions: [fixture.session, fixture.chat],
			})) as ReconnectReplayResult;

			assert.equal(result.type, ReconnectResultType.Replay);
			assert.ok(result.actions.some((envelope) => envelope.serverSeq === observed.serverSeq));
			assert.equal(responseText(fixture.harness.host.store.get(fixture.chat) as ChatState), "offline partial");
			assert.deepEqual(fixture.backend.prompts, ["keep working"]);

			resumed.dispatch(fixture.chat, {
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Steering,
				id: "after-reconnect",
				message: { text: "focus here", origin: { kind: "user" } },
			} as never);
			await waitFor(() => fixture.backend.steers.length === 1);
			resumed.dispatch(fixture.chat, {
				type: ActionType.ChatTurnCancelled,
				turnId: TURN_ID,
				duration: 0,
			} as never);
			await waitFor(() => fixture.backend.aborts === 1);

			const state = fixture.harness.host.store.get(fixture.chat) as ChatState;
			assert.equal(state.activeTurn, undefined);
			assert.equal(state.turns.at(-1)?.state, TurnState.Cancelled);
		} finally {
			await dispose(fixture);
		}
	});

	it("replays a turn that completed while its client was offline", async () => {
		const fixture = await startActiveTurn();
		try {
			await fixture.client.shutdown();
			await waitFor(() => fixture.harness.host.subscriberCount(fixture.chat) === 0);
			fixture.backend.startResponse("finished offline");
			fixture.backend.finishResponse();

			const resumed = await fixture.harness.connect();
			const result = (await resumed.reconnect({
				clientId: CLIENT_ID,
				lastSeenServerSeq: fixture.baseline,
				subscriptions: [fixture.session, fixture.chat],
			})) as ReconnectReplayResult;

			assert.equal(result.type, ReconnectResultType.Replay);
			assert.ok(result.actions.some((envelope) => envelope.action.type === ActionType.ChatTurnComplete));
			const state = fixture.harness.host.store.get(fixture.chat) as ChatState;
			assert.equal(state.turns.at(-1)?.state, TurnState.Complete);
			assert.equal(responseText(state), "finished offline");
			assert.deepEqual(fixture.backend.prompts, ["keep working"]);
		} finally {
			await dispose(fixture);
		}
	});

	it("falls back to an active-turn snapshot and continues streaming", async () => {
		const fixture = await startActiveTurn(4);
		try {
			await fixture.client.shutdown();
			await waitFor(() => fixture.harness.host.subscriberCount(fixture.chat) === 0);
			fixture.backend.startResponse("snapshot partial");
			for (let i = 0; i < 6; i++) {
				fixture.harness.host.dispatchServerAction(ROOT_CHANNEL, {
					type: ActionType.RootActiveSessionsChanged,
					activeSessions: i,
				});
			}

			const resumed = await fixture.harness.connect();
			const resumedEvents = resumed.attachSubscription(fixture.chat);
			const result = (await resumed.reconnect({
				clientId: CLIENT_ID,
				lastSeenServerSeq: fixture.baseline,
				subscriptions: [fixture.session, fixture.chat],
			})) as ReconnectSnapshotResult;

			assert.equal(result.type, ReconnectResultType.Snapshot);
			const chatSnapshot = result.snapshots.find((snapshot) => snapshot.resource === fixture.chat);
			assert.ok(chatSnapshot);
			assert.equal(responseText(chatSnapshot.state as ChatState), "snapshot partial");
			fixture.backend.finishResponse();
			await nextEnvelope(resumedEvents, (envelope) => envelope.action.type === ActionType.ChatTurnComplete);

			const state = fixture.harness.host.store.get(fixture.chat) as ChatState;
			assert.equal(state.turns.at(-1)?.state, TurnState.Complete);
			assert.deepEqual(fixture.backend.prompts, ["keep working"]);
		} finally {
			await dispose(fixture);
		}
	});
});
