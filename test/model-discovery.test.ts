import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatState, RootState } from "@microsoft/agent-host-protocol";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { createPiHost } from "../src/host/pi-host.ts";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";

it("advertises extension models and uses pi's configured default", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-model-discovery-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(workspace);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model", defaultThinkingLevel: "max" }),
	);
	writeFileSync(
		join(agentDir, "extensions", "provider.js"),
		`export default function (pi) {
	pi.registerProvider("fixture", {
		name: "Fixture",
		baseUrl: "https://example.invalid",
		apiKey: "fixture-key",
		api: "openai-completions",
		models: [{
			id: "other-model",
			name: "Other Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		}, {
			id: "fixture-model",
			name: "Fixture Model",
			reasoning: true,
			thinkingLevelMap: { max: "max" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		}],
	});
}
`,
	);

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let backend: InProcessPiBackend | undefined;
	try {
		const selection = { id: "fixture-model", config: { thinkingLevel: "max" } };
		const { host, sessions } = await createPiHost({
			workingDirectory: workspace,
			deleteFile: () => {},
			createBackend: () => ({
				subscribe: () => () => {},
				prompt: async () => {},
				steer: async () => {},
				abort: async () => {},
				currentSelection: () => selection,
			}),
		});
		const rootState = host.store.get("ahp-root://") as RootState;
		assert.deepEqual(
			rootState.agents[0]?.models.map((model) => ({
				id: model.id,
				provider: model.provider,
				piProvider: model._meta?.piProvider,
			})),
			[
				{ id: "other-model", provider: "pi", piProvider: "fixture" },
				{ id: "fixture-model", provider: "pi", piProvider: "fixture" },
			],
		);

		const id = "default-selection";
		sessions.create({ channel: sessionUri(id) });
		assert.deepEqual((host.store.get(chatUri(id)) as ChatState).draft?.model, selection);

		backend = await InProcessPiBackend.create({
			cwd: workspace,
			sessionManager: SessionManager.inMemory(workspace),
		});
		assert.deepEqual(
			backend.session.model && { id: backend.session.model.id, provider: backend.session.model.provider },
			{ id: "fixture-model", provider: "fixture" },
		);
		assert.equal(backend.session.thinkingLevel, "max");
		await sessions.dispose(sessionUri(id));
	} finally {
		backend?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
