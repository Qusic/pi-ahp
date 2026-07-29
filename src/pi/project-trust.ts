/**
 * Project trust.
 *
 * A project directory can carry `.pi` resources — extensions, skills, prompt
 * templates, settings — that pi *executes*. pi's CLI gates that behind a
 * prompt; the SDK does not: `SettingsManager.fromStorage` defaults
 * `projectTrusted` to `true`, and `resolveProjectTrusted` is only ever called
 * from `main.ts`. So an embedding host that does nothing silently runs whatever
 * the target directory contains.
 *
 * That matters more here than in a CLI, because the working directory arrives
 * from a client over the network via `createSession`.
 *
 * The default therefore matches pi's own behaviour rather than tightening it.
 * The stricter `inherit` mode deliberately reuses pi's store rather than
 * inventing a parallel one, so a project the user already trusted with `pi`
 * stays trusted here, and revoking in either place revokes in both.
 */

import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

/**
 * What to do about a working directory pi has no recorded decision for.
 *
 * - `trust` (default) — load project resources unconditionally, as pi's own SDK
 *   does.
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
