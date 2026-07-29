/**
 * The in-process pi backend.
 *
 * Embeds `AgentSession` directly rather than spawning `pi --mode rpc`. Both
 * share `~/.pi/agent` — the same `auth.json`, sessions, extensions and skills —
 * so a subprocess would buy crash isolation, not independence, while adding
 * cross-platform spawn and stdio-backpressure surface. The
 * {@link PiBackend} seam keeps a spawned implementation available later without
 * touching the mapper.
 *
 * @see ../pi/chat-driver.ts for how a backend is driven
 */

import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelSelection } from "@microsoft/agent-host-protocol";
import type { PiBackend } from "./chat-driver.ts";
import { THINKING_CONFIG_KEY } from "./models.ts";
import { type ProjectTrustPolicy, resolveProjectTrust, type TrustDecision } from "./project-trust.ts";

export interface InProcessBackendOptions {
	readonly cwd: string;
	/** Reuses the session manager the host already allocated, so ids line up. */
	readonly sessionManager: SessionManager;
	/** How to treat `.pi` resources in the working directory. Default `inherit`. */
	readonly projectTrustPolicy?: ProjectTrustPolicy;
}

/**
 * Wraps an `AgentSession` in the narrow surface the driver needs.
 *
 * `prompt()` deliberately does not await the agent run: the protocol models a
 * turn as a stream of actions, and the driver closes it on `agent_settled`.
 * Awaiting here would serialise the whole turn behind one promise and make
 * cancellation impossible.
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
		// Without an explicit `SettingsManager` the SDK trusts the directory
		// (`SettingsManager.fromStorage` defaults `projectTrusted` to `true`),
		// which would execute a client-supplied project's extensions unasked.
		const trust = resolveProjectTrust(options.cwd, options.projectTrustPolicy);
		const { session } = await createAgentSession({
			cwd: options.cwd,
			sessionManager: options.sessionManager,
			settingsManager: SettingsManager.create(options.cwd, undefined, { projectTrusted: trust.trusted }),
		});
		return new InProcessPiBackend(session, trust);
	}

	get session(): AgentSession {
		return this.#session;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		return this.#session.subscribe(listener);
	}

	async prompt(text: string): Promise<void> {
		await this.#session.prompt(text);
	}

	async steer(text: string): Promise<void> {
		await this.#session.steer(text);
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
		const model = available.find((candidate) => candidate.id === selection.id);
		if (!model) {
			// A stale pick from a client whose model list predates a credential
			// change. Running on the current model beats failing the turn.
			return;
		}
		if (this.#session.model?.id !== model.id) {
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
		return { id: model.id, config: { [THINKING_CONFIG_KEY]: this.#session.thinkingLevel } };
	}

	dispose(): void {
		this.#session.dispose();
	}
}
