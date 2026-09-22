/**
 * Live end-to-end smoke: a real client, a real model, the whole stack.
 *
 * Opt-in — needs a configured pi model provider and network access. Run with:
 *
 *     nix develop -c env \
 *       PI_AHP_LIVE_SETTINGS=/absolute/path/to/settings.json \
 *       PI_AHP_LIVE_AUTH=/absolute/path/to/auth.json \
 *       pnpm exec node --test test/live-turn.test.ts
 *
 * The dedicated settings file must explicitly choose a default model and
 * thinking level. Provider packages listed there are installed into the
 * temporary Pi directory when missing; pin their versions for repeatability.
 *
 * Everything else in the suite is deterministic and offline; this exists to
 * catch the one thing scripted backends cannot: that pi's *actual* event
 * stream maps onto the protocol the way the mapper assumes.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAgentSessionServices, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	MessageKind,
	type ModelSelection,
	ResponsePartKind,
	type RootState,
	SessionLifecycle,
	type SessionState,
	SUPPORTED_PROTOCOL_VERSIONS,
	ToolCallStatus,
	type Turn,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { createPiHost } from "../src/host/pi-host.ts";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";
import { THINKING_CONFIG_KEY } from "../src/pi/models.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { must, turnError } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";
import { assertValid } from "./support/schema.ts";

const LIVE_SETTINGS = process.env.PI_AHP_LIVE_SETTINGS?.trim();
const LIVE_AUTH = process.env.PI_AHP_LIVE_AUTH?.trim();
const LIVE = LIVE_SETTINGS !== undefined || LIVE_AUTH !== undefined;
const TURN_TIMEOUT_MS = 180_000;

/**
 * Printed by every offline run, so it is the suite's real documentation.
 *
 * `pnpm test` runs the whole directory instead of filtering this file out: a
 * skipped test that says how to unskip itself is discoverable at the moment it
 * is relevant, which a note in a file nobody opens is not.
 */
const SKIP_REASON = "needs a real model — set PI_AHP_LIVE_SETTINGS and PI_AHP_LIVE_AUTH";

interface LiveSettingsFile {
	readonly defaultProvider?: unknown;
	readonly defaultModel?: unknown;
	readonly defaultThinkingLevel?: unknown;
	readonly modelThinkingLevels?: Record<string, unknown>;
}

describe("live turn", { skip: LIVE ? false : SKIP_REASON }, () => {
	let root: string;
	let workspace: string;
	let server: RunningServer;
	let client: AhpClient;
	let built: Awaited<ReturnType<typeof createPiHost>>;
	let host: Awaited<ReturnType<typeof createPiHost>>["host"];
	let sessions: Awaited<ReturnType<typeof createPiHost>>["sessions"];
	let selection: ModelSelection;
	let thinking: string;
	let previousAgentDir: string | undefined;

	before(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-ahp-live-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		assert.ok(LIVE_SETTINGS, "PI_AHP_LIVE_SETTINGS must name a dedicated settings.json");
		assert.ok(LIVE_AUTH, "PI_AHP_LIVE_AUTH must name a dedicated auth.json");
		const settingsPath = resolve(LIVE_SETTINGS);
		const authPath = resolve(LIVE_AUTH);
		assert.ok(existsSync(settingsPath), `live-test settings file does not exist: ${settingsPath}`);
		assert.ok(existsSync(authPath), `live-test auth file does not exist: ${authPath}`);
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as LiveSettingsFile;
		assert.ok(
			typeof settings.defaultProvider === "string" && settings.defaultProvider.length > 0,
			"live-test settings must explicitly set defaultProvider",
		);
		assert.ok(
			typeof settings.defaultModel === "string" && settings.defaultModel.length > 0,
			"live-test settings must explicitly set defaultModel",
		);
		const modelId = `${settings.defaultProvider}/${settings.defaultModel}`;
		const perModelThinking = settings.modelThinkingLevels?.[modelId];
		const configuredThinking = perModelThinking ?? settings.defaultThinkingLevel;
		assert.ok(
			typeof configuredThinking === "string" && configuredThinking.length > 0,
			"live-test settings must explicitly set a thinking level",
		);
		thinking = configuredThinking;
		selection = { id: modelId, config: { [THINKING_CONFIG_KEY]: thinking } };
		workspace = join(root, "workspace");
		const agentDir = join(root, "agent");
		mkdirSync(workspace);
		mkdirSync(agentDir);
		writeFileSync(join(workspace, "note.txt"), "ALPHA BETA GAMMA\n");

		// These explicit files are the only profile data imported. Package installs,
		// token refreshes, sessions, and any settings writes stay in the temporary
		// profile and disappear with it.
		copyFileSync(settingsPath, join(agentDir, "settings.json"));
		copyFileSync(authPath, join(agentDir, "auth.json"));
		process.env.PI_CODING_AGENT_DIR = agentDir;

		// SDK startup is deliberately cache-only. A clean live profile has no
		// models-store yet, so refresh dynamic provider catalogues explicitly;
		// the resulting cache remains inside this temporary directory.
		const discovery = await createAgentSessionServices({
			cwd: workspace,
			settingsManager: SettingsManager.create(workspace, undefined, { projectTrusted: false }),
		});
		assert.deepEqual(discovery.diagnostics, [], "live-test provider extension failed to load");
		const refreshed = await discovery.modelRuntime.refresh({
			allowNetwork: true,
			providers: [settings.defaultProvider],
		});
		assert.equal(refreshed.aborted, false, "live-test model discovery was aborted");
		assert.equal(
			refreshed.errors.size,
			0,
			`live-test model discovery failed: ${[...refreshed.errors].map(([provider, error]) => `${provider}: ${error.message}`).join("; ")}`,
		);

		built = await createPiHost({
			serverInfo: { name: "pi-ahp", version: "live-test" },
			workingDirectory: workspace,
			modelRuntime: discovery.modelRuntime,
			projectTrustPolicy: "never",
			createBackend: async (session) => {
				const backend = await InProcessPiBackend.create({
					cwd: session.workingDirectory,
					sessionManager: session.sessionManager,
					projectTrustPolicy: "never",
				});
				assert.deepEqual(
					backend.currentSelection(),
					selection,
					"Pi did not initialize the explicitly requested live-test model",
				);
				return backend;
			},
		});
		host = built.host;
		sessions = built.sessions;
		const rootState = host.store.get("ahp-root://") as RootState;
		assertValid("state", "RootState", rootState);
		const available = rootState.agents.flatMap((agent) => agent.models);
		const requested = available.find((model) => model.id === selection.id);
		assert.ok(
			requested,
			`configured live-test model ${selection.id} is unavailable; available models: ${available.map((model) => model.id).join(", ")}`,
		);
		const configuredLevels = requested.configSchema?.properties?.[THINKING_CONFIG_KEY]?.enum?.filter(
			(level): level is string => typeof level === "string",
		);
		if (configuredLevels && configuredLevels.length > 0) {
			assert.ok(
				configuredLevels.includes(thinking),
				`${selection.id} does not support thinking=${thinking}; choose one of: ${configuredLevels.join(", ")}`,
			);
		} else {
			assert.equal(thinking, "off", `${selection.id} does not advertise configurable thinking; use off`);
		}
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
		try {
			await client?.shutdown();
			await server?.close();
			built?.terminals.shutdown();
			await Promise.all([built?.changesets.dispose(), built?.watches.dispose()]);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	function assertSessionState(sessionChannel: string, chatChannel: string): void {
		assertValid("state", "SessionState", host.store.get(sessionChannel));
		assertValid("state", "ChatState", host.store.get(chatChannel));
	}

	function assertPersistedSelection(sessionChannel: string): void {
		const context = must(sessions.get(sessionChannel)).sessionManager.buildSessionContext();
		const model = must(context.model);
		assert.equal(`${model.provider}/${model.modelId}`, selection.id);
		assert.equal(context.thinkingLevel, thinking);
	}

	async function runLiveTurn(
		turnId: string,
		text: string,
	): Promise<{ id: string; sessionChannel: string; turn: Turn }> {
		const id = randomUUID();
		const sessionChannel = sessionUri(id);
		const chatChannel = chatUri(id);
		await client.request("createSession", { channel: sessionChannel });
		await client.subscribe(sessionChannel);
		await client.subscribe(chatChannel);
		await eventually(
			"the live session backend to settle",
			() => (host.store.get(sessionChannel) as SessionState).lifecycle !== SessionLifecycle.Creating,
			{ timeoutMs: 30_000, intervalMs: 50 },
		);
		const sessionState = host.store.get(sessionChannel) as SessionState;
		assert.equal(sessionState.lifecycle, SessionLifecycle.Ready, sessionState.creationError?.message);
		client.dispatch(chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: new Date().toISOString(),
			message: { text, origin: { kind: MessageKind.User }, model: selection },
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
		assertPersistedSelection(sessionChannel);
		return { id, sessionChannel, turn };
	}

	it("streams a real assistant reply into chat state", async () => {
		const { id, sessionChannel, turn } = await runLiveTurn("live-1", "Reply with exactly the word: PONG");

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
		const { turn } = await runLiveTurn(
			"live-tool",
			"Read note.txt in the working directory and reply with its exact contents.",
		);

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
