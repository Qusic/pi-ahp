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

import {
	JsonRpcErrorCodes,
	type ResolveSessionConfigParams,
	type ResolveSessionConfigResult,
	type SessionConfigCompletionsParams,
	type SessionConfigCompletionsResult,
	type SessionConfigPropertySchema,
} from "@microsoft/agent-host-protocol";
import { fileUriToPath } from "../core/uri.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { chooseProjectTrust, type ProjectTrust, readProjectTrust } from "./project-trust.ts";

/** Config key for whether the session's folder is trusted; see project-trust.ts. */
export const PROJECT_TRUST_KEY = "projectTrust";

export interface SessionConfigOptions {
	readonly defaultWorkingDirectory: string;
}

export class SessionConfigService {
	readonly #options: SessionConfigOptions;

	constructor(options: SessionConfigOptions) {
		this.#options = options;
	}

	/**
	 * Describes what a new session in this directory would do.
	 *
	 * One property: whether the folder is trusted, which decides whether its
	 * trust-gated resources load. As AHP asks, the user's answer is echoed back
	 * where the folder has a choice to make; otherwise the folder's own answer
	 * stands.
	 */
	resolve(params: ResolveSessionConfigParams): ResolveSessionConfigResult {
		const workingDirectory = params.workingDirectory
			? fileUriToPath(params.workingDirectory)
			: this.#options.defaultWorkingDirectory;
		const trust = readProjectTrust(workingDirectory);
		const answer = params.config?.[PROJECT_TRUST_KEY];
		return {
			schema: {
				type: "object",
				properties: { [PROJECT_TRUST_KEY]: projectTrustProperty(trust) },
			},
			values: { [PROJECT_TRUST_KEY]: trust.gated && typeof answer === "boolean" ? answer : trust.trusted },
		};
	}

	/**
	 * Applies the answers a client sent with `createSession`.
	 *
	 * Runs before the session exists, so a refusal leaves nothing behind.
	 */
	applyAtCreation(workingDirectory: string, config: Readonly<Record<string, unknown>> | undefined): void {
		const trusted = config?.[PROJECT_TRUST_KEY];
		if (trusted === undefined) {
			return;
		}
		if (typeof trusted !== "boolean") {
			throw ProtocolError.invalidParams(`${PROJECT_TRUST_KEY} must be true or false.`);
		}
		try {
			chooseProjectTrust(workingDirectory, trusted);
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			throw new ProtocolError(
				JsonRpcErrorCodes.InternalError,
				`Could not save the project trust decision for ${workingDirectory}: ${cause}`,
			);
		}
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

function projectTrustProperty(trust: ProjectTrust): SessionConfigPropertySchema {
	const title = "Trust project folder";
	if (!trust.gated) {
		return {
			type: "boolean",
			title,
			description: "This folder has no trust-gated project resources.",
			readOnly: true,
		};
	}
	const source = trust.saved
		? `Saved decision for ${trust.saved.path}.`
		: `No saved decision; pi's defaultProjectTrust is "${trust.defaultProjectTrust}".`;
	// Not `sessionMutable`: resources load when the session is created.
	return {
		type: "boolean",
		title,
		description: `${source} Trust lets pi load this folder's .pi settings, extensions and skills. Changing it saves a decision for this folder in pi's trust store, which pi also uses.`,
	};
}
