/**
 * Project trust.
 *
 * A working directory can carry trust-gated pi resources: `.pi` settings,
 * extensions, skills, prompts, themes and system instructions, plus inherited
 * `.agents/skills`. Loading some of them executes project-controlled code or
 * changes the agent's instructions.
 *
 * Raw SDK construction defaults `projectTrusted` to true, so this host resolves
 * trust the way pi's CLI does and passes the answer explicitly: a decision saved
 * for the folder or one of its parents applies first, then pi's
 * `defaultProjectTrust` setting. Where pi would prompt, the session config asks
 * the user instead, and an answer that differs is saved to pi's own trust store.
 * Every decision is therefore shared with pi, and a restarted host reaches the
 * same answer.
 *
 * Unlike pi, extension `project_trust` handlers are not consulted.
 */

import {
	type DefaultProjectTrust,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	type ProjectTrustStoreEntry,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface ProjectTrust {
	/** Whether the folder has anything trust gates. Without that, there is nothing to decide. */
	readonly gated: boolean;
	/** The closest decision saved for the folder or one of its parents. */
	readonly saved: ProjectTrustStoreEntry | null;
	/** pi's answer for a gated folder without a saved decision. */
	readonly defaultProjectTrust: DefaultProjectTrust;
	/** What a session in the folder gets unless the user answers otherwise. */
	readonly trusted: boolean;
}

export function readProjectTrust(cwd: string, agentDir: string = getAgentDir()): ProjectTrust {
	const gated = hasTrustRequiringProjectResources(cwd);
	const saved = new ProjectTrustStore(agentDir).getEntry(cwd);
	// Global settings only: project settings are themselves trust-gated.
	const defaultProjectTrust = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust();
	// As in pi, a saved decision wins. Without one, a folder with nothing to
	// gate is trusted, and "ask" declines until the user answers.
	const trusted = saved?.decision ?? (!gated || defaultProjectTrust === "always");
	return { gated, saved, defaultProjectTrust, trusted };
}

/**
 * Records the user's answer for a new session's folder, where pi would prompt.
 *
 * An answer that differs from what the folder would get is saved to pi's trust
 * store, as pi's own prompt saves it. An unchanged answer saves nothing, so a
 * client that echoes the value it was shown leaves the store alone.
 */
export function chooseProjectTrust(cwd: string, trusted: boolean, agentDir: string = getAgentDir()): void {
	const current = readProjectTrust(cwd, agentDir);
	if (current.gated && trusted !== current.trusted) {
		new ProjectTrustStore(agentDir).set(cwd, trusted);
	}
}
