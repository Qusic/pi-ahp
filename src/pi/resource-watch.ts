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
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
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

interface ActiveWatch {
	readonly channel: URI;
	/** The path clients addressed; emitted event URIs retain this spelling. */
	readonly resourceRoot: string;
	/** The canonical path passed to chokidar. */
	readonly watchedRoot: string;
	readonly watcher: FSWatcher;
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

/** Returns a POSIX-style path below root, or undefined for an escaped path. */
function relativeWatchPath(root: string, path: string): string | undefined {
	const result = relative(root, resolve(path));
	if (isAbsolute(result) || result === ".." || result.startsWith(`..${sep}`)) {
		return undefined;
	}
	return result.split(sep).join("/");
}

function isExcluded(path: string, excludes: readonly string[]): boolean {
	return path.length > 0 && excludes.some((pattern) => matchesGlob(path, pattern));
}

function matchesPatterns(path: string, includes: readonly string[], excludes: readonly string[]): boolean {
	// The watched resource itself is always in scope. Patterns describe paths
	// relative to it and primarily exist to prune directory descendants.
	if (path.length === 0) return true;
	return (
		!isExcluded(path, excludes) && (includes.length === 0 || includes.some((pattern) => matchesGlob(path, pattern)))
	);
}

/** Coalesces one path's transitions without losing its state at batch boundaries. */
function mergeChange(
	previous: ResourceChangeType | undefined,
	next: ResourceChangeType,
): ResourceChangeType | undefined {
	if (previous === undefined) return next;
	if (previous === ResourceChangeType.Added) {
		return next === ResourceChangeType.Deleted ? undefined : ResourceChangeType.Added;
	}
	if (previous === ResourceChangeType.Deleted) {
		return next === ResourceChangeType.Deleted ? ResourceChangeType.Deleted : ResourceChangeType.Updated;
	}
	return next === ResourceChangeType.Deleted ? ResourceChangeType.Deleted : ResourceChangeType.Updated;
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

export class ResourceWatchService {
	readonly #host: AhpHost;
	readonly #options: ResourceWatchOptions;
	readonly #paths: ResourcePathPolicy;
	readonly #watches = new Map<URI, ActiveWatch>();
	readonly #unhook: () => void;
	#disposed = false;

	constructor(host: AhpHost, options: ResourceWatchOptions = {}) {
		this.#host = host;
		this.#options = options;
		this.#paths = options.pathPolicy ?? new ResourcePathPolicy();
		this.#unhook = host.onSubscriberCountChanged((channel, count) => {
			this.#onSubscriberCount(channel, count);
		});
	}

	/** Releases every native watcher. Safe to call more than once. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unhook();
		await Promise.all([...this.#watches.keys()].map((channel) => this.#release(channel)));
	}

	get activeCount(): number {
		return this.#watches.size;
	}

	async create(params: CreateResourceWatchParams): Promise<CreateResourceWatchResult> {
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

		// Starting from the parent keeps the watch alive when an editor replaces a
		// file—or the watched directory itself—by rename. The ignored predicate
		// prevents siblings from entering chokidar's watched tree.
		const watchRoot = dirname(watchedRoot);
		const depth = !directory ? 0 : recursive ? undefined : watchRoot === watchedRoot ? 0 : 1;
		const watcher = watch(watchRoot, {
			atomic: true,
			followSymlinks: false,
			ignoreInitial: true,
			persistent: false,
			...(depth === undefined ? {} : { depth }),
			ignored: (path: string) => {
				if (resolve(path) === watchRoot) return false;
				const rel = relativeWatchPath(watchedRoot, path);
				return rel === undefined || isExcluded(rel, excludes);
			},
		});
		try {
			await waitUntilReady(watcher);
		} catch (error) {
			await watcher.close();
			throw watchError(error, uri);
		}

		const channel: URI = `${RESOURCE_WATCH_SCHEME}/${randomUUID()}`;
		const active: ActiveWatch = {
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
			await active.watcher.close();
		} catch (error) {
			this.#options.log?.(`closing watch ${channel} failed: ${String(error)}`);
		}
	}
}
