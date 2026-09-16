/**
 * Opening a session that only exists on disk.
 *
 * A client lists sessions and then subscribes to one. Everything this host
 * created is in memory, but the catalogue is backed by pi's session files —
 * most of which no live host has ever touched. Without lazy loading, every
 * session the catalogue advertises answers `NotFound` on subscribe.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { utimesSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import {
	type ChatState,
	MessageAttachmentKind,
	ResponsePartKind,
	type RootState,
	SessionLifecycle,
	type SessionState,
	ToolCallStatus,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { AhpHost } from "../src/core/host.ts";
import { pathToFileUri } from "../src/core/uri.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { SessionHydrator } from "../src/pi/session-hydrator.ts";
import { must } from "./support/assertions.ts";
import { type HydratedSessionFixture, startHydratedSessionFixture } from "./support/hydrated-session.ts";
import { ONE_PIXEL_PNG } from "./support/images.ts";
import { assertValid } from "./support/schema.ts";

class BlockingCatalogue extends PiSessionCatalogue {
	readonly lookupStarted = Promise.withResolvers<void>();
	readonly lookupGate = Promise.withResolvers<void>();
	lookups = 0;

	override async findSessionFile(sessionId: string): Promise<string | undefined> {
		this.lookups += 1;
		this.lookupStarted.resolve();
		await this.lookupGate.promise;
		return super.findSessionFile(sessionId);
	}
}

describe("opening a session from the catalogue", () => {
	let fixture: HydratedSessionFixture;

	before(async () => {
		fixture = await startHydratedSessionFixture();
	});

	after(async () => {
		await fixture.close();
	});

	it("hydrates a catalogued session and counts it as active", async () => {
		const { result } = await fixture.client.subscribe(sessionUri(fixture.sessionId));
		const state = result.snapshot?.state as SessionState;

		assert.equal(state.lifecycle, SessionLifecycle.Ready);
		assert.equal(state.chats.length, 1);
		assert.equal(state.defaultChat, chatUri(fixture.sessionId));
		assert.deepEqual(state.workingDirectories, [pathToFileUri(fixture.workspace)]);
		assertValid("state", "SessionState", state);
		assert.equal((fixture.host.store.get(ROOT_CHANNEL) as RootState).activeSessions, 1);
	});

	it("rebuilds the transcript onto the chat channel", async () => {
		const { result } = await fixture.client.subscribe(chatUri(fixture.sessionId));
		const chat = must(result.snapshot).state as ChatState;

		assert.equal(chat.turns.length, 2);
		assert.equal(chat.turns[0]?.message.text, "Read note.txt");
		assert.equal(chat.turns[0]?.state, TurnState.Complete);
		assertValid("state", "ChatState", chat);
	});

	it("pairs each tool call with the result that followed it", async () => {
		const { result } = await fixture.client.subscribe(chatUri(fixture.sessionId));
		const parts = must((must(result.snapshot).state as ChatState).turns[0]).responseParts;

		assert.deepEqual(
			parts.map((part) => part.kind),
			[ResponsePartKind.Reasoning, ResponsePartKind.ToolCall, ResponsePartKind.Markdown],
		);
		const toolCall = (
			parts[1] as {
				toolCall: { status: string; toolName?: string; content?: { type: string; text?: string }[] };
			}
		).toolCall;
		assert.equal(toolCall.status, ToolCallStatus.Completed);
		assert.equal(toolCall.toolName, "read");
		assert.deepEqual(toolCall.content, [{ type: "text", text: "ALPHA" }]);
	});

	it("still answers NotFound for a session that really does not exist", async () => {
		const error = await fixture.client.subscribe(sessionUri(randomUUID())).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32008);
	});

	it("restores images stored in pi user messages", async () => {
		const fresh = await startHydratedSessionFixture({ includeImage: true });
		try {
			const { result } = await fresh.client.subscribe(chatUri(fresh.sessionId));
			const chat = must(result.snapshot).state as ChatState;

			assert.deepEqual(chat.turns[0]?.message.attachments, [
				{
					type: MessageAttachmentKind.EmbeddedResource,
					label: "Image 1",
					displayKind: "image",
					data: ONE_PIXEL_PNG,
					contentType: "image/png",
				},
			]);
			assertValid("state", "ChatState", chat);
		} finally {
			await fresh.close();
		}
	});

	it("hydrates from either half of the pair", async () => {
		const fresh = await startHydratedSessionFixture();
		try {
			const { result } = await fresh.client.subscribe(chatUri(fresh.sessionId));
			assert.ok(result.snapshot);
			assert.ok(fresh.host.store.has(sessionUri(fresh.sessionId)), "the session must load alongside its chat");
		} finally {
			await fresh.close();
		}
	});

	it("coalesces concurrent session and chat hydration", async () => {
		const source = await startHydratedSessionFixture();
		const catalogue = new BlockingCatalogue(source.root);
		try {
			const host = new AhpHost();
			const live = new Set<string>();
			const adopted: string[] = [];
			const hydrator = new SessionHydrator({
				host,
				catalogue,
				isLive: (session) => live.has(session),
				isDisposing: () => false,
				adopt: (session) => {
					live.add(session.uri);
					adopted.push(session.uri);
				},
			});
			const session = sessionUri(source.sessionId);
			const chat = chatUri(source.sessionId);

			const first = hydrator.hydrate(session);
			await catalogue.lookupStarted.promise;
			const second = hydrator.hydrate(chat);
			catalogue.lookupGate.resolve();

			assert.deepEqual(await Promise.all([first, second]), [true, true]);
			assert.equal(catalogue.lookups, 1);
			assert.deepEqual(adopted, [session]);
			assert.equal(host.store.has(session), true);
			assert.equal(host.store.has(chat), true);
		} finally {
			catalogue.lookupGate.resolve();
			await source.close();
		}
	});
});

it("preserves catalogue modifiedAt when a disk session becomes a live overlay", async () => {
	const fixture = await startHydratedSessionFixture();
	try {
		const file = must(await new PiSessionCatalogue(fixture.root).findSessionFile(fixture.sessionId));
		const timestamp = new Date("2025-06-01T12:00:00.000Z");
		utimesSync(file, timestamp, timestamp);
		const before = await fixture.client.request("listSessions", { channel: ROOT_CHANNEL });
		assert.equal(before.items[0]?.modifiedAt, timestamp.toISOString());
		const { result } = await fixture.client.subscribe(chatUri(fixture.sessionId));
		assert.equal((must(result.snapshot).state as ChatState).modifiedAt, timestamp.toISOString());
		const after = await fixture.client.request("listSessions", { channel: ROOT_CHANNEL });
		assert.equal(after.items.length, 1);
		assert.equal(after.items[0]?.modifiedAt, timestamp.toISOString());
	} finally {
		await fixture.close();
	}
});
