/** Operations performed after a durable pi session has been hydrated. */

import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	AhpErrorCodes,
	type ChatState,
	MessageKind,
	type SessionState,
	SessionStatus,
} from "@microsoft/agent-host-protocol";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { PiSessionCatalogue } from "../src/pi/session-catalogue.ts";
import { expectRpcError, must } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";
import { type HydratedSessionFixture, startHydratedSessionFixture } from "./support/hydrated-session.ts";

describe("read state after hydration", () => {
	let fixture: HydratedSessionFixture;

	before(async () => {
		fixture = await startHydratedSessionFixture();
	});

	after(async () => {
		await fixture.close();
	});

	it("reports every catalogue entry as read", async () => {
		const list = await fixture.client.request("listSessions", { channel: ROOT_CHANNEL });
		assert.ok((must(list.items[0]).status & SessionStatus.IsRead) !== 0);
	});

	it("reports a hydrated session as read", async () => {
		const { result } = await fixture.client.subscribe(sessionUri(fixture.sessionId));
		const state = result.snapshot?.state as SessionState;
		assert.ok((state.status & SessionStatus.IsRead) !== 0);
	});

	it("keeps session-owned read state when a starting turn marks the chat unread", async () => {
		const chat = chatUri(fixture.sessionId);
		await fixture.client.subscribe(chat);
		const before = (fixture.host.store.get(chat) as ChatState).status;
		assert.ok((before & SessionStatus.IsRead) !== 0);

		fixture.client.dispatch(chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "t-unread",
			startedAt: new Date().toISOString(),
			message: { text: "hi", origin: { kind: MessageKind.User } },
		});
		await fixture.client.ping();

		assert.equal((fixture.host.store.get(chat) as ChatState).status & SessionStatus.IsRead, 0);
		const session = fixture.host.store.get(sessionUri(fixture.sessionId)) as SessionState;
		assert.notEqual(session.status & SessionStatus.IsRead, 0);
		const list = await fixture.client.request("listSessions", { channel: ROOT_CHANNEL });
		assert.notEqual(
			must(list.items.find((item) => item.resource === sessionUri(fixture.sessionId))).status & SessionStatus.IsRead,
			0,
		);
	});
});

describe("disposing a hydrated session", () => {
	it("removes it from the catalogue and deletes the file", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			const uri = sessionUri(fixture.sessionId);
			await fixture.client.subscribe(uri);
			await fixture.client.request("disposeSession", { channel: uri });

			assert.equal(fixture.host.store.has(uri), false);
			assert.equal(fixture.deletedFiles.length, 1);
			const list = await fixture.client.request("listSessions", { channel: ROOT_CHANNEL });
			assert.equal(list.items.length, 0, "a disposed session must not come back on the next listing");
		} finally {
			await fixture.close();
		}
	});

	it("prevents an unloaded session from being recreated or hydrated during deletion", async () => {
		let deletionStarted = false;
		let finishDeletion!: (result: { ok: boolean }) => void;
		const deletion = new Promise<{ ok: boolean }>((resolve) => {
			finishDeletion = resolve;
		});
		const fixture = await startHydratedSessionFixture({
			deleteFile: async (path) => {
				deletionStarted = true;
				const result = await deletion;
				if (result.ok) rmSync(path, { force: true });
				return result;
			},
		});
		try {
			const uri = sessionUri(fixture.sessionId);
			const disposing = fixture.client.request("disposeSession", { channel: uri });
			await eventually("durable deletion to start", () => deletionStarted);

			await expectRpcError(fixture.client.subscribe(uri), AhpErrorCodes.NotFound);
			await expectRpcError(
				fixture.client.request("createSession", { channel: uri }),
				AhpErrorCodes.SessionAlreadyExists,
			);

			finishDeletion({ ok: true });
			await disposing;
			assert.equal(fixture.deletedFiles.length, 1);
			assert.equal(existsSync(must(fixture.deletedFiles[0], "deleted session path")), false);
			const listed = await fixture.client.request("listSessions", { channel: ROOT_CHANNEL });
			assert.equal(
				listed.items.some((item) => item.resource === uri),
				false,
			);
		} finally {
			finishDeletion({ ok: false });
			await fixture.close();
		}
	});
});

describe("resuming a hydrated session", () => {
	it("starts an agent on the first turn and prompts it", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			const chat = chatUri(fixture.sessionId);
			await fixture.client.subscribe(chat);
			assert.deepEqual(fixture.backend.prompts, [], "browsing history must not start an agent");

			fixture.client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "t-resume",
				startedAt: new Date().toISOString(),
				message: { text: "continue please", origin: { kind: MessageKind.User } },
			});

			await eventually("the resumed prompt to reach the backend", () => fixture.backend.prompts.length === 1);
			assert.deepEqual(fixture.backend.prompts, ["continue please"]);
			await eventually(
				"the resumed turn to settle",
				() => (fixture.host.store.get(chat) as ChatState).activeTurn === undefined,
			);
		} finally {
			await fixture.close();
		}
	});

	it("resumes onto the existing transcript rather than a fresh one", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			const chat = chatUri(fixture.sessionId);
			await fixture.client.subscribe(chat);
			const before = (fixture.host.store.get(chat) as ChatState).turns.length;

			fixture.client.dispatch(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: "t-append",
				startedAt: new Date().toISOString(),
				message: { text: "and again", origin: { kind: MessageKind.User } },
			});
			await eventually("the resumed prompt to reach the backend", () => fixture.backend.prompts.length === 1);
			await eventually(
				"the resumed turn to append after history",
				() => (fixture.host.store.get(chat) as ChatState).turns.length === before + 1,
			);

			const turns = (fixture.host.store.get(chat) as ChatState).turns;
			assert.equal(turns[0]?.message.text, "Read note.txt");
			assert.equal(turns.at(-1)?.message.text, "and again");
		} finally {
			await fixture.close();
		}
	});
});

describe("model selection on a hydrated session", () => {
	it("seeds the picker from the model the session was using", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			const { result } = await fixture.client.subscribe(chatUri(fixture.sessionId));
			const draft = (must(result.snapshot).state as ChatState).draft;
			assert.equal(draft?.model?.id, "fixture/test-model");
		} finally {
			await fixture.close();
		}
	});
});

describe("renaming a hydrated session", () => {
	it("persists the name into the session file", async () => {
		const fixture = await startHydratedSessionFixture();
		try {
			const uri = sessionUri(fixture.sessionId);
			await fixture.client.subscribe(uri);
			fixture.client.dispatch(uri, { type: ActionType.SessionTitleChanged, title: "Archived work" });
			await fixture.client.ping();
			assert.equal((fixture.host.store.get(uri) as { title?: string }).title, "Archived work");

			const file = await new PiSessionCatalogue(fixture.root).findSessionFile(fixture.sessionId);
			assert.ok(file);
			assert.equal(SessionManager.open(file).getSessionName(), "Archived work");
		} finally {
			await fixture.close();
		}
	});
});
