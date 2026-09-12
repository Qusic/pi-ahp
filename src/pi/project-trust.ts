/**
 * Project trust.
 *
 * A working directory can carry trust-gated pi resources: `.pi` settings,
 * extensions, skills, prompts, themes and system instructions, plus inherited
 * `.agents/skills`. Loading some of them executes project-controlled code or
 * changes the agent's instructions.
 *
 * The interactive CLI resolves trust before loading those resources. Raw SDK
 * construction instead defaults `projectTrusted` to true, so an embedding host
 * must supply its decision explicitly. That matters here because
 * `createSession` accepts the working directory from a remote client.
 *
 * The default `trust` policy preserves the SDK default. The stricter `inherit`
 * policy reuses pi's trust store, so decisions made by either program apply to
 * both.
 */

import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

/**
 * What to do about a working directory pi has no recorded decision for.
 *
 * - `trust` (default) — load project resources unconditionally, matching raw
 *   SDK construction.
 * - `inherit` — honour pi's trust store; decline for a directory it has no
 *   decision for.
 * - `never` — never load project resources.
 */
export type ProjectTrustPolicy = "trust" | "inherit" | "never";

export interface TrustDecision {
	readonly trusted: boolean;
	/** Why, so a client can explain it rather than silently degrade. */
	readonly reason: "no-project-resources" | "user-trusted" | "user-untrusted" | "policy" | "unknown-project";
}

export function resolveProjectTrust(
	cwd: string,
	policy: ProjectTrustPolicy = "trust",
	agentDir: string = getAgentDir(),
): TrustDecision {
	if (policy === "never") {
		return { trusted: false, reason: "policy" };
	}

	// Nothing in the directory needs gating — trusting it grants nothing.
	if (!hasTrustRequiringProjectResources(cwd)) {
		return { trusted: true, reason: "no-project-resources" };
	}

	if (policy === "trust") {
		return { trusted: true, reason: "policy" };
	}

	// The very same store pi's CLI writes, so decisions carry both ways.
	const stored = new ProjectTrustStore(agentDir).get(cwd);
	if (stored === true) {
		return { trusted: true, reason: "user-trusted" };
	}
	if (stored === false) {
		return { trusted: false, reason: "user-untrusted" };
	}
	// No recorded decision, and a host has no user to ask.
	return { trusted: false, reason: "unknown-project" };
}
