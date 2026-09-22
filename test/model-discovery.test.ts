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
import { modelSelectionId } from "../src/pi/models.ts";
import { persistentSessionStorage } from "./support/session-storage.ts";

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
		const selection = {
			id: modelSelectionId({ provider: "fixture", id: "fixture-model" }),
			config: { thinkingLevel: "max" },
		};
		const sessionRoot = join(agentDir, "sessions");
		const { host, sessions } = await createPiHost({
			workingDirectory: workspace,
			sessionStorage: persistentSessionStorage(sessionRoot),
			deleteFile: () => ({ ok: true }),
			createBackend: () => ({
				subscribe: () => () => {},
				prompt: async () => {},
				steer: async () => {},
				abort: async () => {},
				currentSelection: () => selection,
			}),
		});
		const rootState = host.store.get("ahp-root://") as RootState;
		const advertised = Object.fromEntries(
			(rootState.agents[0]?.models ?? []).map((model) => [
				model.id,
				{ provider: model.provider, piProvider: model._meta?.piProvider },
			]),
		);
		assert.deepEqual(advertised, {
			"fixture/other-model": { provider: "pi", piProvider: "fixture" },
			"fixture/fixture-model": { provider: "pi", piProvider: "fixture" },
		});

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

it("resolves stale and provider-qualified model selections safely", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-model-identity-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(workspace);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "fixture-one", defaultModel: "shared-model" }),
	);
	writeFileSync(
		join(agentDir, "extensions", "providers.js"),
		`export default function (pi) {
	for (const name of ["fixture-one", "fixture-two"]) {
		pi.registerProvider(name, {
			name,
			baseUrl: "https://example.invalid",
			apiKey: "fixture-key",
			api: "openai-completions",
			models: [{
				id: "shared-model",
				name: "Shared Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			}],
		});
	}
}
`,
	);

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let backend: InProcessPiBackend | undefined;
	try {
		backend = await InProcessPiBackend.create({
			cwd: workspace,
			sessionManager: SessionManager.inMemory(workspace),
		});
		assert.equal(backend.session.model?.provider, "fixture-one");
		const before = backend.currentSelection();
		await backend.selectModel({ id: "missing/stale-model", config: { thinkingLevel: "high" } });
		assert.deepEqual(backend.currentSelection(), before, "a stale client choice must not change the active model");

		const second = modelSelectionId({ provider: "fixture-two", id: "shared-model" });
		await backend.selectModel({ id: second });
		assert.equal(backend.session.model?.provider, "fixture-two");

		const supportedLevel = backend.session.thinkingLevel;
		await backend.selectModel({ id: second, config: { thinkingLevel: "high" } });
		assert.equal(backend.session.thinkingLevel, supportedLevel, "an unsupported thinking level must be ignored");
	} finally {
		backend?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
