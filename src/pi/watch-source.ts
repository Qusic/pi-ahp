/** Backend-neutral filesystem events; AHP channels and final filtering live above this layer. */

export type FileWatchChangeKind = "added" | "updated" | "deleted";

/**
 * A ready watcher with one change and one error listener per handle; re-registering replaces them.
 * Events before listener registration are not guaranteed to be replayed. Listeners last until close.
 */
export interface FileWatchSource {
	onChange(listener: (path: string, kind: FileWatchChangeKind) => void): void;
	onError(listener: (error: unknown) => void): void;
	close(): Promise<void>;
}
