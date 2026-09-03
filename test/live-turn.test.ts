import { must, turnError } from "./harness.ts";
/**
 * Live end-to-end smoke: a real client, a real model, the whole stack.
 *
 * Opt-in — needs credentials in `~/.pi/agent/auth.json` and network. Run with:
 *
 *     nix develop -c env PI_AHP_LIVE=1 node --test test/live-turn.test.ts
 *
 * Everything else in the suite is deterministic and offline; this exists to
 * catch the one thing scripted backends cannot: that pi's *actual* event
 * stream maps onto the protocol the way the mapper assumes.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	ActionType,
	type ChatState,
	ResponsePartKind,
	SessionLifecycle,
	type SessionState,
	SUPPORTED_PROTOCOL_VERSIONS,
	ToolCallStatus,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { createPiHost } from "../src/host/pi-host.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { checkSchema } from "./support/schema.ts";

const LIVE = process.env.PI_AHP_LIVE === "1";
const TURN_TIMEOUT_MS = 180_000;

async function waitFor(predicate: () => boolean, timeoutMs = TURN_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("condition never became true");
		}
		await new Promise((resolve) => {
			const handle = setTimeout(resolve, 50);
			handle.unref?.();
		});
	}
}

/**
 * Printed by every offline run, so it is the suite's real documentation.
 *
 * `npm test` runs the whole directory instead of filtering this file out: a
 * skipped test that says how to unskip itself is discoverable at the moment it
 * is relevant, which a note in a file nobody opens is not.
 */
const SKIP_REASON = "needs a real model — run: PI_AHP_LIVE=1 node --test test/live-turn.test.ts";

describe("live turn", { skip: LIVE ? false : SKIP_REASON }, () => {
	let workspace: string;
	let server: RunningServer;
	let client: AhpClient;
	let host: Awaited<ReturnType<typeof createPiHost>>["host"];
	let sessions: Awaited<ReturnType<typeof createPiHost>>["sessions"];

	before(async () => {
		workspace = mkdtempSync(join(tmpdir(), "pi-ahp-live-"));
		writeFileSync(join(workspace, "note.txt"), "ALPHA BETA GAMMA\n");

		const built = await createPiHost({
			serverInfo: { name: "pi-ahp", version: "live-test" },
			workingDirectory: workspace,
		});
		host = built.host;
		sessions = built.sessions;
		server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
		client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
		await client.initialize({
			clientId: "live-client",
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: ["ahp-root://"],
		});
	});

	after(async () => {
		await client?.shutdown();
		await server?.close();
		rmSync(workspace, { recursive: true, force: true });
	});

	it("advertises the models pi actually has credentials for", () => {
		const root = host.store.get("ahp-root://") as { agents: { models: unknown[] }[] };
		assert.equal(root.agents.length, 1);
		assert.ok(must(root.agents[0]).models.length > 0, "no models available — is ~/.pi/agent/auth.json populated?");
	});

	it("streams a real assistant reply into chat state", async () => {
		const id = randomUUID();
		const sessionChannel = sessionUri(id);
		const chatChannel = chatUri(id);

		await client.request("createSession", { channel: sessionChannel } as never);
		await client.subscribe(sessionChannel);
		await client.subscribe(chatChannel);
		await waitFor(() => (host.store.get(sessionChannel) as SessionState).lifecycle === SessionLifecycle.Ready, 30_000);

		client.dispatch(chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "live-1",
			startedAt: new Date().toISOString(),
			message: { text: "Reply with exactly the word: PONG", origin: { kind: "user" } },
		} as never);

		await waitFor(() => (host.store.get(chatChannel) as ChatState).turns.length === 1);

		const state = host.store.get(chatChannel) as ChatState;
		const turn = must(state.turns[0]);
		assert.equal(turn.state, TurnState.Complete, `turn failed: ${turnError(turn)?.message ?? ""}`);
		assert.equal(state.activeTurn, undefined);

		const text = turn.responseParts
			.filter((part) => part.kind === ResponsePartKind.Markdown)
			.map((part) => (part as { content: string }).content)
			.join("");
		assert.match(text, /PONG/i);
		// Usage only arrives if `message_end` carried it, which is the path the
		// mapper reads.
		assert.ok(turn.usage?.outputTokens !== undefined, "no usage reported");
	});

	it("drives a real tool call to completion without confirmation", async () => {
		const id = randomUUID();
		const sessionChannel = sessionUri(id);
		const chatChannel = chatUri(id);

		await client.request("createSession", { channel: sessionChannel } as never);
		await client.subscribe(chatChannel);
		await waitFor(() => (host.store.get(sessionChannel) as SessionState).lifecycle === SessionLifecycle.Ready, 30_000);

		client.dispatch(chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "live-tool",
			startedAt: new Date().toISOString(),
			message: {
				text: "Read note.txt in the working directory and reply with its exact contents.",
				origin: { kind: "user" },
			},
		} as never);

		await waitFor(() => (host.store.get(chatChannel) as ChatState).turns.length === 1);

		const turn = must((host.store.get(chatChannel) as ChatState).turns[0]);
		assert.equal(turn.state, TurnState.Complete, `turn failed: ${turnError(turn)?.message ?? ""}`);

		const toolCalls = turn.responseParts.filter((part) => part.kind === ResponsePartKind.ToolCall);
		assert.ok(toolCalls.length > 0, "expected at least one tool call");
		for (const part of toolCalls) {
			const toolCall = (part as { toolCall: { status: string; toolName: string } }).toolCall;
			// Auto-confirmed calls go straight to running, so every one should
			// have reached a terminal state by the time the turn closed.
			assert.ok(
				toolCall.status === ToolCallStatus.Completed || toolCall.status === ToolCallStatus.Cancelled,
				`tool ${toolCall.toolName} ended in ${toolCall.status}`,
			);
		}

		const text = turn.responseParts
			.filter((part) => part.kind === ResponsePartKind.Markdown)
			.map((part) => (part as { content: string }).content)
			.join("");
		assert.match(text, /ALPHA BETA GAMMA/);
	});

	it("persists the turn into pi's own session file", async () => {
		const id = randomUUID();
		const sessionChannel = sessionUri(id);
		const chatChannel = chatUri(id);

		await client.request("createSession", { channel: sessionChannel } as never);
		await client.subscribe(chatChannel);
		await waitFor(() => (host.store.get(sessionChannel) as SessionState).lifecycle === SessionLifecycle.Ready, 30_000);

		client.dispatch(chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "live-persist",
			startedAt: new Date().toISOString(),
			message: { text: "Say OK and nothing else.", origin: { kind: "user" } },
		} as never);
		await waitFor(() => (host.store.get(chatChannel) as ChatState).turns.length === 1);

		const live = sessions.get(sessionChannel);
		assert.ok(live, "session should still be live");
		// The AHP session uuid *is* pi's session id, so the conversation is
		// resumable from pi's own CLI with no mapping table in between.
		assert.equal(live.sessionId, id);

		const file = live.sessionManager.getSessionFile();
		assert.ok(file, "pi should have written a session file for a real turn");
		const contents = readFileSync(file, "utf8");
		assert.match(contents, /Say OK and nothing else/);
		assert.match(contents, new RegExp(`"id"\\s*:\\s*"${id}"`));
	});

	it("emits only schema-conforming state", () => {
		for (const uri of ["ahp-root://"]) {
			const state = host.store.get(uri);
			assert.equal(checkSchema("state", "RootState", state), undefined);
		}
	});
});
