import { must, turnError } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";
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
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	ActionType,
	type ChatState,
	MessageKind,
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
import { assertValid } from "./support/schema.ts";

const LIVE = process.env.PI_AHP_LIVE === "1";
const TURN_TIMEOUT_MS = 180_000;

/**
 * Printed by every offline run, so it is the suite's real documentation.
 *
 * `pnpm test` runs the whole directory instead of filtering this file out: a
 * skipped test that says how to unskip itself is discoverable at the moment it
 * is relevant, which a note in a file nobody opens is not.
 */
const SKIP_REASON = "needs a real model — run: PI_AHP_LIVE=1 node --test test/live-turn.test.ts";

describe("live turn", { skip: LIVE ? false : SKIP_REASON }, () => {
	let root: string;
	let workspace: string;
	let server: RunningServer;
	let client: AhpClient;
	let built: Awaited<ReturnType<typeof createPiHost>>;
	let host: Awaited<ReturnType<typeof createPiHost>>["host"];
	let sessions: Awaited<ReturnType<typeof createPiHost>>["sessions"];
	let previousAgentDir: string | undefined;

	before(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-ahp-live-"));
		workspace = join(root, "workspace");
		const agentDir = join(root, "agent");
		mkdirSync(workspace);
		mkdirSync(agentDir);
		writeFileSync(join(workspace, "note.txt"), "ALPHA BETA GAMMA\n");

		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const sourceAgentDir = previousAgentDir ?? join(homedir(), ".pi", "agent");
		// Keep the user's configured providers available without letting the test
		// catalogue or write into their durable sessions. Large package caches are
		// linked read-only-in-practice; ordinary resource loading does not mutate them.
		if (existsSync(sourceAgentDir)) {
			for (const entry of readdirSync(sourceAgentDir, { withFileTypes: true })) {
				if (entry.name === "sessions") continue;
				const source = join(sourceAgentDir, entry.name);
				const destination = join(agentDir, entry.name);
				if (entry.isDirectory()) symlinkSync(source, destination, "dir");
				else copyFileSync(source, destination);
			}
		}
		process.env.PI_CODING_AGENT_DIR = agentDir;

		built = await createPiHost({
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
		built?.terminals.shutdown();
		await built?.watches.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	function assertSessionState(sessionChannel: string, chatChannel: string): void {
		assertValid("state", "SessionState", host.store.get(sessionChannel));
		assertValid("state", "ChatState", host.store.get(chatChannel));
	}

	it("advertises the models pi actually has credentials for", () => {
		const state = host.store.get("ahp-root://") as { agents: { models: unknown[] }[] };
		assert.equal(state.agents.length, 1);
		assert.ok(must(state.agents[0]).models.length > 0, "no models available — is ~/.pi/agent/auth.json populated?");
		assertValid("state", "RootState", state);
	});

	it("streams a real assistant reply into chat state", async () => {
		const id = randomUUID();
		const sessionChannel = sessionUri(id);
		const chatChannel = chatUri(id);

		await client.request("createSession", { channel: sessionChannel });
		await client.subscribe(sessionChannel);
		await client.subscribe(chatChannel);
		await eventually(
			"the live session to become ready",
			() => (host.store.get(sessionChannel) as SessionState).lifecycle === SessionLifecycle.Ready,
			{ timeoutMs: 30_000, intervalMs: 50 },
		);

		client.dispatch(chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "live-1",
			startedAt: new Date().toISOString(),
			message: { text: "Reply with exactly the word: PONG", origin: { kind: MessageKind.User } },
		});

		await eventually("the live turn to complete", () => (host.store.get(chatChannel) as ChatState).turns.length === 1, {
			timeoutMs: TURN_TIMEOUT_MS,
			intervalMs: 50,
		});

		const state = host.store.get(chatChannel) as ChatState;
		assertSessionState(sessionChannel, chatChannel);
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

		const live = sessions.get(sessionChannel);
		assert.ok(live, "session should still be live");
		assert.equal(live.sessionId, id);
		const file = live.sessionManager.getSessionFile();
		assert.ok(file, "pi should have written a session file for a real turn");
		const contents = readFileSync(file, "utf8");
		assert.match(contents, /Reply with exactly the word: PONG/);
		assert.match(contents, new RegExp(`"id"\\s*:\\s*"${id}"`));
	});

	it("drives a real tool call to completion without confirmation", async () => {
		const id = randomUUID();
		const sessionChannel = sessionUri(id);
		const chatChannel = chatUri(id);

		await client.request("createSession", { channel: sessionChannel });
		await client.subscribe(chatChannel);
		await eventually(
			"the live session to become ready",
			() => (host.store.get(sessionChannel) as SessionState).lifecycle === SessionLifecycle.Ready,
			{ timeoutMs: 30_000, intervalMs: 50 },
		);

		client.dispatch(chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId: "live-tool",
			startedAt: new Date().toISOString(),
			message: {
				text: "Read note.txt in the working directory and reply with its exact contents.",
				origin: { kind: MessageKind.User },
			},
		});

		await eventually("the live turn to complete", () => (host.store.get(chatChannel) as ChatState).turns.length === 1, {
			timeoutMs: TURN_TIMEOUT_MS,
			intervalMs: 50,
		});

		assertSessionState(sessionChannel, chatChannel);
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
});
