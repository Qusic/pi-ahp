/** Shared file-URI parsing and root policy for resource commands and watches. */

import { realpathSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AhpErrorCodes } from "@microsoft/agent-host-protocol";
import { ProtocolError } from "../protocol/errors.ts";

function errorCodeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Resolves symlinks in the existing prefix while preserving a missing suffix. */
async function canonicalPath(path: string): Promise<string> {
	const absolute = resolve(path);
	try {
		return await realpath(absolute);
	} catch (error) {
		if (errorCodeOf(error) !== "ENOENT") throw error;
	}

	try {
		if ((await lstat(absolute)).isSymbolicLink()) {
			const target = await readlink(absolute);
			return canonicalPath(resolve(dirname(absolute), target));
		}
	} catch (error) {
		if (errorCodeOf(error) !== "ENOENT") throw error;
	}

	const parent = dirname(absolute);
	return parent === absolute ? absolute : join(await canonicalPath(parent), basename(absolute));
}

/**
 * Converts resource URIs to local paths and applies the optional root allowlist.
 *
 * A single policy instance can be shared by request/response resource methods
 * and live resource watches, keeping both surfaces on the same access rules.
 * Empty roots intentionally mean unrestricted access: reaching this endpoint
 * already permits starting pi with shell tools, so this is not a sandbox.
 */
export class ResourcePathPolicy {
	readonly #roots: readonly string[];

	constructor(roots: readonly string[] = []) {
		this.#roots = roots.map((root) => realpathSync(resolve(root)));
	}

	async pathFor(uri: unknown): Promise<string> {
		if (typeof uri !== "string" || !uri.startsWith("file://")) {
			throw ProtocolError.invalidParams(`Only file: URIs are supported, got: ${uri}`);
		}
		let path: string;
		try {
			path = fileURLToPath(uri);
		} catch {
			throw ProtocolError.invalidParams(`Malformed file URI: ${uri}`);
		}
		if (this.#roots.length === 0) {
			return path;
		}

		let candidate: string;
		try {
			candidate = await canonicalPath(path);
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			throw new ProtocolError(AhpErrorCodes.PermissionDenied, error instanceof Error ? error.message : String(error));
		}
		const permitted = this.#roots.some(
			(root) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep),
		);
		if (!permitted) {
			throw new ProtocolError(AhpErrorCodes.PermissionDenied, `Outside the permitted roots: ${uri}`);
		}
		return path;
	}
}
