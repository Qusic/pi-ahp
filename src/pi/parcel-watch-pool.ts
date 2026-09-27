/** Shares one native recursive subscription across watches of the same canonical root. */

import { openParcelWatchSource } from "./parcel-watch-source.ts";
import type { FileWatchChangeKind, FileWatchSource } from "./watch-source.ts";

type OpenSource = (root: string) => Promise<FileWatchSource>;

interface Subscriber {
	change?: (path: string, kind: FileWatchChangeKind) => void;
	error?: (error: unknown) => void;
	pendingError?: unknown;
	hasPendingError: boolean;
	closed: boolean;
}

interface SharedEntry {
	readonly root: string;
	readonly subscribers: Set<Subscriber>;
	readonly ready: Promise<FileWatchSource>;
	refs: number;
	failed: boolean;
	error?: unknown;
}

export class ParcelWatchPool {
	readonly #open: OpenSource;
	readonly #entries = new Map<string, SharedEntry>();
	readonly #closing = new Map<string, Promise<void>>();

	constructor(open: OpenSource = (root) => openParcelWatchSource({ root })) {
		this.#open = open;
	}

	async acquire(root: string): Promise<FileWatchSource> {
		const entry = this.#entries.get(root) ?? this.#createEntry(root);
		if (entry.failed) throw entry.error;
		const subscriber: Subscriber = { hasPendingError: false, closed: false };
		entry.refs++;
		entry.subscribers.add(subscriber);
		try {
			await entry.ready;
			if (entry.failed) throw entry.error;
		} catch (error) {
			subscriber.closed = true;
			entry.subscribers.delete(subscriber);
			await this.#release(entry);
			throw error;
		}

		let closing: Promise<void> | undefined;
		return {
			onChange: (listener) => {
				subscriber.change = listener;
			},
			onError: (listener) => {
				subscriber.error = listener;
				if (subscriber.hasPendingError) {
					const error = subscriber.pendingError;
					subscriber.hasPendingError = false;
					queueMicrotask(() => this.#reportError(subscriber, error));
				}
			},
			close: () => {
				if (closing) return closing;
				subscriber.closed = true;
				entry.subscribers.delete(subscriber);
				closing = this.#release(entry);
				return closing;
			},
		};
	}

	#createEntry(root: string): SharedEntry {
		let entry: SharedEntry;
		const previousClose = this.#closing.get(root);
		const ready = (previousClose ?? Promise.resolve())
			.then(() => this.#open(root))
			.then((source) => {
				source.onChange((path, kind) => {
					for (const subscriber of entry.subscribers) {
						if (subscriber.closed) continue;
						try {
							subscriber.change?.(path, kind);
						} catch (error) {
							this.#reportError(subscriber, error);
						}
					}
				});
				source.onError((error) => {
					if (entry.failed) return;
					entry.failed = true;
					entry.error = error;
					for (const subscriber of entry.subscribers) this.#reportError(subscriber, error);
				});
				return source;
			})
			.catch((error: unknown) => {
				if (this.#entries.get(root) === entry) this.#entries.delete(root);
				throw error;
			});
		entry = { root, subscribers: new Set(), ready, refs: 0, failed: false };
		this.#entries.set(root, entry);
		return entry;
	}

	#reportError(subscriber: Subscriber, error: unknown): void {
		if (subscriber.closed) return;
		if (!subscriber.error) {
			subscriber.hasPendingError = true;
			subscriber.pendingError = error;
			return;
		}
		try {
			subscriber.error(error);
		} catch (cause) {
			process.emitWarning(cause instanceof Error ? cause : String(cause));
		}
	}

	#release(entry: SharedEntry): Promise<void> {
		entry.refs--;
		if (entry.refs > 0) return Promise.resolve();
		const closing = entry.ready.then(
			(source) => source.close(),
			() => undefined,
		);
		this.#closing.set(entry.root, closing);
		if (this.#entries.get(entry.root) === entry) this.#entries.delete(entry.root);
		const clear = (): void => {
			if (this.#closing.get(entry.root) === closing) this.#closing.delete(entry.root);
		};
		void closing.then(clear, clear);
		return closing;
	}
}
