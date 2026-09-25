/**
 * Assembles a fully wired host: root channel, session catalogue, and session
 * lifecycle, all backed by pi.
 */

import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { createAgentSessionServices, type ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CreateSessionParams, ModelSelection, URI } from "@microsoft/agent-host-protocol";
import { installRootChannel } from "../channels/root.ts";
import { sessionUri } from "../core/channels.ts";
import { AhpHost, type HostOptions } from "../core/host.ts";
import { ChangesetService } from "../pi/changeset-service.ts";
import { CompletionService, MENTION_TRIGGER } from "../pi/completions.ts";
import { deleteSessionFile } from "../pi/delete-session.ts";
import { InProcessPiBackend } from "../pi/in-process-backend.ts";
import { buildAgentInfo, modelSelectionId, THINKING_CONFIG_KEY } from "../pi/models.ts";
import { type ProjectTrustPolicy, resolveProjectTrust } from "../pi/project-trust.ts";
import { ResourcePathPolicy } from "../pi/resource-paths.ts";
import { ResourceService } from "../pi/resource-service.ts";
import { ResourceWatchService } from "../pi/resource-watch.ts";
import type { PiSessionCatalogue } from "../pi/session-catalogue.ts";
import { SessionConfigService } from "../pi/session-config.ts";
import { SessionHydrator } from "../pi/session-hydrator.ts";
import { type BackendFactory, type SessionFileDeletionResult, SessionRegistry } from "../pi/session-registry.ts";
import type { PiSessionStorage } from "../pi/session-storage.ts";
import { TerminalService } from "./terminal-service.ts";

export interface PiHostOptions extends HostOptions {
	/** Working directory for sessions created without one. Defaults to `process.cwd()`. */
	readonly workingDirectory?: string;
	/** Injectable for tests; defaults to pi's real model runtime. */
	readonly modelRuntime?: Pick<ModelRuntime, "getAvailable">;
	/** Injectable for tests; defaults to checked trash-then-unlink deletion. */
	readonly deleteFile?: (path: string) => SessionFileDeletionResult | Promise<SessionFileDeletionResult>;
	/** Injectable for tests; defaults to an in-process `AgentSession`. */
	readonly createBackend?: BackendFactory;
	/** Explicit storage boundary; tests cannot accidentally fall back to user data. */
	readonly sessionStorage: PiSessionStorage;
	/**
	 * How to treat trust-gated pi resources in a session's working directory.
	 *
	 * Defaults to `trust`, matching the pi SDK default. Switch to `inherit` when
	 * the host is reachable from outside its own trust domain: the working
	 * directory then arrives from a client, and `inherit` will only load project
	 * resources the user already approved through pi's CLI.
	 */
	readonly projectTrustPolicy?: ProjectTrustPolicy;
	/**
	 * Directories the resource commands and watches may reach. Empty means
	 * unrestricted. See `src/pi/resource-paths.ts` for why that is the default.
	 */
	readonly resourceRoots?: readonly string[];
}

export interface PiHost {
	readonly host: AhpHost;
	readonly sessions: SessionRegistry;
	readonly catalogue: PiSessionCatalogue;
	readonly changesets: ChangesetService;
	readonly watches: ResourceWatchService;
	readonly terminals: { shutdown(): void };
}

/**
 * Builds the host and registers every supported channel. The model list is a
 * startup snapshot; dynamic refresh would require publishing
 * `root/agentsChanged` and is not implemented.
 */
export async function createPiHost(options: PiHostOptions): Promise<PiHost> {
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
		fallback && fallbackThinking
			? { id: modelSelectionId(fallback), config: { [THINKING_CONFIG_KEY]: fallbackThinking } }
			: undefined;

	const catalogue = options.sessionStorage.catalogue;
	const resourcePaths = new ResourcePathPolicy(options.resourceRoots);
	const watches = new ResourceWatchService(host, {
		pathPolicy: resourcePaths,
		...(options.log ? { log: options.log } : {}),
	});
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
		createSessionManager: options.sessionStorage.createSessionManager,
		metadata: options.sessionStorage.metadata,
		defaultSelection: fallbackSelection,
		deleteFile: options.deleteFile ?? deleteSessionFile,
		findSessionFile: (id) => catalogue.findSessionFile(id),
		...(options.log ? { log: options.log } : {}),
	});
	const sessionHydrator = new SessionHydrator({
		host,
		catalogue,
		metadata: options.sessionStorage.metadata,
		isLive: (session) => sessions.has(session),
		isDisposing: (session) => sessions.isDisposing(session),
		// Adopted without a backend; one starts on the first turn.
		adopt: (session) => void sessions.adopt(session),
		fallbackSelection,
		...(options.log ? { log: options.log } : {}),
	});
	const changesets = new ChangesetService(host, {
		getSession: (sessionId) => sessions.get(sessionUri(sessionId)),
		getSessionByChat: (chat) => sessions.getByChat(chat),
		hydrateSession: async (sessionId) => {
			await sessionHydrator.hydrate(sessionUri(sessionId));
			return sessions.get(sessionUri(sessionId));
		},
		onSessionAvailable: (listener) => sessions.onSessionAvailable(listener),
		onSessionDeletionCommitted: (listener) => sessions.onSessionDeletionCommitted(listener),
		authorizeResource: async (uri) => {
			await resourcePaths.pathFor(uri);
		},
		...(options.log ? { log: options.log } : {}),
	});
	const resources = new ResourceService({
		pathPolicy: resourcePaths,
		readVirtual: (params) => changesets.readResource(params),
	});

	host.serve({
		catalogue: {
			list: (limit, cursor) => catalogue.list(limit, cursor, () => sessions.catalogueOverrides()),
		},
		resources,
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
				// The registry's narrower structural type makes the unsupported optional
				// fields explicit: config, activeClient, and progressToken are ignored.
				sessions.create(params);
			},
			async dispose(channel: URI): Promise<void> {
				const sessionId = sessions.get(channel)?.sessionId;
				if (sessionId) await changesets.suspendSession(sessionId);
				try {
					await sessions.dispose(channel);
				} catch (error) {
					if (sessionId) changesets.resumeSession(sessionId);
					throw error;
				}
			},
		},
		// Both session/chat and their advertised changesets survive host restarts.
		hydrator: {
			async hydrate(channel) {
				return (await changesets.hydrate(channel)) || sessionHydrator.hydrate(channel);
			},
		},
	});

	return { host, sessions, catalogue, changesets, watches, terminals };
}
