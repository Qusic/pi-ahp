/**
 * Assembles a fully wired host: root channel, session catalogue, and session
 * lifecycle, all backed by pi.
 */

import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { createAgentSessionServices, type ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CreateSessionParams, ModelSelection, URI } from "@microsoft/agent-host-protocol";
import { installRootChannel } from "../channels/root.ts";
import { AhpHost, type HostOptions } from "../core/host.ts";
import { CompletionService, MENTION_TRIGGER } from "../pi/completions.ts";
import { deleteSessionFile } from "../pi/delete-session.ts";
import { InProcessPiBackend } from "../pi/in-process-backend.ts";
import { buildAgentInfo, THINKING_CONFIG_KEY } from "../pi/models.ts";
import { type ProjectTrustPolicy, resolveProjectTrust } from "../pi/project-trust.ts";
import { ResourceService } from "../pi/resource-service.ts";
import { ResourceWatchService } from "../pi/resource-watch.ts";
import { PiSessionCatalogue } from "../pi/session-catalogue.ts";
import { SessionConfigService } from "../pi/session-config.ts";
import { SessionHydrator } from "../pi/session-hydrator.ts";
import { type BackendFactory, type CreateSessionRequest, SessionRegistry } from "../pi/session-registry.ts";
import { TerminalService } from "./terminal-service.ts";

export interface PiHostOptions extends HostOptions {
	/** Working directory for sessions created without one. Defaults to `process.cwd()`. */
	readonly workingDirectory?: string;
	/** Injectable for tests; defaults to pi's real model runtime. */
	readonly modelRuntime?: Pick<ModelRuntime, "getAvailable">;
	/** Injectable for tests; defaults to trash-then-unlink. */
	readonly deleteFile?: (path: string) => void;
	/** Injectable for tests; defaults to an in-process `AgentSession`. */
	readonly createBackend?: BackendFactory;
	/**
	 * How to treat `.pi` resources in a session's working directory.
	 *
	 * Defaults to `trust`, matching pi's own behaviour. Switch to `inherit` when
	 * the host is reachable from outside its own trust domain: the working
	 * directory then arrives from a client, and `inherit` will only load project
	 * resources the user already approved through pi's CLI.
	 */
	readonly projectTrustPolicy?: ProjectTrustPolicy;
	/**
	 * Directories the `resource*` family may reach. Empty means unrestricted.
	 * See `src/pi/resource-service.ts` for why that is the default.
	 */
	readonly resourceRoots?: readonly string[];
}

export interface PiHost {
	readonly host: AhpHost;
	readonly sessions: SessionRegistry;
	readonly catalogue: PiSessionCatalogue;
	readonly watches: ResourceWatchService;
	readonly terminals: { shutdown(): void };
}

/**
 * Builds the host and registers every channel a client can reach at this
 * milestone.
 *
 * The model list is read once at startup. Refreshing it later means dispatching
 * `root/agentsChanged`, which is what makes the agent list a state channel
 * rather than a one-shot handshake field.
 */
export async function createPiHost(options: PiHostOptions = {}): Promise<PiHost> {
	const workingDirectory = options.workingDirectory ?? process.cwd();
	const host = new AhpHost({
		...options,
		// `@` is the only trigger this host can answer: every completion item
		// must carry an attachment, and pi's `/` commands attach nothing.
		completionTriggerCharacters: options.completionTriggerCharacters ?? [MENTION_TRIGGER],
	});

	let modelRuntime: Pick<ModelRuntime, "getAvailable">;
	let settingsManager: SettingsManager | undefined;
	if (options.modelRuntime) {
		modelRuntime = options.modelRuntime;
	} else {
		// Package extensions can register providers; the bare ModelRuntime cannot
		// see them until the standard service loader flushes those registrations.
		const trust = resolveProjectTrust(workingDirectory, options.projectTrustPolicy);
		const services = await createAgentSessionServices({
			cwd: workingDirectory,
			settingsManager: SettingsManager.create(workingDirectory, undefined, { projectTrusted: trust.trusted }),
		});
		modelRuntime = services.modelRuntime;
		settingsManager = services.settingsManager;
		for (const diagnostic of services.diagnostics) {
			options.log?.(`[pi models] ${diagnostic.type}: ${diagnostic.message}`);
		}
	}
	// A user with no configured provider still gets a usable host — they just
	// see an agent with no models, which is the honest representation.
	const models = await modelRuntime.getAvailable().catch(() => []);
	installRootChannel(host, [buildAgentInfo(models as never)]);

	const configuredProvider = settingsManager?.getDefaultProvider();
	const configuredId = settingsManager?.getDefaultModel();
	const configured = models.find((model) => model.provider === configuredProvider && model.id === configuredId);
	const fallback = configured ?? models[0];
	const fallbackThinking = fallback
		? clampThinkingLevel(fallback, configured ? (settingsManager?.getDefaultThinkingLevel() ?? "medium") : "medium")
		: undefined;
	const fallbackSelection = (): ModelSelection | undefined =>
		fallback && fallbackThinking ? { id: fallback.id, config: { [THINKING_CONFIG_KEY]: fallbackThinking } } : undefined;

	const catalogue = new PiSessionCatalogue();
	const watches = new ResourceWatchService(host, { ...(options.log ? { log: options.log } : {}) });
	const terminals = new TerminalService(host, {
		defaultWorkingDirectory: workingDirectory,
		...(options.log ? { log: options.log } : {}),
	});

	const createBackend: BackendFactory =
		options.createBackend ??
		((session) =>
			InProcessPiBackend.create({
				cwd: session.workingDirectory,
				sessionManager: session.sessionManager,
				...(options.projectTrustPolicy ? { projectTrustPolicy: options.projectTrustPolicy } : {}),
			}));

	const sessions = new SessionRegistry({
		host,
		defaultWorkingDirectory: workingDirectory,
		createBackend,
		defaultSelection: fallbackSelection,
		deleteFile: options.deleteFile ?? ((path: string) => void deleteSessionFile(path)),
		findSessionFile: (id) => catalogue.findSessionFile(id),
		...(options.log ? { log: options.log } : {}),
	});

	host.serve({
		catalogue,
		resources: new ResourceService({ ...(options.resourceRoots ? { roots: options.resourceRoots } : {}) }),
		resourceWatches: watches,
		terminals,
		sessionConfig: new SessionConfigService({
			defaultWorkingDirectory: workingDirectory,
			...(options.projectTrustPolicy ? { projectTrustPolicy: options.projectTrustPolicy } : {}),
		}),
		completions: new CompletionService({
			// Mentions resolve against the chat's own directory, which is the
			// session's working directory for the single chat this host serves.
			workingDirectoryFor: (chat) => sessions.getByChat(chat)?.workingDirectory,
		}),
		turnPaging: {
			async fetchTurns(params) {
				await sessions.fetchTurns(params.channel, params.cursor);
				return {};
			},
		},
		sessions: {
			create(params: CreateSessionParams): void {
				// `CreateSessionParams` carries fields this milestone ignores
				// (config, activeClient, progressToken); narrowing here keeps the registry
				// honest about what it actually supports.
				sessions.create(params as CreateSessionRequest);
			},
			dispose(channel: URI): Promise<void> {
				return sessions.dispose(channel);
			},
		},
		// Opening a session from the catalogue must work: only sessions this
		// host created are live, so anything else is loaded from disk on
		// subscribe.
		hydrator: new SessionHydrator({
			host,
			catalogue,
			isLive: (session) => sessions.has(session),
			// Adopted without a backend; one starts on the first turn.
			adopt: (session) => void sessions.adopt(session),
			fallbackSelection,
			...(options.log ? { log: options.log } : {}),
		}),
	});

	return { host, sessions, catalogue, watches, terminals };
}
