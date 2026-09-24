/** Pure path filtering and per-batch transitions used by resource watches. */
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { ResourceChangeType } from "@microsoft/agent-host-protocol";

/** Returns a POSIX-style path below root, or undefined for an escaped path. */
export function relativeWatchPath(root: string, path: string): string | undefined {
	const result = relative(root, resolve(path));
	if (isAbsolute(result) || result === ".." || result.startsWith(`..${sep}`)) return undefined;
	return result.split(sep).join("/");
}

function matchesExcludePattern(path: string, pattern: string): boolean {
	if (matchesGlob(path, pattern) || matchesGlob(`${path}/x`, pattern)) {
		return true;
	}
	// Node's matchesGlob does not match hidden dot-segments against wildcards like **.
	// Allow dot names so e.g. **/node_modules/** matches node_modules/.pnpm/x.
	const noDots = path
		.split("/")
		.map((s) => (s.startsWith(".") && s !== "." && s !== ".." ? `_${s.slice(1)}` : s))
		.join("/");
	return matchesGlob(noDots, pattern) || matchesGlob(`${noDots}/x`, pattern);
}

export function isExcluded(path: string, excludes: readonly string[]): boolean {
	if (path.length === 0 || excludes.length === 0) return false;
	const segments = path.split("/");
	return excludes.some((pattern) => {
		let prefix = "";
		for (const segment of segments) {
			prefix = prefix ? `${prefix}/${segment}` : segment;
			if (matchesExcludePattern(prefix, pattern)) return true;
		}
		return false;
	});
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
