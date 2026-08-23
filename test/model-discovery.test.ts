import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RootState } from "@microsoft/agent-host-protocol";
import { createPiHost } from "../src/host/pi-host.ts";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";

it("loads extension-provided models before advertising or creating a session", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-model-discovery-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(workspace);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }),
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
			id: "fixture-model",
			name: "Fixture Model",
			reasoning: false,
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
		const { host } = await createPiHost({ workingDirectory: workspace });
		const rootState = host.store.get("ahp-root://") as RootState;
		assert.deepEqual(
			rootState.agents[0]?.models.map((model) => ({
				id: model.id,
				provider: model.provider,
				piProvider: model._meta?.piProvider,
			})),
			[{ id: "fixture-model", provider: "pi", piProvider: "fixture" }],
		);

		backend = await InProcessPiBackend.create({
			cwd: workspace,
			sessionManager: SessionManager.inMemory(workspace),
		});
		assert.deepEqual(
			backend.session.model && { id: backend.session.model.id, provider: backend.session.model.provider },
			{ id: "fixture-model", provider: "fixture" },
		);
	} finally {
		backend?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
