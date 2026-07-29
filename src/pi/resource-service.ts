/**
 * The `resource*` command family — filesystem access over the protocol.
 *
 * These are connection-level (`channel: 'ahp-root://'`) and symmetrical: the
 * same nine methods may be issued in either direction. This module implements
 * the host side, backed by the local filesystem.
 *
 * They matter most when host and client are on different machines, which is the
 * case this host is built for: without them a remote client cannot browse,
 * open, or edit anything the agent is working on.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/root-channel
 */

import { constants } from "node:fs";
import {
	access,
	copyFile,
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	AhpErrorCodes,
	ContentEncoding,
	type DirectoryEntry,
	type ResourceCopyParams,
	type ResourceDeleteParams,
	type ResourceListResult,
	type ResourceMkdirParams,
	type ResourceMoveParams,
	type ResourceReadParams,
	type ResourceReadResult,
	type ResourceResolveParams,
	type ResourceResolveResult,
	ResourceType,
	ResourceWriteMode,
	type ResourceWriteParams,
} from "@microsoft/agent-host-protocol";
import { ProtocolError } from "../protocol/errors.ts";

export interface ResourceServiceOptions {
	/**
	 * Directories a client may reach, as filesystem paths.
	 *
	 * Empty (the default) means unrestricted, matching the reference host —
	 * which is honest rather than lax: a client that can reach this endpoint can
	 * already start a session and run shell commands, so a filesystem allowlist
	 * on its own is not a security boundary. Set roots when the endpoint is
	 * exposed more widely than the agent's own reach.
	 */
	readonly roots?: readonly string[];
}

/** Text types that survive a UTF-8 round-trip; everything else defaults to base64. */
const TEXT_EXTENSIONS = new Map<string, string>([
	[".txt", "text/plain"],
	[".md", "text/markdown"],
	[".json", "application/json"],
	[".js", "text/javascript"],
	[".mjs", "text/javascript"],
	[".ts", "text/x-typescript"],
	[".tsx", "text/x-typescript"],
	[".jsx", "text/javascript"],
	[".css", "text/css"],
	[".html", "text/html"],
	[".xml", "application/xml"],
	[".yaml", "application/yaml"],
	[".yml", "application/yaml"],
	[".toml", "application/toml"],
	[".sh", "text/x-shellscript"],
	[".py", "text/x-python"],
	[".rs", "text/x-rust"],
	[".go", "text/x-go"],
]);

function extensionOf(path: string): string {
	const base = path.slice(path.lastIndexOf(sep) + 1);
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

function isProbablyText(path: string): boolean {
	return TEXT_EXTENSIONS.has(extensionOf(path));
}

function errorCodeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Maps a Node filesystem error onto the protocol's error codes. */
function translate(error: unknown, uri: string): ProtocolError {
	switch (errorCodeOf(error)) {
		case "ENOENT":
			return ProtocolError.notFound(uri);
		case "EACCES":
		case "EPERM":
			return new ProtocolError(AhpErrorCodes.PermissionDenied, `Permission denied: ${uri}`);
		case "EEXIST":
			return new ProtocolError(AhpErrorCodes.AlreadyExists, `Already exists: ${uri}`);
		case "ENOTEMPTY":
			return new ProtocolError(AhpErrorCodes.Conflict, `Directory not empty: ${uri}`);
		case "EISDIR":
			return ProtocolError.invalidParams(`Is a directory: ${uri}`);
		case "ENOTDIR":
			return ProtocolError.invalidParams(`Not a directory: ${uri}`);
		default:
			return new ProtocolError(AhpErrorCodes.PermissionDenied, error instanceof Error ? error.message : String(error));
	}
}

export class ResourceService {
	readonly #roots: readonly string[];

	constructor(options: ResourceServiceOptions = {}) {
		this.#roots = (options.roots ?? []).map((root) => resolvePath(root));
	}

	// ── Path handling ───────────────────────────────────────────────────────

	/**
	 * Converts a `file:` URI to a path and enforces the root allowlist.
	 *
	 * The check runs against the **resolved real path** where the target
	 * exists, so a symlink cannot be used to step outside a root. For a path
	 * that does not exist yet (a write or mkdir target) the nearest existing
	 * ancestor is resolved instead, which closes the same hole for creation.
	 */
	async #toPath(uri: string): Promise<string> {
		if (!uri.startsWith("file://")) {
			throw ProtocolError.invalidParams(`Only file: URIs are supported, got: ${uri}`);
		}
		let path: string;
		try {
			path = fileURLToPath(uri);
		} catch {
			throw ProtocolError.invalidParams(`Malformed file URI: ${uri}`);
		}
		if (this.#roots.length > 0) {
			await this.#assertInsideRoot(path, uri);
		}
		return path;
	}

	async #assertInsideRoot(path: string, uri: string): Promise<void> {
		let candidate = resolvePath(path);
		for (;;) {
			try {
				candidate = await realpath(candidate);
				break;
			} catch (error) {
				if (errorCodeOf(error) !== "ENOENT") {
					throw translate(error, uri);
				}
				const parent = dirname(candidate);
				if (parent === candidate) {
					break; // Reached the filesystem root without resolving.
				}
				candidate = parent;
			}
		}

		const permitted = this.#roots.some(
			(root) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep),
		);
		if (!permitted) {
			throw new ProtocolError(AhpErrorCodes.PermissionDenied, `Outside the permitted roots: ${uri}`);
		}
	}

	// ── Commands ────────────────────────────────────────────────────────────

	async read(params: ResourceReadParams): Promise<ResourceReadResult> {
		const path = await this.#toPath(params.uri);
		try {
			const buffer = await readFile(path);
			// Honour an explicit request; otherwise pick from the extension and
			// fall back to base64, which round-trips anything.
			const encoding = params.encoding ?? (isProbablyText(path) ? ContentEncoding.Utf8 : ContentEncoding.Base64);
			const contentType = TEXT_EXTENSIONS.get(extensionOf(path));
			return {
				data: buffer.toString(encoding === ContentEncoding.Utf8 ? "utf8" : "base64"),
				encoding,
				...(contentType ? { contentType } : {}),
			};
		} catch (error) {
			throw translate(error, params.uri);
		}
	}

	async write(params: ResourceWriteParams): Promise<Record<string, never>> {
		const path = await this.#toPath(params.uri);
		const data = Buffer.from(params.data, params.encoding === ContentEncoding.Base64 ? "base64" : "utf8");

		if (params.createOnly) {
			try {
				await access(path, constants.F_OK);
				throw new ProtocolError(AhpErrorCodes.AlreadyExists, `Already exists: ${params.uri}`);
			} catch (error) {
				if (error instanceof ProtocolError) {
					throw error;
				}
				if (errorCodeOf(error) !== "ENOENT") {
					throw translate(error, params.uri);
				}
			}
		}

		const mode = params.mode ?? ResourceWriteMode.Truncate;
		if (mode !== ResourceWriteMode.Truncate && mode !== ResourceWriteMode.Append) {
			// `insert` needs read-modify-write with offset semantics this host
			// does not implement; rejecting is better than writing the wrong bytes.
			throw ProtocolError.invalidParams(`Unsupported write mode: ${mode}`);
		}
		if (params.position !== undefined && params.position !== 0) {
			throw ProtocolError.invalidParams("Positional writes are not supported");
		}

		try {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, data, { flag: mode === ResourceWriteMode.Append ? "a" : "w" });
			return {};
		} catch (error) {
			throw translate(error, params.uri);
		}
	}

	async list(uri: string): Promise<ResourceListResult> {
		const path = await this.#toPath(uri);
		try {
			const found = await readdir(path, { withFileTypes: true });
			const entries: DirectoryEntry[] = found.map((entry) => ({
				name: entry.name,
				type: entry.isDirectory() ? "directory" : "file",
			}));
			entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
			return { entries };
		} catch (error) {
			throw translate(error, uri);
		}
	}

	async resolve(params: ResourceResolveParams): Promise<ResourceResolveResult> {
		const path = await this.#toPath(params.uri);
		const followSymlinks = params.followSymlinks ?? true;
		try {
			const stats = followSymlinks ? await stat(path) : await lstat(path);
			const realPath = followSymlinks ? await realpath(path) : path;
			const type = stats.isDirectory()
				? ResourceType.Directory
				: stats.isSymbolicLink()
					? ResourceType.Symlink
					: ResourceType.File;
			const contentType = TEXT_EXTENSIONS.get(extensionOf(path));
			return {
				uri: pathToFileURL(realPath).toString(),
				type,
				size: stats.size,
				mtime: stats.mtime.toISOString(),
				ctime: stats.ctime.toISOString(),
				...(contentType ? { contentType } : {}),
				// Cheap change-detection token: enough for optimistic concurrency,
				// and stable as long as the file is untouched.
				etag: `${stats.mtimeMs}-${stats.size}`,
			};
		} catch (error) {
			throw translate(error, params.uri);
		}
	}

	async mkdir(params: ResourceMkdirParams): Promise<Record<string, never>> {
		const path = await this.#toPath(params.uri);
		try {
			await mkdir(path, { recursive: true });
			return {};
		} catch (error) {
			throw translate(error, params.uri);
		}
	}

	async delete(params: ResourceDeleteParams): Promise<Record<string, never>> {
		const path = await this.#toPath(params.uri);
		try {
			const stats = await lstat(path);
			if (stats.isDirectory() && !params.recursive) {
				// Non-recursive delete of a non-empty directory must fail rather
				// than quietly take the tree with it.
				await rm(path, { recursive: false });
			} else {
				await rm(path, { recursive: params.recursive ?? false, force: false });
			}
			return {};
		} catch (error) {
			throw translate(error, params.uri);
		}
	}

	async move(params: ResourceMoveParams): Promise<Record<string, never>> {
		const source = await this.#toPath(params.source);
		const destination = await this.#toPath(params.destination);
		await this.#guardDestination(destination, params.destination, params.failIfExists);
		try {
			await rename(source, destination);
			return {};
		} catch (error) {
			throw translate(error, params.source);
		}
	}

	async copy(params: ResourceCopyParams): Promise<Record<string, never>> {
		const source = await this.#toPath(params.source);
		const destination = await this.#toPath(params.destination);
		await this.#guardDestination(destination, params.destination, params.failIfExists);
		try {
			const stats = await lstat(source);
			if (stats.isDirectory()) {
				await cp(source, destination, { recursive: true });
			} else {
				await copyFile(source, destination);
			}
			return {};
		} catch (error) {
			throw translate(error, params.source);
		}
	}

	async #guardDestination(path: string, uri: string, failIfExists: boolean | undefined): Promise<void> {
		if (!failIfExists) {
			return;
		}
		try {
			await access(path, constants.F_OK);
		} catch (error) {
			if (errorCodeOf(error) === "ENOENT") {
				return;
			}
			throw translate(error, uri);
		}
		throw new ProtocolError(AhpErrorCodes.AlreadyExists, `Already exists: ${uri}`);
	}
}
