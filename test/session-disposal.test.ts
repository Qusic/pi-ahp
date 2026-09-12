/** Durable session removal and its concurrency boundary. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	JsonRpcErrorCodes,
	MessageKind,
	PendingMessageKind,
	SessionLifecycle,
	type SessionState,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import type { AhpClient, Subscription } from "@microsoft/agent-host-protocol/client";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import type { BackendFactory, SessionFileDeletionResult } from "../src/pi/session-registry.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";
import { expectRpcError } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";

interface DisposalFixture {
	readonly harness: Harness;
	readonly client: AhpClient;
	close(): Promise<void>;
}

async function startDisposalFixture(options: {
	createBackend?: BackendFactory;
	deleteFile?: (path: string) => SessionFileDeletionResult | Promise<SessionFileDeletionResult>;
}): Promise<DisposalFixture> {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-disposal-"));
	const workspace = join(root, "workspace");
	const catalogueRoot = join(root, "sessions");
	mkdirSync(workspace);
	const harness = await startHarness({
		sessions: true,
		workingDirectory: workspace,
		catalogueRoot,
		...(options.createBackend ? { createBackend: options.createBackend } : {}),
		...(options.deleteFile ? { deleteFile: options.deleteFile } : {}),
	});
	const client = await harness.connect();
	await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	return {
		harness,
		client,
		async close() {
			await harness.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function nextRejectedAction(subscription: Subscription, clientSeq: number): Promise<string | undefined> {
	const timeout = new Promise<never>((_, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for a rejected action")), 2_000);
		timer.unref?.();
	});
	const next = (async () => {
		while (true) {
			const event = await subscription.next();
			if (event.done) throw new Error("subscription ended early");
			if (event.value.type !== "action") continue;
			const envelope = event.value.params as { origin?: { clientSeq?: number }; rejectionReason?: string };
			if (envelope.origin?.clientSeq === clientSeq) return envelope.rejectionReason;
		}
	})();
	return Promise.race([next, timeout]);
}

async function createReadySession(fixture: DisposalFixture): Promise<{ uri: string; chat: string }> {
	const id = randomUUID();
	const uri = sessionUri(id);
	await fixture.client.request("createSession", { channel: uri });
	await eventually(
		"the session backend to become ready",
		() => (fixture.harness.host.store.get(uri) as SessionState).lifecycle === SessionLifecycle.Ready,
	);
	return { uri, chat: chatUri(id) };
}

describe("session disposal", () => {
	it("keeps the session usable when durable deletion fails", async () => {
		let deletionAttempts = 0;
		const fixture = await startDisposalFixture({
			deleteFile: () => {
				deletionAttempts += 1;
				return { ok: false, error: "permission denied" };
			},
		});
		try {
			const { uri } = await createReadySession(fixture);
			const activeBefore = (fixture.harness.host.store.get(ROOT_CHANNEL) as { activeSessions?: number }).activeSessions;
			assert.equal(activeBefore, 1);

			const error = await expectRpcError(
				fixture.client.request("disposeSession", { channel: uri }),
				JsonRpcErrorCodes.InternalError,
			);

			assert.match(error.message, /permission denied/u);
			assert.equal(deletionAttempts, 1);
			assert.equal(fixture.harness.sessions?.has(uri), true);
			assert.equal(
				(fixture.harness.host.store.get(ROOT_CHANNEL) as { activeSessions?: number }).activeSessions,
				activeBefore,
			);
			const listed = await fixture.client.request("listSessions", { channel: ROOT_CHANNEL });
			assert.deepEqual(
				listed.items.map((item) => item.resource),
				[uri],
			);

			fixture.client.dispatch(uri, { type: ActionType.SessionTitleChanged, title: "Still here" });
			await fixture.client.ping();
			assert.equal((fixture.harness.host.store.get(uri) as SessionState).title, "Still here");
		} finally {
			await fixture.close();
		}
	});

	it("coalesces concurrent requests and rejects new work until deletion settles", async () => {
		let deletionAttempts = 0;
		let finishDeletion!: (result: { ok: boolean }) => void;
		const deletion = new Promise<{ ok: boolean }>((resolve) => {
			finishDeletion = resolve;
		});
		const fixture = await startDisposalFixture({
			deleteFile: () => {
				deletionAttempts += 1;
				return deletion;
			},
		});
		try {
			const { uri } = await createReadySession(fixture);
			const { subscription } = await fixture.client.subscribe(uri);
			const titleBefore = (fixture.harness.host.store.get(uri) as SessionState).title;

			const first = fixture.client.request("disposeSession", { channel: uri });
			await eventually("durable deletion to start", () => deletionAttempts === 1);
			const second = fixture.client.request("disposeSession", { channel: uri });
			const dispatched = fixture.client.dispatch(uri, {
				type: ActionType.SessionTitleChanged,
				title: "Too late",
			});
			assert.ok(await nextRejectedAction(subscription, dispatched.clientSeq));
			assert.equal((fixture.harness.host.store.get(uri) as SessionState).title, titleBefore);

			finishDeletion({ ok: true });
			await Promise.all([first, second]);
			assert.equal(deletionAttempts, 1);
			assert.equal(fixture.harness.host.store.has(uri), false);
		} finally {
			finishDeletion({ ok: false });
			await fixture.close();
		}
	});

	it("quiesces an active backend and commits removal despite cleanup failure", async () => {
		let promptStarted = false;
		let promptSettled = false;
		let releasePrompt: (() => void) | undefined;
		let aborted = false;
		let disposed = false;
		let deleteSawQuiescence = false;
		const backend: PiBackend = {
			subscribe: () => () => undefined,
			prompt: async () => {
				await new Promise<void>((resolve) => {
					promptStarted = true;
					releasePrompt = resolve;
				});
				promptSettled = true;
			},
			steer: async () => undefined,
			abort: async () => {
				aborted = true;
				releasePrompt?.();
			},
			dispose: () => {
				disposed = true;
				throw new Error("cleanup failed after deletion");
			},
		};
		const fixture = await startDisposalFixture({
			createBackend: () => backend,
			deleteFile: () => {
				deleteSawQuiescence = aborted && promptSettled;
				return { ok: true };
			},
		});
		try {
			const { uri, chat } = await createReadySession(fixture);
			await fixture.client.subscribe(chat);
			fixture.client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "turn-to-delete",
				startedAt: new Date().toISOString(),
				message: { text: "keep running", origin: { kind: MessageKind.User } },
			});
			await eventually("the active prompt to start", () => promptStarted);

			await fixture.client.request("disposeSession", { channel: uri });

			assert.equal(deleteSawQuiescence, true);
			assert.equal(disposed, true);
			assert.equal(fixture.harness.host.store.has(uri), false);
		} finally {
			releasePrompt?.();
			await fixture.close();
		}
	});

	it("resumes queued work when backend quiescence fails", async () => {
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const prompts: string[] = [];
		let deletionAttempts = 0;
		const backend: PiBackend = {
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async (text) => {
				prompts.push(text);
			},
			steer: async () => undefined,
			abort: async () => {
				for (const listener of listeners) listener({ type: "agent_settled" } as AgentSessionEvent);
				throw new Error("abort failed");
			},
		};
		const fixture = await startDisposalFixture({
			createBackend: () => backend,
			deleteFile: () => {
				deletionAttempts += 1;
				return { ok: true };
			},
		});
		try {
			const { uri, chat } = await createReadySession(fixture);
			await fixture.client.subscribe(chat);
			fixture.client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "active",
				startedAt: new Date().toISOString(),
				message: { text: "active", origin: { kind: MessageKind.User } },
			});
			await eventually("the active prompt to start", () => prompts.length === 1);
			fixture.client.dispatch(chat, {
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Queued,
				id: "after-failure",
				message: { text: "after failure", origin: { kind: MessageKind.User } },
			});
			await fixture.client.ping();

			const error = await expectRpcError(
				fixture.client.request("disposeSession", { channel: uri }),
				JsonRpcErrorCodes.InternalError,
			);

			assert.match(error.message, /abort failed/u);
			await eventually("queued work to resume", () => prompts.includes("after failure"));
			assert.equal(deletionAttempts, 0);
			assert.equal(fixture.harness.sessions?.has(uri), true);
		} finally {
			await fixture.close();
		}
	});

	it("drains an in-flight model selection before deleting", async () => {
		let selectionStarted = false;
		let selectionSettled = false;
		let finishSelection!: () => void;
		const selection = new Promise<void>((resolve) => {
			finishSelection = resolve;
		});
		let prompts = 0;
		let deletionAttempts = 0;
		const backend: PiBackend = {
			subscribe: () => () => undefined,
			selectModel: async () => {
				selectionStarted = true;
				await selection;
				selectionSettled = true;
			},
			prompt: async () => {
				prompts += 1;
			},
			steer: async () => undefined,
			abort: async () => undefined,
		};
		const fixture = await startDisposalFixture({
			createBackend: () => backend,
			deleteFile: () => {
				deletionAttempts += 1;
				assert.equal(selectionSettled, true, "deletion overtook a session-writing model selection");
				return { ok: true };
			},
		});
		try {
			const { uri, chat } = await createReadySession(fixture);
			await fixture.client.subscribe(chat);
			fixture.client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "turn-selecting",
				startedAt: new Date().toISOString(),
				message: {
					text: "switch first",
					origin: { kind: MessageKind.User },
					model: { id: "pi/other-model" },
				},
			});
			await eventually("model selection to start", () => selectionStarted);

			const disposing = fixture.client.request("disposeSession", { channel: uri });
			await fixture.client.ping();
			assert.equal(deletionAttempts, 0);

			finishSelection();
			await disposing;
			assert.equal(deletionAttempts, 1);
			assert.equal(prompts, 0, "a prompt started after disposal quiesced its turn");
		} finally {
			finishSelection();
			await fixture.close();
		}
	});

	it("disposes a backend that finishes starting after removal", async () => {
		let finishStart!: (backend: PiBackend) => void;
		const starting = new Promise<PiBackend>((resolve) => {
			finishStart = resolve;
		});
		let backendDisposals = 0;
		const fixture = await startDisposalFixture({ createBackend: () => starting });
		try {
			const uri = sessionUri(randomUUID());
			await fixture.client.request("createSession", { channel: uri });
			await fixture.client.request("disposeSession", { channel: uri });
			finishStart({
				subscribe: () => () => undefined,
				prompt: async () => undefined,
				steer: async () => undefined,
				abort: async () => undefined,
				dispose: () => {
					backendDisposals += 1;
				},
			});
			await eventually("the late backend to be disposed", () => backendDisposals === 1);

			assert.equal(backendDisposals, 1);
			assert.equal(fixture.harness.host.store.has(uri), false);
		} finally {
			await fixture.close();
		}
	});
});
