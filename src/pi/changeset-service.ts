/** AHP changeset lifecycle, refresh, hydration, and immutable Git content. */

import { isUtf8 } from "node:buffer";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	ActionType,
	type ChangesetState,
	ChangesetStatus,
	ContentEncoding,
	type ResourceReadParams,
	type ResourceReadResult,
	type SessionState,
	type URI,
} from "@microsoft/agent-host-protocol";
import mime from "mime";
import { sessionIdFromUri } from "../core/channels.ts";
import type { AhpHost, ChannelHydrator } from "../core/host.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { type PiChangesetKind, parsePiChangesetUri, piChangesetCatalogue, piChangesetUri } from "./changeset-uri.ts";
import { type ChokidarWatchFactory, openChokidarWatchTargets } from "./chokidar-watch-source.ts";
import { GitChanges, type GitChangesBackend, type GitWorkspace, parseGitBlobUri } from "./git-changes.ts";
import { ParcelWatchPool } from "./parcel-watch-pool.ts";
import type { FileWatchSource } from "./watch-source.ts";

export interface ChangesetSession {
	readonly uri: URI;
	readonly sessionId: string;
	readonly workingDirectory: string;
}

export interface ChangesetServiceOptions {
	readonly getSession: (sessionId: string) => ChangesetSession | undefined;
	readonly getSessionByChat: (chat: URI) => ChangesetSession | undefined;
	readonly hydrateSession: (sessionId: string) => Promise<ChangesetSession | undefined>;
	readonly onSessionAvailable?: (listener: (session: ChangesetSession) => void) => () => void;
	readonly onSessionDeletionCommitted?: (listener: (sessionId: string) => Promise<void>) => () => void;
	readonly authorizeResource?: (uri: URI) => Promise<void>;
	readonly git?: GitChangesBackend;
	readonly parcelPool?: ParcelWatchPool;
	/** Chokidar factory for narrow Git metadata targets. */
	readonly metadataWatchFactory?: ChokidarWatchFactory;
	readonly debounceMs?: number;
	readonly stateGraceMs?: number;
	readonly log?: (message: string) => void;
}

interface ChangesetWatcher {
	readonly target: GitWorkspace;
	readonly recursive: FileWatchSource;
	readonly metadata: FileWatchSource;
}

interface SessionEntry {
	session: ChangesetSession;
	workspace: GitWorkspace | undefined;
	probe: Promise<void> | undefined;
	probeAbort: AbortController | undefined;
	refresh: Promise<void> | undefined;
	refreshRequested: boolean;
	suspended: boolean;
	abort: AbortController | undefined;
	watcher: ChangesetWatcher | undefined;
	watchStarting: Promise<void> | undefined;
	watchClosing: Promise<void> | undefined;
	watchAbort: AbortController | undefined;
	refreshTimer: NodeJS.Timeout | undefined;
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_STATE_GRACE_MS = 30_000;

function sameCatalogue(left: SessionState["changesets"], right: SessionState["changesets"]): boolean {
	return isDeepStrictEqual(left, right);
}

function isInside(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isText(buffer: Buffer): boolean {
	return isUtf8(buffer) && !buffer.includes(0);
}

function sameWatchTarget(left: GitWorkspace | undefined, right: GitWorkspace): boolean {
	return (
		left?.cwd === right.cwd &&
		left.gitDirectory === right.gitDirectory &&
		left.commonGitDirectory === right.commonGitDirectory
	);
}

/** Publishes the two Git-backed static changesets and owns their live resources. */
export class ChangesetService implements ChannelHydrator {
	readonly #host: AhpHost;
	readonly #options: ChangesetServiceOptions;
	readonly #git: GitChangesBackend;
	readonly #parcelPool: ParcelWatchPool;
	readonly #entries = new Map<string, SessionEntry>();
	readonly #stateEvictions = new Map<URI, NodeJS.Timeout>();
	readonly #unhookSubscribers: () => void;
	readonly #unhookActions: () => void;
	readonly #unhookValidator: () => void;
	readonly #unhookSessionAvailable: () => void;
	readonly #unhookSessionDeletionCommitted: () => void;
	#disposed = false;
	#disposal: Promise<void> | undefined;

	constructor(host: AhpHost, options: ChangesetServiceOptions) {
		this.#host = host;
		this.#options = options;
		this.#git = options.git ?? new GitChanges();
		this.#parcelPool = options.parcelPool ?? new ParcelWatchPool();
		this.#unhookSubscribers = host.onSubscriberCountChanged((channel, count) =>
			this.#subscriberChanged(channel, count),
		);
		this.#unhookActions = host.onActionCommitted((channel, action) => {
			if (
				action.type !== ActionType.ChatTurnComplete &&
				action.type !== ActionType.ChatTurnCancelled &&
				action.type !== ActionType.ChatError
			) {
				return;
			}
			const session = this.#options.getSessionByChat(channel);
			if (!session) return;
			const entry = this.#entries.get(session.sessionId);
			if (!entry) return;
			if (this.#hasInterest(entry)) this.#requestRefresh(entry);
			else void this.#probe(entry);
		});
		this.#unhookValidator = host.addClientActionValidator((channel) =>
			parsePiChangesetUri(channel) ? "This host exposes read-only changesets" : undefined,
		);
		this.#unhookSessionAvailable =
			options.onSessionAvailable?.((session) => {
				void this.attach(session).catch((error) =>
					this.#options.log?.(`cannot attach changesets for ${session.uri}: ${String(error)}`),
				);
			}) ?? (() => {});
		this.#unhookSessionDeletionCommitted =
			options.onSessionDeletionCommitted?.((sessionId) => this.removeSession(sessionId)) ?? (() => {});
	}

	get activeWatcherCount(): number {
		let count = 0;
		for (const entry of this.#entries.values()) {
			if (entry.watcher) count += 1;
		}
		return count;
	}

	async attach(session: ChangesetSession): Promise<void> {
		if (this.#disposed) return;
		const entry = this.#entryFor(session);
		if (!entry.workspace) await this.#probe(entry);
	}

	#entryFor(session: ChangesetSession): SessionEntry {
		const existing = this.#entries.get(session.sessionId);
		if (existing) {
			existing.session = session;
			return existing;
		}
		const entry: SessionEntry = {
			session,
			workspace: undefined,
			probe: undefined,
			probeAbort: undefined,
			refresh: undefined,
			refreshRequested: false,
			suspended: false,
			abort: undefined,
			watcher: undefined,
			watchStarting: undefined,
			watchClosing: undefined,
			watchAbort: undefined,
			refreshTimer: undefined,
		};
		this.#entries.set(session.sessionId, entry);
		return entry;
	}

	async hydrate(channel: URI): Promise<boolean> {
		const parsed = parsePiChangesetUri(channel);
		if (!parsed || this.#disposed) return false;
		let session = this.#options.getSession(parsed.sessionId);
		if (!session) session = await this.#options.hydrateSession(parsed.sessionId);
		if (!session) return false;
		const entry = this.#entryFor(session);
		await this.#probe(entry);
		const state = this.#host.store.get(session.uri) as SessionState | undefined;
		if (!state?.changesets?.some((candidate) => candidate.uriTemplate === channel)) return false;
		this.#cancelStateEviction(channel);
		if (!this.#host.store.has(channel)) {
			this.#host.store.create(
				channel,
				{ status: ChangesetStatus.Computing, files: [] } satisfies ChangesetState,
				"changeset",
			);
		}
		return true;
	}

	async suspendSession(sessionId: string): Promise<void> {
		const entry = this.#entries.get(sessionId);
		if (!entry) return;
		entry.suspended = true;
		entry.refreshRequested = false;
		entry.probeAbort?.abort();
		entry.abort?.abort();
		entry.watchAbort?.abort();
		if (entry.refreshTimer) {
			clearTimeout(entry.refreshTimer);
			entry.refreshTimer = undefined;
		}
		await this.#closeWatcher(entry);
		await Promise.all([entry.probe?.catch(() => undefined), entry.refresh?.catch(() => undefined)]);
	}

	resumeSession(sessionId: string): void {
		const entry = this.#entries.get(sessionId);
		if (!entry || this.#disposed) return;
		entry.suspended = false;
		if (!entry.workspace) void this.#probe(entry);
		if (this.#hasInterest(entry)) this.#requestRefresh(entry);
	}

	async removeSession(sessionId: string): Promise<void> {
		const entry = this.#entries.get(sessionId);
		if (entry) await this.suspendSession(sessionId);
		for (const kind of ["latest-commit", "uncommitted"] as const) {
			this.#disposeChannel(piChangesetUri(sessionId, kind));
		}
		this.#entries.delete(sessionId);
	}

	dispose(): Promise<void> {
		if (this.#disposal) return this.#disposal;
		this.#disposed = true;
		this.#unhookSubscribers();
		this.#unhookActions();
		this.#unhookValidator();
		this.#unhookSessionAvailable();
		this.#unhookSessionDeletionCommitted();
		for (const timer of this.#stateEvictions.values()) clearTimeout(timer);
		this.#stateEvictions.clear();
		this.#disposal = Promise.allSettled([...this.#entries].map(([sessionId]) => this.removeSession(sessionId))).then(
			() => {},
		);
		return this.#disposal;
	}

	async readResource(params: ResourceReadParams): Promise<ResourceReadResult | undefined> {
		if (!params.uri.startsWith("git-blob:")) return undefined;
		const blob = parseGitBlobUri(params.uri);
		if (!blob) throw ProtocolError.invalidParams(`Malformed git blob URI: ${params.uri}`);
		let session = this.#options.getSession(blob.sessionId);
		if (!session) session = await this.#options.hydrateSession(blob.sessionId);
		if (!session) throw ProtocolError.notFound(params.uri);
		await this.attach(session);
		const workspace = this.#entries.get(blob.sessionId)?.workspace;
		if (!workspace) throw ProtocolError.notFound(params.uri);
		const blobPath = this.#git.pathForBlob(workspace, blob);
		if (!blobPath) throw ProtocolError.notFound(params.uri);
		await this.#options.authorizeResource?.(pathToFileURL(blobPath).toString());
		let buffer: Buffer;
		try {
			buffer = await this.#git.readBlob(workspace, blob);
		} catch {
			throw ProtocolError.notFound(params.uri);
		}
		const text = isText(buffer);
		const encoding =
			params.encoding === ContentEncoding.Base64 || !text ? ContentEncoding.Base64 : ContentEncoding.Utf8;
		const contentType = mime.getType(blob.path) ?? (text ? "text/plain" : undefined);
		return {
			data: buffer.toString(encoding === ContentEncoding.Utf8 ? "utf8" : "base64"),
			encoding,
			...(contentType ? { contentType } : {}),
		};
	}

	#subscriberChanged(channel: URI, count: number): void {
		const parsed = parsePiChangesetUri(channel);
		if (!parsed) {
			const sessionId = sessionIdFromUri(channel);
			const entry = sessionId ? this.#entries.get(sessionId) : undefined;
			if (entry && count > 0) void this.#probe(entry);
			return;
		}
		const entry = this.#entries.get(parsed.sessionId);
		if (!entry) return;
		if (count > 0) {
			this.#cancelStateEviction(channel);
			this.#requestRefresh(entry);
			return;
		}
		this.#startStateEviction(channel);
		if (!this.#hasInterest(entry)) {
			entry.refreshRequested = false;
			entry.abort?.abort();
			void this.#closeWatcher(entry);
		}
	}

	#startStateEviction(channel: URI): void {
		if (this.#stateEvictions.has(channel)) return;
		const timer = setTimeout(() => {
			this.#stateEvictions.delete(channel);
			if (this.#host.subscriberCount(channel) === 0) this.#host.deleteChannel(channel);
		}, this.#options.stateGraceMs ?? DEFAULT_STATE_GRACE_MS);
		timer.unref?.();
		this.#stateEvictions.set(channel, timer);
	}

	#cancelStateEviction(channel: URI): void {
		const timer = this.#stateEvictions.get(channel);
		if (!timer) return;
		clearTimeout(timer);
		this.#stateEvictions.delete(channel);
	}

	#hasInterest(entry: SessionEntry): boolean {
		return (
			this.#host.subscriberCount(piChangesetUri(entry.session.sessionId, "latest-commit")) > 0 ||
			this.#host.subscriberCount(piChangesetUri(entry.session.sessionId, "uncommitted")) > 0
		);
	}

	#probe(entry: SessionEntry): Promise<void> {
		if (entry.probe) return entry.probe;
		const abort = new AbortController();
		entry.probeAbort = abort;
		const operation = this.#doProbe(entry, abort.signal).finally(() => {
			if (entry.probe === operation) entry.probe = undefined;
			if (entry.probeAbort === abort) entry.probeAbort = undefined;
		});
		entry.probe = operation;
		return operation;
	}

	async #doProbe(entry: SessionEntry, signal: AbortSignal): Promise<void> {
		try {
			const workspace = await this.#inspectWorkspace(entry, signal);
			if (this.#entries.get(entry.session.sessionId) !== entry || entry.suspended || this.#disposed) return;
			entry.workspace = workspace;
			this.#applyCatalogue(entry);
		} catch (error) {
			if (signal.aborted || this.#entries.get(entry.session.sessionId) !== entry || entry.suspended || this.#disposed) {
				return;
			}
			entry.workspace = undefined;
			this.#applyCatalogue(entry);
			this.#options.log?.(`cannot inspect Git changes for ${entry.session.uri}: ${String(error)}`);
		}
	}

	#applyCatalogue(entry: SessionEntry): void {
		const next = entry.workspace
			? piChangesetCatalogue(entry.session.sessionId, entry.workspace.head !== undefined)
			: undefined;
		const available = new Set(next?.map((changeset) => changeset.uriTemplate));
		for (const kind of ["latest-commit", "uncommitted"] as const) {
			const channel = piChangesetUri(entry.session.sessionId, kind);
			if (!available.has(channel)) this.#disposeChannel(channel);
		}
		const state = this.#host.store.get(entry.session.uri) as SessionState | undefined;
		if (state && !sameCatalogue(state.changesets, next)) {
			this.#host.dispatchServerAction(entry.session.uri, {
				type: ActionType.SessionChangesetsChanged,
				changesets: next,
			});
		}
	}

	#requestRefresh(entry: SessionEntry): void {
		if (this.#disposed || entry.suspended || !this.#hasInterest(entry)) return;
		entry.refreshRequested = true;
		if (entry.refreshTimer) {
			clearTimeout(entry.refreshTimer);
			entry.refreshTimer = undefined;
		}
		if (entry.refresh) return;
		const operation = this.#refreshLoop(entry).finally(() => {
			if (entry.refresh !== operation) return;
			entry.refresh = undefined;
			// An event can arrive after the loop's final condition check but before
			// this cleanup. Consume that wake-up instead of leaving it stranded.
			if (entry.refreshRequested) this.#requestRefresh(entry);
		});
		entry.refresh = operation;
		void operation.catch((error) =>
			this.#options.log?.(`changeset refresh failed for ${entry.session.uri}: ${String(error)}`),
		);
	}

	async #refreshLoop(entry: SessionEntry): Promise<void> {
		while (entry.refreshRequested && !entry.suspended && !this.#disposed) {
			entry.refreshRequested = false;
			await this.#refreshOnce(entry);
		}
	}

	async #refreshOnce(entry: SessionEntry): Promise<void> {
		await entry.probe?.catch(() => undefined);
		if (entry.suspended || this.#disposed) return;
		const abort = new AbortController();
		entry.abort = abort;
		try {
			let workspace: GitWorkspace | undefined;
			try {
				workspace = await this.#inspectWorkspace(entry, abort.signal);
			} catch (error) {
				if (abort.signal.aborted) return;
				this.#publishError(entry, error);
				return;
			}
			if (!this.#canPublish(entry, abort)) return;
			entry.workspace = workspace;
			this.#applyCatalogue(entry);
			if (!workspace) {
				await this.#closeWatcher(entry);
				return;
			}
			if (entry.watcher && !sameWatchTarget(entry.watcher.target, workspace)) await this.#closeWatcher(entry);
			// Establish observation before scanning. Any event during the scan sets
			// `refreshRequested`, so the loop immediately computes a second snapshot.
			await this.#ensureWatcher(entry);
			if (!this.#canPublish(entry, abort)) return;

			const kinds = (["latest-commit", "uncommitted"] as const).filter((kind) => {
				const channel = piChangesetUri(entry.session.sessionId, kind);
				return this.#host.store.has(channel) && this.#host.subscriberCount(channel) > 0;
			});
			for (const kind of kinds) {
				const channel = piChangesetUri(entry.session.sessionId, kind);
				const state = this.#host.store.get(channel) as ChangesetState | undefined;
				if (state?.status !== ChangesetStatus.Computing) {
					this.#host.dispatchServerAction(channel, {
						type: ActionType.ChangesetStatusChanged,
						status: ChangesetStatus.Computing,
					});
				}
			}
			await Promise.all(kinds.map((kind) => this.#compute(entry, workspace, kind, abort)));
		} finally {
			if (entry.abort === abort) entry.abort = undefined;
		}
	}

	async #compute(
		entry: SessionEntry,
		workspace: GitWorkspace,
		kind: PiChangesetKind,
		abort: AbortController,
	): Promise<void> {
		const channel = piChangesetUri(entry.session.sessionId, kind);
		try {
			const files = await this.#git.compute(workspace, entry.session.sessionId, kind, abort.signal);
			if (!this.#canPublish(entry, abort) || !this.#host.store.has(channel)) return;
			this.#host.dispatchServerAction(channel, {
				type: ActionType.ChangesetContentChanged,
				files,
			});
			this.#host.dispatchServerAction(channel, {
				type: ActionType.ChangesetStatusChanged,
				status: ChangesetStatus.Ready,
			});
		} catch (error) {
			if (abort.signal.aborted || !this.#canPublish(entry, abort) || !this.#host.store.has(channel)) return;
			this.#host.dispatchServerAction(channel, {
				type: ActionType.ChangesetStatusChanged,
				status: ChangesetStatus.Error,
				error: { errorType: "gitChangesFailed", message: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	#publishError(entry: SessionEntry, error: unknown): void {
		for (const kind of ["latest-commit", "uncommitted"] as const) {
			const channel = piChangesetUri(entry.session.sessionId, kind);
			if (this.#host.store.has(channel) && this.#host.subscriberCount(channel) > 0) {
				this.#host.dispatchServerAction(channel, {
					type: ActionType.ChangesetStatusChanged,
					status: ChangesetStatus.Error,
					error: { errorType: "gitChangesFailed", message: error instanceof Error ? error.message : String(error) },
				});
			}
		}
	}

	async #inspectWorkspace(entry: SessionEntry, signal?: AbortSignal): Promise<GitWorkspace | undefined> {
		await this.#options.authorizeResource?.(pathToFileURL(entry.session.workingDirectory).toString());
		return this.#git.inspect(entry.session.workingDirectory, signal);
	}

	#canPublish(entry: SessionEntry, abort: AbortController): boolean {
		return (
			!this.#disposed &&
			!entry.suspended &&
			!abort.signal.aborted &&
			this.#entries.get(entry.session.sessionId) === entry &&
			this.#options.getSession(entry.session.sessionId) !== undefined
		);
	}

	#scheduleRefresh(entry: SessionEntry): void {
		if (this.#disposed || entry.suspended || !this.#hasInterest(entry)) return;
		entry.refreshRequested = true;
		if (entry.refresh || entry.refreshTimer) return;
		const timer = setTimeout(() => {
			entry.refreshTimer = undefined;
			this.#requestRefresh(entry);
		}, this.#options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
		timer.unref?.();
		entry.refreshTimer = timer;
	}

	async #ensureWatcher(entry: SessionEntry): Promise<void> {
		await entry.watchClosing;
		if (entry.watchStarting) return entry.watchStarting;
		if (this.#disposed || entry.suspended || entry.watcher || !entry.workspace || !this.#hasInterest(entry)) {
			return;
		}
		const workspace = entry.workspace;
		const abort = new AbortController();
		entry.watchAbort = abort;
		const operation = this.#startWatcher(entry, workspace, abort.signal)
			.catch((error) => {
				if (!abort.signal.aborted) {
					this.#options.log?.(`cannot watch changes for ${entry.session.uri}: ${String(error)}`);
				}
			})
			.finally(() => {
				if (entry.watchStarting === operation) entry.watchStarting = undefined;
				if (entry.watchAbort === abort) entry.watchAbort = undefined;
			});
		entry.watchStarting = operation;
		await operation;
	}

	async #startWatcher(entry: SessionEntry, workspace: GitWorkspace, signal: AbortSignal): Promise<void> {
		const canWatch = (): boolean =>
			!signal.aborted &&
			!this.#disposed &&
			!entry.suspended &&
			sameWatchTarget(entry.workspace, workspace) &&
			this.#hasInterest(entry);
		if (!canWatch()) return;
		const metadataTargets = [
			join(workspace.gitDirectory, "HEAD"),
			join(workspace.gitDirectory, "index"),
			join(workspace.commonGitDirectory, "packed-refs"),
			join(workspace.commonGitDirectory, "refs"),
			join(workspace.commonGitDirectory, "info", "exclude"),
		];
		const metadataRoots = [workspace.gitDirectory, workspace.commonGitDirectory];
		let metadata: FileWatchSource | undefined;
		let recursive: FileWatchSource | undefined;
		let active: ChangesetWatcher | undefined;
		try {
			// Metadata may be outside the worktree. Watch only these Git-reported
			// targets; the workspace source has no native ignore policy.
			metadata = await openChokidarWatchTargets(
				{
					targets: metadataTargets,
					ignored: (path) => !metadataTargets.some((target) => isInside(path, target) || isInside(target, path)),
				},
				this.#options.metadataWatchFactory,
			);
			metadata.onChange(() => this.#scheduleRefresh(entry));
			if (!canWatch()) return;
			// Git ignore rules decide snapshot contents, not which paths a native
			// source observes. Resource watches can use this same canonical root.
			recursive = await this.#parcelPool.acquire(workspace.cwd);
			if (!canWatch()) return;
			const watcher: ChangesetWatcher = { target: workspace, recursive, metadata };
			recursive.onChange((path) => {
				if (metadataRoots.some((root) => isInside(root, path))) return;
				this.#scheduleRefresh(entry);
			});
			entry.watcher = watcher;
			active = watcher;
			metadata.onError((error) => this.#watcherFailed(entry, watcher, error));
			recursive.onError((error) => this.#watcherFailed(entry, watcher, error));
		} finally {
			if (!active) await this.#closeSources(entry, metadata, recursive);
		}
	}

	#watcherFailed(entry: SessionEntry, watcher: ChangesetWatcher, error: unknown): void {
		if (entry.watcher !== watcher) return;
		this.#options.log?.(`changeset watch failed for ${entry.session.uri}: ${String(error)}`);
		void this.#closeWatcher(entry);
	}

	async #closeSources(entry: SessionEntry, metadata?: FileWatchSource, recursive?: FileWatchSource): Promise<void> {
		const results = await Promise.allSettled([metadata?.close(), recursive?.close()]);
		for (const result of results) {
			if (result.status === "rejected") {
				this.#options.log?.(`closing changeset watch failed for ${entry.session.uri}: ${String(result.reason)}`);
			}
		}
	}

	#closeWatcher(entry: SessionEntry): Promise<void> {
		entry.watchAbort?.abort();
		if (entry.watchClosing) return entry.watchClosing;
		const operation = (async () => {
			await entry.watchStarting?.catch(() => undefined);
			const watcher = entry.watcher;
			if (!watcher) return;
			entry.watcher = undefined;
			await this.#closeSources(entry, watcher.metadata, watcher.recursive);
		})();
		entry.watchClosing = operation;
		void operation.finally(() => {
			if (entry.watchClosing === operation) entry.watchClosing = undefined;
		});
		return operation;
	}

	#disposeChannel(channel: URI): void {
		this.#cancelStateEviction(channel);
		if (!this.#host.store.has(channel)) return;
		this.#host.dispatchServerAction(channel, { type: ActionType.ChangesetCleared });
		this.#host.deleteChannel(channel);
	}
}
