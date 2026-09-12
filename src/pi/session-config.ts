/**
 * Pre-creation session configuration.
 *
 * Before `createSession`, a client asks the host what a new session needs to be
 * configured with. The exchange is iterative: the client sends the working
 * directory and whatever the user has filled in so far, and the host returns the
 * *full* current property set plus resolved values — never a delta — so options
 * can appear and disappear as earlier choices are made.
 *
 * Model selection stays out of this schema: models are advertised on
 * `AgentInfo.models` and chosen per message via `Message.model`. The schema here
 * covers only what pi must decide before creating the session.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/root-channel
 */

import type {
	ResolveSessionConfigParams,
	ResolveSessionConfigResult,
	SessionConfigCompletionsParams,
	SessionConfigCompletionsResult,
	SessionConfigSchema,
} from "@microsoft/agent-host-protocol";
import { fileUriToPath } from "../core/uri.ts";
import { type ProjectTrustPolicy, resolveProjectTrust } from "./project-trust.ts";

/** Config key describing whether trust-gated project resources load. */
export const PROJECT_TRUST_KEY = "projectResources";

export interface SessionConfigOptions {
	readonly defaultWorkingDirectory: string;
	readonly projectTrustPolicy?: ProjectTrustPolicy;
}

export class SessionConfigService {
	readonly #options: SessionConfigOptions;

	constructor(options: SessionConfigOptions) {
		this.#options = options;
	}

	/**
	 * Describes what a new session in this directory would do.
	 *
	 * Only one property, and it is read-only: whether trust-gated resources from
	 * the target directory and its ancestors will load. It is surfaced because
	 * the answer changes with the directory and materially changes the agent's
	 * tools, settings, and instructions.
	 */
	resolve(params: ResolveSessionConfigParams): ResolveSessionConfigResult {
		const workingDirectory = params.workingDirectory
			? fileUriToPath(params.workingDirectory)
			: this.#options.defaultWorkingDirectory;
		const trust = resolveProjectTrust(workingDirectory, this.#options.projectTrustPolicy);

		const schema: SessionConfigSchema = {
			type: "object",
			properties: {
				[PROJECT_TRUST_KEY]: {
					type: "boolean",
					title: "Load project resources",
					description:
						trust.reason === "no-project-resources"
							? "This folder has no trust-gated project resources."
							: `Trust-gated project resources (${trust.reason}).`,
					// Host policy, not a per-session choice — see project-trust.ts.
					readOnly: true,
				},
			},
		};

		return { schema, values: { [PROJECT_TRUST_KEY]: trust.trusted } };
	}

	/**
	 * No dynamic values to enumerate.
	 *
	 * Every property this host exposes has a static domain, so the completions
	 * endpoint exists only to keep a client that probes it from erroring.
	 */
	completions(_params: SessionConfigCompletionsParams): SessionConfigCompletionsResult {
		return { items: [] };
	}
}
