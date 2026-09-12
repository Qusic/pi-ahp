/**
 * Deleting a pi session file.
 *
 * Mirrors pi's own delete affordance (`/resume` → Ctrl+D): try the `trash` CLI
 * first so the file lands in the recycle bin, and fall back to `unlink` when
 * `trash` is unavailable or fails. Disposal is destructive either way, so
 * preferring `trash` matters.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, unlinkSync } from "node:fs";

export interface DeleteResult {
	readonly ok: boolean;
	readonly method: "trash" | "unlink" | "missing";
	readonly error?: string;
}

function isMissing(path: string): boolean {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR";
	}
}

export function deleteSessionFile(path: string): DeleteResult {
	if (isMissing(path)) {
		return { ok: true, method: "missing" };
	}

	// `--` guards against a path that looks like a flag.
	const args = path.startsWith("-") ? ["--", path] : [path];
	spawnSync("trash", args, { encoding: "utf-8" });
	// Process status alone is not enough for the disposal contract: a wrapper or
	// broken installation can exit successfully without moving the file.
	if (isMissing(path)) {
		return { ok: true, method: "trash" };
	}

	try {
		unlinkSync(path);
		return { ok: true, method: "unlink" };
	} catch (error) {
		// Another process deleting the same session is still the desired outcome.
		if (isMissing(path)) {
			return { ok: true, method: "missing" };
		}
		return { ok: false, method: "unlink", error: error instanceof Error ? error.message : String(error) };
	}
}
