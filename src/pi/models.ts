/**
 * Maps pi's model catalogue onto the protocol's agent/model description.
 *
 * The host advertises exactly one agent — pi — whose models are whatever the
 * user has credentials for. Model-specific options (pi's thinking level) travel
 * as a `configSchema`, which is the protocol's escape hatch for exactly this:
 * clients render it as a form and pass the values back in `ModelSelection`.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/root-channel
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentInfo, ConfigSchema, SessionModelInfo } from "@microsoft/agent-host-protocol";
import { PI_PROVIDER } from "./provider.ts";

/** pi's thinking levels, weakest to strongest. `off` is always available. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The config key carrying the thinking level in `ModelSelection.config`. */
export const THINKING_CONFIG_KEY = "thinkingLevel";

/**
 * The thinking levels a model actually supports.
 *
 * pi encodes support in `thinkingLevelMap`: a missing key means "use the
 * provider default" (supported), an explicit `null` means unsupported. A model
 * without reasoning at all supports only `off`.
 */
export function supportedThinkingLevels(model: Model<never>): ThinkingLevel[] {
	if (!model.reasoning) {
		return ["off"];
	}
	const levelMap = model.thinkingLevelMap as Record<string, unknown> | undefined;
	if (!levelMap) {
		return [...THINKING_LEVELS];
	}
	return THINKING_LEVELS.filter((level) => level === "off" || levelMap[level] !== null);
}

function thinkingConfigSchema(model: Model<never>): ConfigSchema | undefined {
	const levels = supportedThinkingLevels(model);
	// A model with only `off` has nothing to configure; omitting the schema
	// keeps the client from rendering a pointless single-option picker.
	if (levels.length <= 1) {
		return undefined;
	}
	return {
		type: "object",
		properties: {
			[THINKING_CONFIG_KEY]: {
				type: "string",
				title: "Thinking",
				description: "How much reasoning effort the model spends before answering.",
				default: levels.includes("medium") ? "medium" : levels[0],
				enum: [...levels],
				enumLabels: levels.map((level) => level.charAt(0).toUpperCase() + level.slice(1)),
			},
		},
	};
}

export function toSessionModelInfo(model: Model<never>): SessionModelInfo {
	const configSchema = thinkingConfigSchema(model);
	return {
		id: model.id,
		provider: PI_PROVIDER,
		name: model.name,
		maxContextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		...(configSchema ? { configSchema } : {}),
		// `_meta` is the protocol's documented place for provider-specific
		// extras; clients may surface pricing but must not depend on it.
		_meta: {
			piProvider: model.provider,
			api: model.api,
			pricing: model.cost,
		},
	};
}

/**
 * Builds the single `AgentInfo` this host advertises.
 *
 * No `protectedResources`: pi authenticates against providers itself using
 * `~/.pi/agent/auth.json`, so there is nothing for the client to authenticate
 * against at the protocol level.
 *
 * No `capabilities`: this host serves one chat per session and one working
 * directory, so neither `multipleChats` nor `multipleWorkingDirectories` is
 * declared. Their absence is what tells a client not to attempt those calls.
 * Models likewise omit `supportsVision` until the AHP attachment adapter can
 * actually deliver image bytes to pi; the underlying model alone is not enough.
 */
export function buildAgentInfo(models: readonly Model<never>[]): AgentInfo {
	return {
		provider: PI_PROVIDER,
		displayName: "pi",
		description: "pi coding agent",
		models: models.map(toSessionModelInfo),
	};
}
