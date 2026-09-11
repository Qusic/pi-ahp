/**
 * Mapping pi's model catalogue onto protocol agent/model descriptions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	buildAgentInfo,
	findModelBySelectionId,
	modelSelectionId,
	supportedThinkingLevels,
	THINKING_CONFIG_KEY,
	toSessionModelInfo,
} from "../src/pi/models.ts";
import { PI_PROVIDER } from "../src/pi/provider.ts";
import { checkSchema } from "./support/schema.ts";

function model(overrides: Partial<Model<never>> = {}): Model<never> {
	return {
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...overrides,
	} as Model<never>;
}

describe("model mapping", () => {
	it("offers the standard thinking levels when no extended levels are declared", () => {
		assert.deepEqual(supportedThinkingLevels(model()), ["off", "minimal", "low", "medium", "high"]);
	});

	it("offers only `off` for a model without reasoning", () => {
		assert.deepEqual(supportedThinkingLevels(model({ reasoning: false })), ["off"]);
	});

	it("drops unsupported levels and opts into extended levels exactly as pi does", () => {
		const levels = supportedThinkingLevels(
			model({ thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: null } as never }),
		);
		assert.deepEqual(levels, ["low", "medium", "high", "xhigh"]);
	});

	it("uses pi's provider-qualified model ids on the wire", () => {
		assert.equal(modelSelectionId(model()), "anthropic/claude-sonnet-4");
		assert.equal(
			modelSelectionId(model({ provider: "openrouter", id: "anthropic/claude-sonnet-4" })),
			"openrouter/anthropic/claude-sonnet-4",
		);
	});

	it("resolves qualified ids without confusing providers", () => {
		const direct = model({ provider: "openai", id: "gpt-6-astra", name: "GPT-6 Astra (API)" });
		const codex = model({ provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra (Codex)" });

		assert.equal(findModelBySelectionId([direct, codex], modelSelectionId(codex)), codex);
		assert.equal(findModelBySelectionId([direct, codex], "gpt-6-astra"), undefined);
		assert.equal(findModelBySelectionId([direct, codex], "gpt-6-astra", codex), codex);
	});

	it("accepts an unambiguous legacy bare model id", () => {
		const only = model();
		assert.equal(findModelBySelectionId([only], only.id), only);
	});

	it("exposes thinking level as a model configSchema", () => {
		const info = toSessionModelInfo(model());
		const property = info.configSchema?.properties[THINKING_CONFIG_KEY];

		assert.ok(property);
		assert.equal(property.type, "string");
		assert.equal(property.default, "medium");
		assert.equal(info.id, "anthropic/claude-sonnet-4");
		assert.equal(info.provider, PI_PROVIDER);
		// Do not advertise the underlying model's vision support until this host
		// can pass AHP image attachments through to pi.
		assert.equal(info.supportsVision, undefined);
		assert.equal(info.maxContextWindow, 200_000);
	});

	it("omits the configSchema when there is nothing to choose", () => {
		// A single-option picker is worse than no picker.
		assert.equal(toSessionModelInfo(model({ reasoning: false })).configSchema, undefined);
	});

	it("produces a schema-conforming AgentInfo", () => {
		const agent = buildAgentInfo([model(), model({ id: "gpt-5", name: "GPT-5", reasoning: false })]);

		assert.equal(agent.provider, PI_PROVIDER);
		assert.equal(agent.models.length, 2);
		// No capabilities declared: one chat, one working directory. Their
		// absence is what tells a client not to attempt those calls.
		assert.equal(agent.capabilities, undefined);
		assert.equal(agent.protectedResources, undefined);
		assert.equal(agent.customizations, undefined);
		assert.equal(checkSchema("state", "AgentInfo", agent), undefined);
	});
});
