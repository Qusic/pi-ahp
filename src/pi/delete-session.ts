/**
 * Deleting a pi session file.
 *
 * Mirrors pi's own delete affordance (`/resume` → Ctrl+D): try the `trash` CLI
 * first so the file lands in the recycle bin, and fall back to `unlink` when it
 * is not installed. Disposal is destructive either way, so preferring `trash`
 * matters.
 */

import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

export interface DeleteResult {
	readonly ok: boolean;
	readonly method: "trash" | "unlink" | "missing";
	readonly error?: string;
}

export function deleteSessionFile(path: string): DeleteResult {
	if (!existsSync(path)) {
		return { ok: true, method: "missing" };
	}

	// `--` guards against a path that looks like a flag.
	const args = path.startsWith("-") ? ["--", path] : [path];
	const trashed = spawnSync("trash", args, { encoding: "utf-8" });
	if (!trashed.error && trashed.status === 0) {
		return { ok: true, method: "trash" };
	}
	// `trash` may report success oddly but still have moved the file.
	if (!existsSync(path)) {
		return { ok: true, method: "trash" };
	}

	try {
		unlinkSync(path);
		return { ok: true, method: "unlink" };
	} catch (error) {
		return { ok: false, method: "unlink", error: error instanceof Error ? error.message : String(error) };
	}
}
