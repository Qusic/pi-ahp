/** Chokidar filesystem events, independent of protocol channels and final filtering. */

import { dirname, resolve } from "node:path";
import { type ChokidarOptions, type FSWatcher, watch } from "chokidar";
import type { FileWatchChangeKind, FileWatchSource } from "./watch-source.ts";

export type ChokidarWatchFactory = (paths: string | string[], options: ChokidarOptions) => FSWatcher;

/** Chokidar-specific traversal options. */
interface ChokidarWatchRequest {
	/** Canonical path to a file or directory. */
	readonly root: string;
	readonly directory: boolean;
	/** Advisory traversal pruning; callers must still filter reported events. */
	readonly ignored: (path: string) => boolean;
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

/** A ready handle that retains changes and errors arriving before listeners attach. */
async function readySource(watcher: FSWatcher): Promise<FileWatchSource> {
	let changeListener: ((path: string, kind: FileWatchChangeKind) => void) | undefined;
	let errorListener: ((error: unknown) => void) | undefined;
	let earlyError: { error: unknown } | undefined;
	let closing: Promise<void> | undefined;
	const pending: { path: string; kind: FileWatchChangeKind }[] = [];
	const reportError = (error: unknown): void => {
		if (closing) return;
		if (!errorListener) {
			earlyError ??= { error };
			return;
		}
		try {
			errorListener(error);
		} catch (cause) {
			process.emitWarning(cause instanceof Error ? cause : String(cause));
		}
	};
	const changed =
		(kind: FileWatchChangeKind) =>
		(path: string): void => {
			if (closing) return;
			if (!changeListener) {
				pending.push({ path, kind });
				return;
			}
			try {
				changeListener(path, kind);
			} catch (error) {
				reportError(error);
			}
		};
	watcher
		.on("add", changed("added"))
		.on("addDir", changed("added"))
		.on("change", changed("updated"))
		.on("unlink", changed("deleted"))
		.on("unlinkDir", changed("deleted"))
		.on("error", reportError);
	try {
		await waitUntilReady(watcher);
	} catch (error) {
		await watcher.close();
		throw error;
	}
	return {
		onChange(listener) {
			changeListener = listener;
			for (const { path, kind } of pending.splice(0)) changed(kind)(path);
		},
		onError(listener) {
			errorListener = listener;
			if (earlyError) {
				const { error } = earlyError;
				earlyError = undefined;
				queueMicrotask(() => reportError(error));
			}
		},
		close() {
			if (closing) return closing;
			pending.length = 0;
			closing = watcher.close();
			return closing;
		},
	};
}

/** Preserves Chokidar's single-file and non-recursive directory behavior. */
export async function openChokidarWatchSource(request: ChokidarWatchRequest): Promise<FileWatchSource> {
	// Starting from the parent keeps the watch alive when an editor replaces a
	// file—or the watched directory itself—by rename. Do not traverse siblings.
	const watchRoot = dirname(request.root);
	const depth = request.directory && watchRoot !== request.root ? 1 : 0;
	// Keep the default persistent watcher so overlapping watches share native
	// handles. Polling or awaitWriteFinish would change delivery timing.
	const watcher = watch(watchRoot, {
		atomic: true,
		followSymlinks: false,
		ignoreInitial: true,
		depth,
		ignored: (path: string) => resolve(path) !== watchRoot && request.ignored(path),
	});
	// Closing before ready does not settle its waiter. The caller drains this
	// startup task on shutdown and closes the handle after it settles.
	return readySource(watcher);
}

/** Watches a caller-selected set of narrow paths, with its own traversal policy. */
export function openChokidarWatchTargets(
	request: { readonly targets: readonly string[]; readonly ignored: (path: string) => boolean },
	watchFactory: ChokidarWatchFactory = watch,
): Promise<FileWatchSource> {
	return readySource(
		watchFactory([...request.targets], {
			ignoreInitial: true,
			followSymlinks: false,
			ignored: request.ignored,
		}),
	);
}
