/**
 * Filesystem watchers — the `ahp-resource-watch:` channel.
 *
 * A watch has no dispose command. The protocol ties its lifetime to interest:
 * the receiver releases it once its subscribers go away. That makes the channel
 * unusual — it owns an OS resource that must be reclaimed without anyone
 * explicitly asking, and it must survive the gap while a client reconnects.
 *
 * The state itself never changes: `resourceWatchReducer` returns the same
 * object for `resourceWatch/changed`. The state describes *what* is being
 * watched; the changes are pure event traffic.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/resource-watch-channel
 */

import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	ActionType,
	type CreateResourceWatchParams,
	type CreateResourceWatchResult,
	type ResourceChange,
	ResourceChangeType,
	type ResourceWatchState,
	type URI,
} from "@microsoft/agent-host-protocol";
import { RESOURCE_WATCH_SCHEME } from "../core/channels.ts";
import type { AhpHost } from "../core/host.ts";
import { ProtocolError } from "../protocol/errors.ts";

export interface ResourceWatchOptions {
	/**
	 * How long a watch survives with no subscribers.
	 *
	 * Without a grace window a client that drops its socket and reconnects would
	 * find its watch already gone. Matches the "subject to the receiver's grace
	 * window" language the reference client's filesystem interface uses.
	 */
	readonly graceMs?: number;
	/**
	 * How long to gather changes before emitting them.
	 *
	 * The action carries a *batch*, and editors produce bursts — a single save
	 * can fire several events for one file.
	 */
	readonly debounceMs?: number;
	readonly log?: (message: string) => void;
}

const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 50;

interface ActiveWatch {
	readonly channel: URI;
	readonly root: string;
	readonly watcher: FSWatcher;
	readonly excludes: readonly string[];
	readonly includes: readonly string[];
	/** Paths seen since the last flush, so a burst collapses into one batch. */
	pending: Set<string>;
	flushTimer: NodeJS.Timeout | undefined;
	graceTimer: NodeJS.Timeout | undefined;
}

export class ResourceWatchService {
	readonly #host: AhpHost;
	readonly #options: ResourceWatchOptions;
	readonly #watches = new Map<URI, ActiveWatch>();
	readonly #unhook: () => void;

	constructor(host: AhpHost, options: ResourceWatchOptions = {}) {
		this.#host = host;
		this.#options = options;
		this.#unhook = host.onSubscriberCountChanged((channel, count) => {
			this.#onSubscriberCount(channel, count);
		});
	}

	/** Releases every watch. For host shutdown and tests. */
	dispose(): void {
		this.#unhook();
		for (const channel of [...this.#watches.keys()]) {
			this.#release(channel);
		}
	}

	get activeCount(): number {
		return this.#watches.size;
	}

	async create(params: CreateResourceWatchParams): Promise<CreateResourceWatchResult> {
		if (!params?.uri?.startsWith("file://")) {
			throw ProtocolError.invalidParams(`Only file: URIs can be watched, got: ${params?.uri}`);
		}
		const root = fileURLToPath(params.uri);
		try {
			const stats = await stat(root);
			if (!stats.isDirectory() && params.recursive) {
				throw ProtocolError.invalidParams(`Cannot watch a file recursively: ${params.uri}`);
			}
		} catch (error) {
			if (error instanceof ProtocolError) {
				throw error;
			}
			throw ProtocolError.notFound(params.uri);
		}

		const channel: URI = `${RESOURCE_WATCH_SCHEME}/${randomUUID()}`;
		const recursive = params.recursive ?? false;
		const excludes = params.excludes?.items ?? [];
		const includes = params.includes?.items ?? [];

		const state: ResourceWatchState = {
			root: params.uri,
			recursive,
			...(excludes.length > 0 ? { excludes: { items: [...excludes] } } : {}),
			...(includes.length > 0 ? { includes: { items: [...includes] } } : {}),
		};
		this.#host.store.create(channel, state as never);

		let watcher: FSWatcher;
		try {
			watcher = watch(root, { recursive, persistent: false });
		} catch (error) {
			this.#host.store.delete(channel);
			throw ProtocolError.invalidParams(
				`Cannot watch ${params.uri}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const active: ActiveWatch = {
			channel,
			root,
			watcher,
			excludes,
			includes,
			pending: new Set(),
			flushTimer: undefined,
			graceTimer: undefined,
		};
		this.#watches.set(channel, active);

		watcher.on("change", (_event, filename) => {
			if (filename !== null && filename !== undefined) {
				this.#record(active, typeof filename === "string" ? filename : filename.toString("utf8"));
			}
		});
		watcher.on("error", (error) => {
			this.#options.log?.(`watch ${channel} failed: ${String(error)}`);
			this.#release(channel);
		});

		// Nothing is subscribed yet — the client subscribes after this returns —
		// so start the grace timer now. Otherwise a client that opens a watch and
		// then never subscribes would leak it forever.
		this.#startGrace(active);
		return { channel };
	}

	// ── Change collection ───────────────────────────────────────────────────

	#record(active: ActiveWatch, filename: string): void {
		const path = isAbsolute(filename) ? filename : join(active.root, filename);
		if (!this.#matches(active, path)) {
			return;
		}
		active.pending.add(path);
		if (active.flushTimer) {
			return;
		}
		const timer = setTimeout(() => {
			active.flushTimer = undefined;
			void this.#flush(active);
		}, this.#options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
		timer.unref?.();
		active.flushTimer = timer;
	}

	/**
	 * Applies the include/exclude globs, which are relative to the watch root.
	 *
	 * Note the conventional asymmetry: a `node_modules` exclude pattern ending in
	 * a trailing globstar matches paths *inside* the directory, not the directory
	 * entry itself — so a client that excludes it still learns the folder
	 * appeared. That is useful (a file tree can render it collapsed) and leaks
	 * nothing about its contents.
	 */
	#matches(active: ActiveWatch, path: string): boolean {
		const rel = relative(active.root, path).split(sep).join("/");
		if (rel.length === 0) {
			return false;
		}
		if (active.excludes.some((pattern) => matchesGlob(rel, pattern))) {
			return false;
		}
		if (active.includes.length > 0 && !active.includes.some((pattern) => matchesGlob(rel, pattern))) {
			return false;
		}
		return true;
	}

	/**
	 * Turns collected paths into typed changes.
	 *
	 * `fs.watch` reports only `rename` or `change`, which does not distinguish
	 * creation from deletion, so each path is stat-ed at flush time. Anything
	 * gone by then is a delete — which is also why the batch is what gets
	 * classified rather than each raw event.
	 */
	async #flush(active: ActiveWatch): Promise<void> {
		const paths = [...active.pending];
		active.pending.clear();
		if (paths.length === 0 || !this.#watches.has(active.channel)) {
			return;
		}

		const items: ResourceChange[] = await Promise.all(
			paths.map(async (path) => {
				const uri = pathToFileURL(path).toString();
				try {
					await stat(path);
					return { uri, type: ResourceChangeType.Updated };
				} catch {
					return { uri, type: ResourceChangeType.Deleted };
				}
			}),
		);

		this.#host.dispatchServerAction(active.channel, {
			type: ActionType.ResourceWatchChanged,
			changes: { items },
		});
	}

	// ── Lifetime ────────────────────────────────────────────────────────────

	#onSubscriberCount(channel: URI, count: number): void {
		const active = this.#watches.get(channel);
		if (!active) {
			return;
		}
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
		if (active.graceTimer) {
			return;
		}
		const timer = setTimeout(() => {
			active.graceTimer = undefined;
			if (this.#host.subscriberCount(active.channel) === 0) {
				this.#options.log?.(`releasing unwatched ${active.channel}`);
				this.#release(active.channel);
			}
		}, this.#options.graceMs ?? DEFAULT_GRACE_MS);
		timer.unref?.();
		active.graceTimer = timer;
	}

	#release(channel: URI): void {
		const active = this.#watches.get(channel);
		if (!active) {
			return;
		}
		this.#watches.delete(channel);
		if (active.flushTimer) {
			clearTimeout(active.flushTimer);
		}
		if (active.graceTimer) {
			clearTimeout(active.graceTimer);
		}
		active.watcher.close();
		this.#host.store.delete(channel);
	}
}
