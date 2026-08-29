import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	ActionType,
	ChatInputResponseKind,
	type ChatState,
	isClientDispatchable,
	type Message,
	MessageAttachmentKind,
	MessageKind,
	PendingMessageKind,
	type StateAction,
	SUPPORTED_PROTOCOL_VERSIONS,
	ToolCallCancellationReason,
} from "@microsoft/agent-host-protocol";
import type { AhpClient, Subscription } from "@microsoft/agent-host-protocol/client";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";

type Envelope = {
	action: StateAction;
	origin?: { clientSeq?: number };
	rejectionReason?: string;
	serverSeq: number;
};

type RejectionCase = { channel: string; action: StateAction; reason: RegExp };

function rejected(channel: string, reason: RegExp, actions: StateAction[]): RejectionCase[] {
	return actions.map((action) => ({ channel, action, reason }));
}

function userMessage(text: string, extra: Partial<Message> = {}): Message {
	return { text, origin: { kind: MessageKind.User }, ...extra };
}

async function nextAction(subscription: Subscription, clientSeq?: number, timeoutMs = 2_000): Promise<Envelope> {
	const timeout = new Promise<never>((_, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for an action")), timeoutMs);
		timer.unref?.();
	});
	const next = (async () => {
		while (true) {
			const event = await subscription.next();
			if (event.done) throw new Error("subscription ended early");
			if (event.value.type === "action") {
				const envelope = event.value.params as Envelope;
				if (clientSeq === undefined || envelope.origin?.clientSeq === clientSeq) return envelope;
			}
		}
	})();
	return Promise.race([next, timeout]);
}

describe("pi client-action policy", () => {
	let harness: Harness;
	let client: AhpClient;
	let observer: AhpClient;
	let workspace: string;

	before(async () => {
		workspace = mkdtempSync(join(tmpdir(), "pi-ahp-actions-"));
		harness = await startHarness({ sessions: true, workingDirectory: workspace });
		client = await harness.connect();
		observer = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
		await observer.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	});

	after(async () => {
		await harness.dispose();
		rmSync(workspace, { recursive: true, force: true });
	});

	async function createChannels(): Promise<{ session: string; chat: string }> {
		const id = randomUUID();
		const session = sessionUri(id);
		const chat = chatUri(id);
		await client.request("createSession", { channel: session } as never);
		await Promise.all([
			client.subscribe(session),
			client.subscribe(chat),
			observer.subscribe(session),
			observer.subscribe(chat),
		]);
		return { session, chat };
	}

	async function expectRejected(channel: string, action: StateAction, reason: RegExp): Promise<void> {
		const beforeState = structuredClone(harness.host.store.get(channel));
		const senderEvents = client.attachSubscription(channel);
		const observerEvents = observer.attachSubscription(channel);
		const dispatched = client.dispatch(channel, action as never);
		const [sender, seenByObserver] = await Promise.all([
			nextAction(senderEvents, dispatched.clientSeq),
			nextAction(observerEvents, dispatched.clientSeq),
		]);

		assert.equal(sender.action.type, action.type);
		assert.equal(sender.origin?.clientSeq, dispatched.clientSeq);
		assert.match(sender.rejectionReason ?? "", reason);
		assert.equal(seenByObserver.serverSeq, sender.serverSeq);
		assert.deepEqual(seenByObserver.action, sender.action);
		assert.equal(seenByObserver.rejectionReason, sender.rejectionReason);
		assert.deepEqual(harness.host.store.get(channel), beforeState);
	}

	it("accounts for every client action on channels this host serves", () => {
		const actual = Object.values(ActionType)
			.filter((type) => /^(root|session|chat)\//u.test(type) && isClientDispatchable({ type } as never))
			.sort();
		const expected = [
			ActionType.RootConfigChanged,
			ActionType.SessionTitleChanged,
			ActionType.SessionActiveClientSet,
			ActionType.SessionActiveClientRemoved,
			ActionType.SessionWorkingDirectorySet,
			ActionType.SessionWorkingDirectoryRemoved,
			ActionType.SessionCustomizationToggled,
			ActionType.SessionMcpServerStartRequested,
			ActionType.SessionMcpServerStopRequested,
			ActionType.SessionIsReadChanged,
			ActionType.SessionIsArchivedChanged,
			ActionType.SessionConfigChanged,
			ActionType.ChatTurnStarted,
			ActionType.ChatToolCallConfirmed,
			ActionType.ChatToolCallComplete,
			ActionType.ChatToolCallResultConfirmed,
			ActionType.ChatToolCallContentChanged,
			ActionType.ChatTurnCancelled,
			ActionType.ChatWorkingDirectorySet,
			ActionType.ChatWorkingDirectoryRemoved,
			ActionType.ChatPendingMessageSet,
			ActionType.ChatPendingMessageRemoved,
			ActionType.ChatQueuedMessagesReordered,
			ActionType.ChatDraftChanged,
			ActionType.ChatInputAnswerChanged,
			ActionType.ChatInputCompleted,
			ActionType.ChatTruncated,
		].sort();

		assert.deepEqual(actual, expected);
	});

	it("rejects capabilities pi does not implement", async () => {
		const { session, chat } = await createChannels();
		const cases: RejectionCase[] = [
			...rejected(session, /changing working directories/, [
				{ type: ActionType.SessionWorkingDirectorySet, directory: "file:///tmp/other" },
				{ type: ActionType.SessionWorkingDirectoryRemoved, directory: `file://${workspace}` },
			]),
			...rejected(chat, /changing working directories/, [
				{ type: ActionType.ChatWorkingDirectorySet, directory: "file:///tmp/other" },
				{ type: ActionType.ChatWorkingDirectoryRemoved, directory: `file://${workspace}` },
			]),
			...rejected(session, /customizations/, [
				{ type: ActionType.SessionCustomizationToggled, id: "plugin", enabled: false },
			]),
			...rejected(session, /MCP servers/, [
				{ type: ActionType.SessionMcpServerStartRequested, id: "mcp" },
				{ type: ActionType.SessionMcpServerStopRequested, id: "mcp" },
			]),
			...rejected(session, /read or archive state/, [
				{ type: ActionType.SessionIsReadChanged, isRead: false },
				{ type: ActionType.SessionIsArchivedChanged, isArchived: true },
			]),
			...rejected(session, /no mutable configuration/, [
				{ type: ActionType.SessionConfigChanged, config: { probe: true } },
			]),
			...rejected(chat, /client tool execution or confirmation/, [
				{
					type: ActionType.ChatToolCallConfirmed,
					turnId: "turn",
					toolCallId: "tool",
					approved: false,
					reason: ToolCallCancellationReason.Denied,
				},
				{
					type: ActionType.ChatToolCallComplete,
					turnId: "turn",
					toolCallId: "tool",
					result: { success: false, pastTenseMessage: "Failed" },
				},
				{ type: ActionType.ChatToolCallResultConfirmed, turnId: "turn", toolCallId: "tool", approved: true },
				{ type: ActionType.ChatToolCallContentChanged, turnId: "turn", toolCallId: "tool", content: [] },
			]),
			...rejected(chat, /interactive input requests/, [
				{ type: ActionType.ChatInputAnswerChanged, requestId: "input", questionId: "question" },
				{ type: ActionType.ChatInputCompleted, requestId: "input", response: ChatInputResponseKind.Cancel },
			]),
		];

		for (const testCase of cases) {
			await expectRejected(testCase.channel, testCase.action, testCase.reason);
		}
	});

	it("validates turn and user-message invariants", async () => {
		const { chat } = await createChannels();
		const agentMessage = userMessage("not from the user", { origin: { kind: MessageKind.Agent } });

		await expectRejected(
			chat,
			{
				type: ActionType.ChatTurnStarted,
				turnId: "agent-turn",
				startedAt: new Date().toISOString(),
				message: agentMessage,
			},
			/only start a turn with a user message/,
		);
		await expectRejected(
			chat,
			{
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Queued,
				id: "agent-queue",
				message: agentMessage,
			},
			/only queue a user message/,
		);
		await expectRejected(chat, { type: ActionType.ChatDraftChanged, draft: agentMessage }, /only draft a user message/);
		await expectRejected(
			chat,
			{
				type: ActionType.ChatTurnStarted,
				turnId: "attachment-turn",
				startedAt: new Date().toISOString(),
				message: userMessage("with context", {
					attachments: [{ type: MessageAttachmentKind.Simple, label: "context" }],
				}),
			},
			/requires modelRepresentation/,
		);
		await expectRejected(
			chat,
			{
				type: ActionType.ChatDraftChanged,
				draft: userMessage("image", {
					attachments: [
						{
							type: MessageAttachmentKind.EmbeddedResource,
							label: "image.png",
							contentType: "image/png",
							data: "iVBORw0KGgo=",
						},
					],
				}),
			},
			/valid UTF-8/,
		);
		await expectRejected(
			chat,
			{
				type: ActionType.ChatDraftChanged,
				draft: userMessage("custom agent", { agent: { uri: "agent:/fixture" } }),
			},
			/custom agents/,
		);
		await expectRejected(
			chat,
			{
				type: ActionType.ChatTurnStarted,
				turnId: "queued-turn",
				startedAt: new Date().toISOString(),
				message: userMessage("queued"),
				queuedMessageId: "client-owned",
			},
			/Only the host can start a queued message/,
		);
		await expectRejected(
			chat,
			{ type: ActionType.ChatTurnCancelled, turnId: "absent", duration: 0 },
			/No matching active turn/,
		);
		await expectRejected(
			chat,
			{ type: ActionType.ChatPendingMessageRemoved, kind: PendingMessageKind.Queued, id: "absent" },
			/No matching queued message/,
		);
		harness.host.dispatchServerAction(chat, {
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Steering,
			id: "steering",
			message: userMessage("steer"),
		});
		await expectRejected(
			chat,
			{ type: ActionType.ChatPendingMessageRemoved, kind: PendingMessageKind.Steering, id: "steering" },
			/cannot be withdrawn/,
		);

		harness.host.dispatchServerAction(chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "active",
			startedAt: new Date().toISOString(),
			message: userMessage("active"),
		});
		await expectRejected(
			chat,
			{
				type: ActionType.ChatTurnStarted,
				turnId: "second",
				startedAt: new Date().toISOString(),
				message: userMessage("second"),
			},
			/A turn is already active/,
		);
	});

	it("keeps state-only draft and queued-message actions", async () => {
		const { chat } = await createChannels();
		const draft = userMessage("draft");
		let events = client.attachSubscription(chat);
		let dispatched = client.dispatch(chat, { type: ActionType.ChatDraftChanged, draft });
		assert.equal((await nextAction(events, dispatched.clientSeq)).rejectionReason, undefined);
		assert.deepEqual((harness.host.store.get(chat) as ChatState).draft, draft);

		harness.host.dispatchServerAction(chat, {
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Queued,
			id: "first",
			message: userMessage("first"),
		});
		harness.host.dispatchServerAction(chat, {
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Queued,
			id: "second",
			message: userMessage("second"),
		});
		events = client.attachSubscription(chat);
		dispatched = client.dispatch(chat, { type: ActionType.ChatQueuedMessagesReordered, order: ["second", "first"] });
		assert.equal((await nextAction(events, dispatched.clientSeq)).rejectionReason, undefined);
		assert.deepEqual(
			(harness.host.store.get(chat) as ChatState).queuedMessages?.map((message) => message.id),
			["second", "first"],
		);
		events = client.attachSubscription(chat);
		dispatched = client.dispatch(chat, {
			type: ActionType.ChatPendingMessageRemoved,
			kind: PendingMessageKind.Queued,
			id: "first",
		});
		assert.equal((await nextAction(events, dispatched.clientSeq)).rejectionReason, undefined);

		const state = harness.host.store.get(chat) as ChatState;
		assert.deepEqual(
			state.queuedMessages?.map((message) => message.id),
			["second"],
		);
	});
});
