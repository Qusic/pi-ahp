/** Backend-neutral filesystem events; AHP channels and final filtering live above this layer. */

export type FileWatchChangeKind = "added" | "updated" | "deleted";

/** A ready watcher whose listeners remain owned by this handle until close. */
export interface FileWatchSource {
	onChange(listener: (path: string, kind: FileWatchChangeKind) => void): void;
	onError(listener: (error: unknown) => void): void;
	close(): Promise<void>;
}
