/** Chokidar filesystem events, independent of protocol channels and final filtering. */

import { dirname, resolve } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { FileWatchSource } from "./watch-source.ts";

/** Chokidar-specific traversal options. */
interface ChokidarWatchRequest {
	/** Canonical path to a file or directory. */
	readonly root: string;
	readonly directory: boolean;
	readonly recursive: boolean;
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

/** Preserves Chokidar's file, directory, and recursive-watch behavior. */
export async function openChokidarWatchSource(request: ChokidarWatchRequest): Promise<FileWatchSource> {
	// Starting from the parent keeps the watch alive when an editor replaces a
	// file—or the watched directory itself—by rename. Do not traverse siblings.
	const watchRoot = dirname(request.root);
	const depth = !request.directory ? 0 : request.recursive ? undefined : watchRoot === request.root ? 0 : 1;
	// Keep the default persistent watcher so overlapping watches share native
	// handles. Polling or awaitWriteFinish would change delivery timing.
	const watcher = watch(watchRoot, {
		atomic: true,
		followSymlinks: false,
		ignoreInitial: true,
		...(depth === undefined ? {} : { depth }),
		ignored: (path: string) => resolve(path) !== watchRoot && request.ignored(path),
	});
	try {
		// Closing before ready does not settle its waiter. The caller drains this
		// startup task on shutdown and closes the handle after it settles.
		await waitUntilReady(watcher);
	} catch (error) {
		await watcher.close();
		throw error;
	}

	return {
		onChange(listener) {
			watcher
				.on("add", (path) => listener(path, "added"))
				.on("addDir", (path) => listener(path, "added"))
				.on("change", (path) => listener(path, "updated"))
				.on("unlink", (path) => listener(path, "deleted"))
				.on("unlinkDir", (path) => listener(path, "deleted"));
		},
		onError(listener) {
			watcher.on("error", listener);
		},
		close: () => watcher.close(),
	};
}
