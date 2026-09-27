/** Native recursive directory events, with a narrow parent watch for root replacement. */

import { type FSWatcher, watch as nodeWatch } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FileWatchChangeKind, FileWatchSource } from "./watch-source.ts";

type ParcelApi = typeof import("@parcel/watcher");
type NativeSubscription = Awaited<ReturnType<ParcelApi["subscribe"]>>;

function nativeBackend(): "fs-events" | "inotify" | "windows" {
	switch (process.platform) {
		case "darwin":
			return "fs-events";
		case "linux":
			return "inotify";
		case "win32":
			return "windows";
		default:
			throw new Error(`Native recursive watching is unavailable on ${process.platform}`);
	}
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Undefined means the watched root is absent or no longer a directory. */
async function rootIdentity(root: string): Promise<string | undefined> {
	try {
		const stats = await stat(root);
		return stats.isDirectory() ? `${stats.dev}:${stats.ino}:${stats.birthtimeMs}` : undefined;
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
}

class ParcelWatchSource implements FileWatchSource {
	readonly #root: string;
	readonly #parcel: ParcelApi;
	readonly #backend: ReturnType<typeof nativeBackend>;
	#parent: FSWatcher | undefined;
	#native: NativeSubscription | undefined;
	#identity: string | undefined;
	#nextGeneration = 0;
	#activeGeneration = 0;
	#onChange: ((path: string, kind: FileWatchChangeKind) => void) | undefined;
	#onError: ((error: unknown) => void) | undefined;
	#earlyError: unknown = undefined;
	#opening = true;
	#closed = false;
	#failed = false;
	#reconcileRequested = false;
	#rootEventPending = false;
	#reconciling: Promise<void> | undefined;
	#closing: Promise<void> | undefined;

	constructor(root: string, parcel: ParcelApi, backend: ReturnType<typeof nativeBackend>) {
		this.#root = root;
		this.#parcel = parcel;
		this.#backend = backend;
	}

	async open(): Promise<void> {
		const identity = await rootIdentity(this.#root);
		if (!identity)
			throw Object.assign(new Error(`Cannot watch a missing directory: ${this.#root}`), { code: "ENOENT" });
		this.#identity = identity;
		const parent = dirname(this.#root);
		if (parent !== this.#root) {
			// Chokidar's snapshot of the parent can miss an atomic replacement when
			// the same name exists before and after it. We need only a raw trigger;
			// Parcel classifies and delivers all descendant changes.
			this.#parent = nodeWatch(parent, (_type, filename) => {
				if (filename !== null && !samePath(resolve(parent, filename), this.#root)) return;
				this.#requestReconcile(true);
			});
			this.#parent.on("error", (error) => this.#fail(error));
		}
		this.#native = await this.#subscribe();
		this.#opening = false;
		// Check once after both handles exist; replacement during startup must
		// not leave the native handle attached to the old directory.
		this.#requestReconcile();
		await this.#reconciling;
		if (this.#failed) throw this.#earlyError;
	}

	onChange(listener: (path: string, kind: FileWatchChangeKind) => void): void {
		this.#onChange = listener;
	}

	onError(listener: (error: unknown) => void): void {
		this.#onError = listener;
		// Allow the caller to finish publishing its resource before a startup-
		// adjacent error releases it.
		if (this.#failed) queueMicrotask(() => this.#report(this.#earlyError));
	}

	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#activeGeneration = 0;
		this.#parent?.close();
		this.#closing = (async () => {
			await this.#reconciling?.catch(() => undefined);
			const native = this.#native;
			this.#native = undefined;
			await native?.unsubscribe();
		})();
		return this.#closing;
	}

	async #subscribe(): Promise<NativeSubscription> {
		const generation = ++this.#nextGeneration;
		let pending = true;
		let startupError: Error | undefined;
		const subscription = await this.#parcel.subscribe(
			this.#root,
			(error, events) => {
				if (this.#closed || (!pending && generation !== this.#activeGeneration)) return;
				if (error) {
					if (pending) {
						startupError = error;
						return;
					}
					void rootIdentity(this.#root)
						.then((identity) => {
							if (identity !== this.#identity) this.#requestReconcile();
							else this.#fail(error);
						})
						.catch((cause: unknown) => this.#fail(cause));
					return;
				}
				if (pending) return; // No channel is ready to receive startup events.
				for (const event of events) {
					if (samePath(event.path, this.#root)) {
						// Native root event types can describe a child edit; compare the
						// directory identity before classifying the root itself.
						this.#requestReconcile(true);
						continue;
					}
					// FSEvents can label a pre-existing file's first modification as
					// create. Do not guess path history from its birthtime.
					const kind: FileWatchChangeKind =
						event.type === "create" ? "added" : event.type === "delete" ? "deleted" : "updated";
					this.#emitChange(event.path, kind);
				}
			},
			{ backend: this.#backend },
		);
		pending = false;
		if (startupError) {
			await subscription.unsubscribe();
			throw startupError;
		}
		this.#activeGeneration = generation;
		return subscription;
	}

	#requestReconcile(rootEvent = false): void {
		if (this.#closed || this.#failed) return;
		this.#reconcileRequested = true;
		this.#rootEventPending ||= rootEvent;
		if (this.#opening || this.#reconciling) return;
		const operation = this.#reconcileLoop();
		this.#reconciling = operation;
		void operation
			.catch((error: unknown) => this.#fail(error))
			.finally(() => {
				if (this.#reconciling !== operation) return;
				this.#reconciling = undefined;
				if (this.#reconcileRequested && !this.#closed && !this.#failed) this.#requestReconcile();
			});
	}

	async #reconcileLoop(): Promise<void> {
		while (this.#reconcileRequested && !this.#closed && !this.#failed) {
			this.#reconcileRequested = false;
			const rootEvent = this.#rootEventPending;
			this.#rootEventPending = false;
			await this.#reconcileRoot(rootEvent);
		}
	}

	async #reconcileRoot(rootEvent: boolean): Promise<void> {
		const observed = await rootIdentity(this.#root);
		if (this.#closed || this.#failed) return;
		if (observed === this.#identity && (observed === undefined || this.#native !== undefined)) {
			if (rootEvent && observed) this.#emitChange(this.#root, "updated");
			return;
		}

		const previous = this.#identity;
		const old = this.#native;
		this.#native = undefined;
		this.#activeGeneration = 0;
		await old?.unsubscribe();
		if (this.#closed || this.#failed) return;

		let current = await rootIdentity(this.#root);
		if (this.#closed || this.#failed) return;
		if (current) {
			try {
				const native = await this.#subscribe();
				if (this.#closed) {
					await native.unsubscribe();
					return;
				}
				this.#native = native;
			} catch (error) {
				// A second removal during subscribe is not a permanent failure: the
				// parent will signal the next appearance.
				if (await rootIdentity(this.#root)) throw error;
				current = undefined;
			}
		}
		this.#identity = current;
		if (previous && !current) this.#emitChange(this.#root, "deleted");
		else if (!previous && current) this.#emitChange(this.#root, "added");
		else if (previous && current) this.#emitChange(this.#root, "updated");
	}

	#emitChange(path: string, kind: FileWatchChangeKind): void {
		try {
			this.#onChange?.(path, kind);
		} catch (error) {
			// Exceptions escaping a native callback are fatal in Parcel's binding.
			this.#fail(error);
		}
	}

	#report(error: unknown): void {
		if (this.#closed) return;
		try {
			this.#onError?.(error);
		} catch (cause) {
			process.emitWarning(cause instanceof Error ? cause : String(cause));
		}
	}

	#fail(error: unknown): void {
		if (this.#closed || this.#failed) return;
		this.#failed = true;
		if (this.#onError) this.#report(error);
		else this.#earlyError = error;
	}
}

/** Opens the native backend only for an actual recursive directory request. */
export async function openParcelWatchSource(request: { readonly root: string }): Promise<FileWatchSource> {
	const backend = nativeBackend();
	// Keep narrow Chokidar watches usable when this native addon is unavailable.
	const parcel = (await import("@parcel/watcher")).default;
	const source = new ParcelWatchSource(request.root, parcel, backend);
	try {
		await source.open();
		return source;
	} catch (error) {
		await source.close();
		throw error;
	}
}
