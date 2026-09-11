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

import { getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentInfo, ConfigSchema, SessionModelInfo } from "@microsoft/agent-host-protocol";
import { PI_PROVIDER } from "./provider.ts";

export type ThinkingLevel = ModelThinkingLevel;

interface PiModelIdentity {
	readonly provider: string;
	readonly id: string;
}

/** AHP needs one opaque id, so use pi's canonical `provider/modelId` reference. */
export function modelSelectionId(model: PiModelIdentity): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Resolves a wire id, with a narrow fallback for drafts written by older hosts.
 * An ambiguous legacy id is accepted only when it already names the current
 * model; otherwise guessing a provider would run the turn somewhere unintended.
 */
export function findModelBySelectionId<T extends PiModelIdentity>(
	models: readonly T[],
	selectionId: string,
	current?: PiModelIdentity,
): T | undefined {
	const qualified = models.find((model) => modelSelectionId(model) === selectionId);
	if (qualified) {
		return qualified;
	}

	const legacyMatches = models.filter((model) => model.id === selectionId);
	if (legacyMatches.length === 1) {
		return legacyMatches[0];
	}
	if (current?.id === selectionId) {
		return legacyMatches.find((model) => model.provider === current.provider);
	}
	return undefined;
}

/** The config key carrying the thinking level in `ModelSelection.config`. */
export const THINKING_CONFIG_KEY = "thinkingLevel";

/** Uses pi's own capability rules so the advertised picker cannot drift. */
export function supportedThinkingLevels(model: Model<never>): ThinkingLevel[] {
	return getSupportedThinkingLevels(model);
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
		id: modelSelectionId(model),
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
