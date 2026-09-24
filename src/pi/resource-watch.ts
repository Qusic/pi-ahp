/**
 * Filesystem watchers — the `ahp-resource-watch:` channel.
 *
 * A watch has no dispose command. The protocol ties its lifetime to interest:
 * the receiver releases it once its subscribers go away, after a grace window
 * that lets a disconnected client reclaim the channel.
 *
 * The state itself never changes: `resourceWatchReducer` returns the same
 * object for `resourceWatch/changed`. Changes are transient event traffic.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/resource-watch-channel
 */

import { randomUUID } from "node:crypto";
import { type FSWatcher as NodeFSWatcher, statSync, watch as nodeWatch } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	ActionType,
	AhpErrorCodes,
	type CreateResourceWatchParams,
	type CreateResourceWatchResult,
	JsonRpcErrorCodes,
	type ResourceChange,
	ResourceChangeType,
	type ResourceWatchState,
	type URI,
} from "@microsoft/agent-host-protocol";
import { type FSWatcher, watch } from "chokidar";
import { RESOURCE_WATCH_SCHEME } from "../core/channels.ts";
import type { AhpHost } from "../core/host.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { ResourcePathPolicy } from "./resource-paths.ts";
import { isExcluded, matchesPatterns, mergeChange, relativeWatchPath } from "./resource-watch-policy.ts";

export interface ResourceWatchOptions {
	/** Shared access policy for the request/response and watch resource surfaces. */
	readonly pathPolicy?: ResourcePathPolicy;
	/** How long an unsubscribed watch remains available for reconnect. */
	readonly graceMs?: number;
	/** Maximum time to collect changes into one protocol action. */
	readonly debounceMs?: number;
	readonly log?: (message: string) => void;
}

const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 50;

interface NativeWatcherHandle {
	close(): Promise<void> | void;
}

interface SharedNativeWatcher {
	watcher: NodeFSWatcher | undefined;
	readonly parentWatcher: NodeFSWatcher;
	refCount: number;
	readonly listeners: Set<(filename: string | null) => void>;
	readonly errorListeners: Set<(error: unknown) => void>;
	identity: string | undefined;
}

interface ActiveWatch {
	readonly channel: URI;
	/** The path clients addressed; emitted event URIs retain this spelling. */
	readonly resourceRoot: string;
	/** The canonical path passed to chokidar or native watcher. */
	readonly watchedRoot: string;
	readonly watcher: NativeWatcherHandle;
	readonly excludes: readonly string[];
	readonly includes: readonly string[];
	pending: Map<string, ResourceChangeType>;
	flushTimer: NodeJS.Timeout | undefined;
	graceTimer: NodeJS.Timeout | undefined;
}

function errorCodeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function watchError(error: unknown, uri: string): ProtocolError {
	if (error instanceof ProtocolError) return error;
	switch (errorCodeOf(error)) {
		case "ENOENT":
			return ProtocolError.notFound(uri);
		case "EACCES":
		case "EPERM":
			return new ProtocolError(AhpErrorCodes.PermissionDenied, `Permission denied: ${uri}`);
		case "EINVAL":
		case "ENOTDIR":
			return ProtocolError.invalidParams(`Cannot watch ${uri}`);
		default:
			return new ProtocolError(
				JsonRpcErrorCodes.InternalError,
				`Cannot watch ${uri}: ${error instanceof Error ? error.message : String(error)}`,
			);
	}
}

function readPatterns(value: unknown, name: string): string[] {
	if (value === undefined) return [];
	if (typeof value !== "object" || value === null || !("items" in value)) {
		throw ProtocolError.invalidParams(`${name} must contain an items array`);
	}
	const { items } = value;
	if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
		throw ProtocolError.invalidParams(`${name}.items must be an array of strings`);
	}
	return [...items];
}

function waitUntilReady(watcher: FSWatcher): Promise<void> {
	return new Promise((resolveReady, rejectReady) => {
		const cleanup = (): void => {
			watcher.removeListener("ready", onReady);
			watcher.removeListener("error", onError);
		};
		const onReady = (): void => {
			cleanup();
			resolveReady();
		};
		const onError = (error: unknown): void => {
			cleanup();
			rejectReady(error);
		};
		watcher.once("ready", onReady);
		watcher.once("error", onError);
	});
}

/**
 * Owns native watcher handles and their lifetime. `StateStore` remains the
 * authority for protocol watch resources; this service retains only OS handles,
 * filters, and unpublished event batches.
 */
export class ResourceWatchService {
	readonly #host: AhpHost;
	readonly #options: ResourceWatchOptions;
	readonly #paths: ResourcePathPolicy;
	readonly #watches = new Map<URI, ActiveWatch>();
	readonly #unhook: () => void;
	/** Native setup/close operations that shutdown must drain, not protocol state. */
	readonly #pending = new Set<Promise<unknown>>();
	readonly #nativeRecursiveWatches = new Map<string, SharedNativeWatcher>();
	#disposed = false;
	#disposal: Promise<void> | undefined;

	constructor(host: AhpHost, options: ResourceWatchOptions = {}) {
		this.#host = host;
		this.#options = options;
		this.#paths = options.pathPolicy ?? new ResourcePathPolicy();
		this.#unhook = host.onSubscriberCountChanged((channel, count) => {
			this.#onSubscriberCount(channel, count);
		});
	}

	/** Releases every native watcher. Safe to call more than once. */
	dispose(): Promise<void> {
		if (this.#disposal) return this.#disposal;
		this.#disposed = true;
		this.#unhook();
		const releases = [...this.#watches.keys()].map((channel) => this.#release(channel));
		for (const shared of this.#nativeRecursiveWatches.values()) {
			shared.watcher?.close();
			shared.parentWatcher.close();
		}
		this.#nativeRecursiveWatches.clear();
		this.#disposal = Promise.allSettled([...this.#pending, ...releases]).then(() => {});
		return this.#disposal;
	}

	get activeCount(): number {
		return this.#watches.size;
	}

	create(params: CreateResourceWatchParams): Promise<CreateResourceWatchResult> {
		return this.#track(this.#create(params));
	}

	#track<T>(operation: Promise<T>): Promise<T> {
		const pending = operation.finally(() => this.#pending.delete(pending));
		this.#pending.add(pending);
		return pending;
	}

	async #create(params: CreateResourceWatchParams): Promise<CreateResourceWatchResult> {
		if (this.#disposed) {
			throw new Error("ResourceWatchService is disposed");
		}
		if (!params || typeof params !== "object") {
			throw ProtocolError.invalidParams("createResourceWatch params must be an object");
		}
		if (params.recursive !== undefined && typeof params.recursive !== "boolean") {
			throw ProtocolError.invalidParams("recursive must be a boolean");
		}
		const uri = params.uri;
		const recursive = params.recursive ?? false;
		const excludes = readPatterns(params.excludes, "excludes");
		const includes = readPatterns(params.includes, "includes");
		const resourceRoot = await this.#paths.pathFor(uri);

		let directory: boolean;
		let watchedRoot: string;
		try {
			const stats = await stat(resourceRoot);
			directory = stats.isDirectory();
			if (!directory && recursive) {
				throw ProtocolError.invalidParams(`Cannot watch a file recursively: ${uri}`);
			}
			// Watch the stable target but map events back to the URI spelling the
			// client supplied. This makes a directory symlink usable without letting
			// recursive watches follow further symlinks out of the permitted tree.
			watchedRoot = await realpath(resourceRoot);
		} catch (error) {
			throw watchError(error, uri);
		}

		if (this.#disposed) throw new Error("ResourceWatchService is disposed");

		const channel: URI = `${RESOURCE_WATCH_SCHEME}/${randomUUID()}`;
		const useNativeRecursive = recursive && (process.platform === "darwin" || process.platform === "win32");

		let watcherHandle: NativeWatcherHandle;
		let active: ActiveWatch;

		if (useNativeRecursive) {
			let shared = this.#nativeRecursiveWatches.get(watchedRoot);
			if (!shared) {
				const listeners = new Set<(filename: string | null) => void>();
				const errorListeners = new Set<(error: unknown) => void>();
				const reportError = (error: unknown): void => {
					this.#options.log?.(`native watch on ${watchedRoot} failed: ${String(error)}`);
					for (const listener of errorListeners) listener(error);
				};
				let watcher: NodeFSWatcher | undefined;
				let parentWatcher: NodeFSWatcher;
				try {
					watcher = nodeWatch(watchedRoot, { recursive: true }, (_eventType, filename) => {
						for (const listener of listeners) listener(filename);
					});
					// A non-recursive parent watch survives removal/replacement of watchedRoot.
					// Do not recursively watch the parent: it may contain other huge workspaces.
					parentWatcher = nodeWatch(dirname(watchedRoot), (_eventType, filename) => {
						if (filename && resolve(dirname(watchedRoot), filename) !== watchedRoot) return;
						const current = this.#nativeRecursiveWatches.get(watchedRoot);
						if (!current) return;
						let identity: string | undefined;
						try {
							const stats = statSync(watchedRoot);
							if (stats.isDirectory()) identity = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
						} catch (error) {
							if (errorCodeOf(error) !== "ENOENT") {
								reportError(error);
								return;
							}
						}
						if (identity === current.identity) return;
						current.watcher?.close();
						current.watcher = undefined;
						current.identity = identity;
						if (identity) {
							try {
							current.watcher = nodeWatch(watchedRoot, { recursive: true }, (_type, child) => {
								for (const listener of listeners) listener(child);
							});
							current.watcher.on("error", reportError);
							} catch (error) {
								reportError(error);
							}
						}
						for (const listener of listeners) listener("");
					});
				} catch (error) {
					watcher?.close();
					throw watchError(error, uri);
				}
				watcher.on("error", reportError);
				parentWatcher.on("error", reportError);
				let stats: ReturnType<typeof statSync>;
				try {
					stats = statSync(watchedRoot);
				} catch (error) {
					watcher?.close();
					parentWatcher.close();
					throw watchError(error, uri);
				}
				shared = {
					watcher, parentWatcher, refCount: 0, listeners, errorListeners,
					identity: `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`,
				};
				this.#nativeRecursiveWatches.set(watchedRoot, shared);
			}

			shared.refCount++;
			const onError = (error: unknown): void => {
				this.#options.log?.(`watch ${channel} failed: ${String(error)}`);
				void this.#release(channel);
			};
			shared.errorListeners.add(onError);
			const knownPaths = new Set<string>();
			const startTime = performance.timeOrigin + performance.now();
			const pathLocks = new Map<string, Promise<void>>();

			const onEvent = (filename: string | null): void => {
				if (filename === null) return;
				const fullPath = resolve(watchedRoot, filename);
				const rel = relativeWatchPath(watchedRoot, fullPath);
				if (rel === undefined || (rel.length > 0 && isExcluded(rel, excludes))) return;

				const prev = pathLocks.get(fullPath) ?? Promise.resolve();
				const task = prev
					.then(async () => {
						let stats: import("node:fs").Stats | undefined;
						let exists = false;
						try {
							stats = await lstat(fullPath);
							exists = true;
						} catch (error) {
							if (errorCodeOf(error) === "ENOENT") {
								exists = false;
							} else {
								return;
							}
						}

						// fs.watch reports that something changed, not a snapshot of each transition.
						// A rapid delete/recreate before lstat may therefore appear as an update.
						let type: ResourceChangeType;
						if (!exists) {
							knownPaths.delete(fullPath);
							for (const known of knownPaths) {
								if (known.startsWith(`${fullPath}/`)) {
									knownPaths.delete(known);
								}
							}
							type = ResourceChangeType.Deleted;
						} else if (knownPaths.has(fullPath)) {
							type = ResourceChangeType.Updated;
						} else if (stats && stats.birthtimeMs >= startTime) {
							knownPaths.add(fullPath);
							type = ResourceChangeType.Added;
						} else {
							knownPaths.add(fullPath);
							type = ResourceChangeType.Updated;
						}

						this.#record(active, fullPath, type);
					})
					.catch((error) => {
						this.#options.log?.(`error processing watch event for ${fullPath}: ${String(error)}`);
					})
					.finally(() => {
						if (pathLocks.get(fullPath) === task) {
							pathLocks.delete(fullPath);
						}
					});
				pathLocks.set(fullPath, task);
			};

			shared.listeners.add(onEvent);
			const currentShared = shared;
			watcherHandle = {
				close: () => {
					currentShared.listeners.delete(onEvent);
					currentShared.errorListeners.delete(onError);
					currentShared.refCount--;
					if (currentShared.refCount <= 0) {
						this.#nativeRecursiveWatches.delete(watchedRoot);
						try {
							currentShared.watcher?.close();
							currentShared.parentWatcher.close();
						} catch (error) {
							this.#options.log?.(`closing native watcher for ${watchedRoot} failed: ${String(error)}`);
						}
					}
				},
			};

			active = {
				channel,
				resourceRoot,
				watchedRoot,
				watcher: watcherHandle,
				excludes,
				includes,
				pending: new Map(),
				flushTimer: undefined,
				graceTimer: undefined,
			};
		} else {
			// Starting from the parent keeps the watch alive when an editor replaces a
			// file—or the watched directory itself—by rename. The ignored predicate
			// prevents siblings from entering chokidar's watched tree.
			const watchRoot = dirname(watchedRoot);
			const depth = !directory ? 0 : recursive ? undefined : watchRoot === watchedRoot ? 0 : 1;
			// Keep Chokidar's default persistent watcher: overlapping watches then
			// share native handles and forward asynchronous watcher errors. Polling or
			// `awaitWriteFinish` would change delivery timing rather than add protocol
			// state guarantees.
			const watcher = watch(watchRoot, {
				atomic: true,
				followSymlinks: false,
				ignoreInitial: true,
				...(depth === undefined ? {} : { depth }),
				ignored: (path: string) => {
					if (resolve(path) === watchRoot) return false;
					const rel = relativeWatchPath(watchedRoot, path);
					return rel === undefined || isExcluded(rel, excludes);
				},
			});
			try {
				// Let startup settle before closing: closing a not-yet-ready watcher
				// does not settle its ready waiter. Shutdown drains this creation task.
				await waitUntilReady(watcher);
				if (this.#disposed) throw new Error("ResourceWatchService is disposed");
			} catch (error) {
				await watcher.close();
				throw watchError(error, uri);
			}

			active = {
				channel,
				resourceRoot,
				watchedRoot,
				watcher,
				excludes,
				includes,
				pending: new Map(),
				flushTimer: undefined,
				graceTimer: undefined,
			};
			const record = (path: string, type: ResourceChangeType): void => this.#record(active, path, type);
			watcher
				.on("add", (path) => record(path, ResourceChangeType.Added))
				.on("addDir", (path) => record(path, ResourceChangeType.Added))
				.on("change", (path) => record(path, ResourceChangeType.Updated))
				.on("unlink", (path) => record(path, ResourceChangeType.Deleted))
				.on("unlinkDir", (path) => record(path, ResourceChangeType.Deleted))
				.on("error", (error) => {
					this.#options.log?.(`watch ${channel} failed: ${String(error)}`);
					void this.#release(channel);
				});
		}

		const state: ResourceWatchState = {
			root: uri,
			recursive,
			...(excludes.length > 0 ? { excludes: { items: [...excludes] } } : {}),
			...(includes.length > 0 ? { includes: { items: [...includes] } } : {}),
		};
		this.#host.store.create(channel, state as never);
		this.#watches.set(channel, active);

		// The client subscribes after this request returns. Start a grace timer so
		// an abandoned create cannot retain filesystem handles forever.
		this.#startGrace(active);
		return { channel };
	}

	// ── Change collection ───────────────────────────────────────────────────

	#record(active: ActiveWatch, watchedPath: string, type: ResourceChangeType): void {
		if (this.#watches.get(active.channel) !== active) return;
		const rel = relativeWatchPath(active.watchedRoot, watchedPath);
		if (rel === undefined || !matchesPatterns(rel, active.includes, active.excludes)) return;

		const path = rel.length === 0 ? active.resourceRoot : join(active.resourceRoot, rel);
		const merged = mergeChange(active.pending.get(path), type);
		if (merged === undefined) {
			active.pending.delete(path);
		} else {
			active.pending.set(path, merged);
		}

		if (active.pending.size === 0) {
			if (active.flushTimer) clearTimeout(active.flushTimer);
			active.flushTimer = undefined;
			return;
		}
		if (active.flushTimer) return;
		const timer = setTimeout(() => {
			active.flushTimer = undefined;
			this.#flush(active);
		}, this.#options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
		timer.unref?.();
		active.flushTimer = timer;
	}

	#flush(active: ActiveWatch): void {
		if (this.#watches.get(active.channel) !== active) {
			active.pending.clear();
			return;
		}
		const items: ResourceChange[] = [...active.pending]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([path, type]) => ({ uri: pathToFileURL(path).toString(), type }));
		active.pending.clear();
		if (items.length === 0) return;

		this.#host.dispatchServerAction(active.channel, {
			type: ActionType.ResourceWatchChanged,
			changes: { items },
		});
	}

	// ── Lifetime ────────────────────────────────────────────────────────────

	#onSubscriberCount(channel: URI, count: number): void {
		const active = this.#watches.get(channel);
		if (!active) return;
		if (count > 0) {
			if (active.graceTimer) {
				clearTimeout(active.graceTimer);
				active.graceTimer = undefined;
			}
			return;
		}
		this.#startGrace(active);
	}

	#startGrace(active: ActiveWatch): void {
		if (active.graceTimer) return;
		const timer = setTimeout(() => {
			active.graceTimer = undefined;
			if (this.#host.subscriberCount(active.channel) === 0) {
				this.#options.log?.(`releasing unwatched ${active.channel}`);
				void this.#release(active.channel);
			}
		}, this.#options.graceMs ?? DEFAULT_GRACE_MS);
		timer.unref?.();
		active.graceTimer = timer;
	}

	async #release(channel: URI): Promise<void> {
		const active = this.#watches.get(channel);
		if (!active) return;
		this.#watches.delete(channel);
		if (active.flushTimer) clearTimeout(active.flushTimer);
		if (active.graceTimer) clearTimeout(active.graceTimer);
		active.pending.clear();
		this.#host.store.delete(channel);
		try {
			await this.#track(Promise.resolve(active.watcher.close()));
		} catch (error) {
			this.#options.log?.(`closing watch ${channel} failed: ${String(error)}`);
		}
	}
}
