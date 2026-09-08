/** Pure path filtering and per-batch transitions used by resource watches. */
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { ResourceChangeType } from "@microsoft/agent-host-protocol";

/** Returns a POSIX-style path below root, or undefined for an escaped path. */
export function relativeWatchPath(root: string, path: string): string | undefined {
	const result = relative(root, resolve(path));
	if (isAbsolute(result) || result === ".." || result.startsWith(`..${sep}`)) return undefined;
	return result.split(sep).join("/");
}

export function isExcluded(path: string, excludes: readonly string[]): boolean {
	return path.length > 0 && excludes.some((pattern) => matchesGlob(path, pattern));
}

export function matchesPatterns(path: string, includes: readonly string[], excludes: readonly string[]): boolean {
	// The root itself is always in scope; filters describe its descendants.
	if (path.length === 0) return true;
	return (
		!isExcluded(path, excludes) && (includes.length === 0 || includes.some((pattern) => matchesGlob(path, pattern)))
	);
}

/** Coalesces one path's transitions without losing its state at batch boundaries. */
export function mergeChange(
	previous: ResourceChangeType | undefined,
	next: ResourceChangeType,
): ResourceChangeType | undefined {
	if (previous === undefined) return next;
	if (previous === ResourceChangeType.Added)
		return next === ResourceChangeType.Deleted ? undefined : ResourceChangeType.Added;
	if (previous === ResourceChangeType.Deleted)
		return next === ResourceChangeType.Deleted ? ResourceChangeType.Deleted : ResourceChangeType.Updated;
	return next === ResourceChangeType.Deleted ? ResourceChangeType.Deleted : ResourceChangeType.Updated;
}
