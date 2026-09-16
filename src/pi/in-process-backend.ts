/**
 * The in-process pi backend.
 *
 * Embeds `AgentSession` directly rather than spawning `pi --mode rpc`, reusing
 * pi's SDK services and configuration. A subprocess would add process lifecycle
 * and stdio backpressure without isolating provider credentials or user
 * resources. The narrow {@link PiBackend} seam keeps those concerns out of the
 * mapper and chat driver.
 *
 * @see ../pi/chat-driver.ts for how a backend is driven
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelSelection } from "@microsoft/agent-host-protocol";
import type { PiBackend } from "./chat-driver.ts";
import { prepareImagesForPi } from "./image-input.ts";
import { findModelBySelectionId, modelSelectionId, THINKING_CONFIG_KEY } from "./models.ts";
import { type ProjectTrustPolicy, resolveProjectTrust, type TrustDecision } from "./project-trust.ts";

export interface InProcessBackendOptions {
	readonly cwd: string;
	/** Reuses the session manager the host already allocated, so ids line up. */
	readonly sessionManager: SessionManager;
	/** How to treat project-local pi resources. Defaults to `trust`. */
	readonly projectTrustPolicy?: ProjectTrustPolicy;
}

/**
 * Wraps an `AgentSession` in the narrow surface the driver needs.
 *
 * `AgentSession.prompt()` spans the full run. The driver tracks that promise
 * without blocking action routing, while session events stream protocol state
 * and `abort()` remains available for cancellation.
 */
export class InProcessPiBackend implements PiBackend {
	readonly #session: AgentSession;
	readonly #trust: TrustDecision;

	private constructor(session: AgentSession, trust: TrustDecision) {
		this.#session = session;
		this.#trust = trust;
	}

	/** How project trust was resolved, so the host can report it to clients. */
	get projectTrust(): TrustDecision {
		return this.#trust;
	}

	static async create(options: InProcessBackendOptions): Promise<InProcessPiBackend> {
		// SDK session construction defaults projectTrusted to true and does not run
		// the CLI's trust prompt, so pass this host's decision explicitly.
		const trust = resolveProjectTrust(options.cwd, options.projectTrustPolicy);
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			settingsManager: SettingsManager.create(options.cwd, undefined, { projectTrusted: trust.trusted }),
		});
		const { session } = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager });
		return new InProcessPiBackend(session, trust);
	}

	get session(): AgentSession {
		return this.#session;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		return this.#session.subscribe(listener);
	}

	async prompt(text: string, images?: ImageContent[], signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return;
		}
		const prepared = await prepareImagesForPi(images, this.#session.settingsManager.getImageAutoResize());
		if (signal?.aborted) {
			return;
		}
		await this.#session.prompt(text, prepared ? { images: prepared } : undefined);
	}

	async steer(text: string, images?: ImageContent[], signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return;
		}
		const prepared = await prepareImagesForPi(images, this.#session.settingsManager.getImageAutoResize());
		if (signal?.aborted) {
			return;
		}
		await this.#session.steer(text, prepared);
	}

	async abort(): Promise<void> {
		await this.#session.abort();
	}

	/**
	 * Applies a per-message model selection.
	 *
	 * The reasoning effort rides in `config` under the key the model's own
	 * `configSchema` advertises, so a client that rendered that schema sends
	 * back exactly what it was offered.
	 */
	async selectModel(selection: ModelSelection): Promise<void> {
		const available = await this.#session.modelRuntime.getAvailable();
		const current = this.#session.model;
		const model = findModelBySelectionId(available, selection.id, current);
		if (!model) {
			// A stale pick from a client whose model list predates a credential
			// change. Running on the current model beats failing the turn.
			return;
		}
		if (!current || current.id !== model.id || current.provider !== model.provider) {
			await this.#session.setModel(model as never);
		}

		const level = selection.config?.[THINKING_CONFIG_KEY];
		if (typeof level === "string" && this.#session.getAvailableThinkingLevels().includes(level as never)) {
			this.#session.setThinkingLevel(level as never);
		}
	}

	/**
	 * Moves the leaf back to `entryId`, dropping everything after it.
	 *
	 * pi's sessions are append-only trees: nothing is deleted, the leaf simply
	 * moves and later appends form a new branch. `buildSessionContext` follows
	 * leaf→root, so the abandoned path stops being context — which is exactly
	 * what the protocol means by truncation. `navigateTree` also resyncs the
	 * agent's in-memory messages, so no reload is needed.
	 */
	async truncate(entryId: string): Promise<boolean> {
		const result = await this.#session.navigateTree(entryId);
		return !result.cancelled;
	}

	/** What a new message would run on right now. */
	currentSelection(): ModelSelection | undefined {
		const model = this.#session.model;
		if (!model) {
			return undefined;
		}
		return { id: modelSelectionId(model), config: { [THINKING_CONFIG_KEY]: this.#session.thinkingLevel } };
	}

	dispose(): void {
		this.#session.dispose();
	}
}
