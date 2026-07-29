/**
 * pi-ahp — an Agent Host Protocol server backed by the pi coding agent.
 */

export { chatSummaryOf, initialChatState, installDefaultChat, syncChatSummary } from "./channels/chat.ts";
export {
	initialRootState,
	installRootChannel,
	notifySessionAdded,
	notifySessionRemoved,
	notifySessionSummaryChanged,
} from "./channels/root.ts";
export { initialSessionState, sessionSummaryOf } from "./channels/session.ts";
export {
	getAhpDir,
	getSettingsPath,
	type HostSettings,
	loadSettings,
	writeSettings,
} from "./config.ts";
export {
	type ChannelKind,
	channelKind,
	chatIdFromUri,
	chatUri,
	isChatChannel,
	isRootChannel,
	isSessionChannel,
	ROOT_CHANNEL,
	sessionIdFromUri,
	sessionUri,
} from "./core/channels.ts";
export { ClientConnection, type ClientInfo, type Transport } from "./core/connection.ts";
export type {
	ChannelHydrator,
	ClientActionValidator,
	CompletionHandler,
	ResourceHandler,
	ResourceWatchHandler,
	SessionConfigHandler,
	SubscriberCountListener,
	TurnPagingHandler,
} from "./core/host.ts";
export { AhpHost, type HostCapabilities, type HostOptions, type SessionCatalogue } from "./core/host.ts";
export { DEFAULT_REPLAY_BUFFER_CAPACITY, Sequencer } from "./core/sequencer.ts";
export { type ChannelState, StateStore } from "./core/state-store.ts";
export { fileUriToPath, pathToFileUri } from "./core/uri.ts";
export { ChatDriver, type ChatDriverOptions, type PiBackend } from "./pi/chat-driver.ts";
export { CompletionService, type CompletionServiceOptions, findMention, MENTION_TRIGGER } from "./pi/completions.ts";
export { type DeleteResult, deleteSessionFile } from "./pi/delete-session.ts";
export { TurnMapper, userTurnStarted } from "./pi/event-mapper.ts";
export {
	CLEAR_ALL_ANCHOR,
	type RebuildOptions,
	type RebuiltHistory,
	rebuildHistory,
	rebuildHistoryFromSession,
	rebuildTurns,
	rebuildTurnsFromSession,
} from "./pi/history.ts";
export { type InProcessBackendOptions, InProcessPiBackend } from "./pi/in-process-backend.ts";
export { buildAgentInfo, supportedThinkingLevels, THINKING_CONFIG_KEY, toSessionModelInfo } from "./pi/models.ts";
export {
	type ProjectTrustPolicy,
	resolveProjectTrust,
	type TrustDecision,
} from "./pi/project-trust.ts";
export { PI_PROVIDER } from "./pi/provider.ts";
export { ResourceService, type ResourceServiceOptions } from "./pi/resource-service.ts";
export { type ResourceWatchOptions, ResourceWatchService } from "./pi/resource-watch.ts";
export { PiSessionCatalogue, readSessionSummary } from "./pi/session-catalogue.ts";
export { PROJECT_TRUST_KEY, type SessionConfigOptions, SessionConfigService } from "./pi/session-config.ts";
export { SessionHydrator, type SessionHydratorOptions } from "./pi/session-hydrator.ts";
export {
	type BackendFactory,
	type CreateSessionRequest,
	type LiveSession,
	SessionRegistry,
	type SessionRegistryOptions,
} from "./pi/session-registry.ts";
export { DEFAULT_PAGE_SIZE, initialTurnsCursor, loadOlderTurns } from "./pi/turn-paging.ts";
// pi-backed assembly
export { createPiHost, type PiHost, type PiHostOptions } from "./pi-host.ts";
export { ProtocolError } from "./protocol/errors.ts";
export { HOST_SUPPORTED_VERSIONS, negotiateProtocolVersion } from "./protocol/version.ts";
export { type RunningServer, serveWebSocket, type WebSocketTransportOptions } from "./transport/websocket.ts";
