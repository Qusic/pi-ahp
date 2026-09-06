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

import { isUtf8 } from "node:buffer";
import { constants, type Dirent, type Stats } from "node:fs";
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
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import mime from "mime";
import { ProtocolError } from "../protocol/errors.ts";
import { ResourcePathPolicy } from "./resource-paths.ts";

export interface ResourceServiceOptions {
	/**
	 * Directories a client may reach, as filesystem paths.
	 *
	 * Empty (the default) means unrestricted, matching the reference host —
	 * which is honest rather than lax: a client that can reach this endpoint can
	 * already start a session and run shell commands, so a filesystem allowlist
	 * on its own is not a security boundary. Configured roots must already exist;
	 * they are canonicalized once so later symlink changes cannot retarget them.
	 */
	readonly roots?: readonly string[];
	/** Shared with resource watches when both surfaces use the same policy. */
	readonly pathPolicy?: ResourcePathPolicy;
}

function isUtf8Text(data: Buffer): boolean {
	return isUtf8(data) && !data.includes(0);
}

function contentTypeOf(path: string, textFallback = false): string | undefined {
	return mime.getType(path) ?? (textFallback ? "text/plain" : undefined);
}

function etagOf(stats: Stats): string {
	return `${stats.dev}-${stats.ino}-${stats.size}-${stats.mtimeMs}-${stats.ctimeMs}`;
}

function errorCodeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Maps a Node filesystem error onto the protocol's error codes. */
function translate(error: unknown, uri: string): ProtocolError {
	if (error instanceof ProtocolError) return error;
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
	readonly #paths: ResourcePathPolicy;
	readonly #writeTails = new Map<string, Promise<void>>();

	constructor(options: ResourceServiceOptions = {}) {
		this.#paths = options.pathPolicy ?? new ResourcePathPolicy(options.roots);
	}

	// ── Commands ────────────────────────────────────────────────────────────

	async read(params: ResourceReadParams): Promise<ResourceReadResult> {
		const path = await this.#paths.pathFor(params.uri);
		try {
			const buffer = await readFile(path);
			// Never claim UTF-8 when decoding would replace invalid bytes. Unknown
			// extensions still remain editable when their contents are valid text.
			const text = isUtf8Text(buffer);
			const encoding =
				params.encoding === ContentEncoding.Base64 || !text ? ContentEncoding.Base64 : ContentEncoding.Utf8;
			const contentType = contentTypeOf(path, text);
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
		const path = await this.#paths.pathFor(params.uri);
		if (params.encoding !== ContentEncoding.Base64 && params.encoding !== ContentEncoding.Utf8) {
			throw ProtocolError.invalidParams(`Unsupported content encoding: ${params.encoding}`);
		}
		const data = Buffer.from(params.data, params.encoding === ContentEncoding.Base64 ? "base64" : "utf8");
		const mode = params.mode ?? ResourceWriteMode.Truncate;
		if (mode !== ResourceWriteMode.Truncate && mode !== ResourceWriteMode.Append && mode !== ResourceWriteMode.Insert) {
			throw ProtocolError.invalidParams(`Unsupported write mode: ${mode}`);
		}
		const position = params.position ?? 0;
		if (!Number.isSafeInteger(position) || position < 0) {
			throw ProtocolError.invalidParams("Write position must be a non-negative integer");
		}
		if (params.ifMatch !== undefined && typeof params.ifMatch !== "string") {
			throw ProtocolError.invalidParams("ifMatch must be a string");
		}

		try {
			await this.#queueWrite(path, () => this.#writeLocked(path, params, data, mode, position));
			return {};
		} catch (error) {
			throw translate(error, params.uri);
		}
	}

	async #queueWrite(path: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.#writeTails.get(path) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.#writeTails.set(path, current);
		try {
			await current;
		} finally {
			if (this.#writeTails.get(path) === current) this.#writeTails.delete(path);
		}
	}

	async #writeLocked(
		path: string,
		params: ResourceWriteParams,
		data: Buffer,
		mode: ResourceWriteMode,
		position: number,
	): Promise<void> {
		if (params.createOnly && params.ifMatch === undefined) {
			await writeFile(path, data, { flag: "wx" });
			return;
		}

		if (params.ifMatch !== undefined) {
			let currentEtag: string | undefined;
			try {
				currentEtag = etagOf(await stat(path));
			} catch (error) {
				if (errorCodeOf(error) !== "ENOENT") throw error;
			}
			if (params.createOnly && currentEtag !== undefined) {
				throw new ProtocolError(AhpErrorCodes.AlreadyExists, `Already exists: ${params.uri}`);
			}
			if (params.ifMatch !== currentEtag) {
				throw new ProtocolError(AhpErrorCodes.Conflict, `ifMatch precondition failed: ${params.uri}`);
			}
		}

		if (position === 0 && mode !== ResourceWriteMode.Insert) {
			// Keep ordinary appends on O_APPEND; truncate remains a direct overwrite.
			await writeFile(path, data, { flag: mode === ResourceWriteMode.Append ? "a" : "w" });
			return;
		}

		let existing: Buffer;
		try {
			existing = await readFile(path);
		} catch (error) {
			if (errorCodeOf(error) !== "ENOENT") throw error;
			existing = Buffer.alloc(0);
		}
		const offset =
			mode === ResourceWriteMode.Append ? Math.max(0, existing.length - position) : Math.min(position, existing.length);
		const updated =
			mode === ResourceWriteMode.Truncate
				? Buffer.concat([existing.subarray(0, offset), data])
				: Buffer.concat([existing.subarray(0, offset), data, existing.subarray(offset)]);
		await writeFile(path, updated, { flag: "w" });
	}

	async list(uri: string): Promise<ResourceListResult> {
		const path = await this.#paths.pathFor(uri);
		try {
			const found = await readdir(path, { withFileTypes: true });
			const entries: DirectoryEntry[] = await Promise.all(
				found.map(async (entry) => ({
					name: entry.name,
					type: (await this.#isDirectoryEntry(path, entry)) ? "directory" : "file",
				})),
			);
			entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
			return { entries };
		} catch (error) {
			throw translate(error, uri);
		}
	}

	async #isDirectoryEntry(parent: string, entry: Dirent): Promise<boolean> {
		if (!entry.isSymbolicLink()) return entry.isDirectory();
		const path = join(parent, entry.name);
		try {
			await this.#paths.pathFor(pathToFileURL(path).toString());
			return (await stat(path)).isDirectory();
		} catch {
			// DirectoryEntry has no symlink kind; an unresolved or forbidden link is
			// safest as a non-navigable file entry.
			return false;
		}
	}

	async resolve(params: ResourceResolveParams): Promise<ResourceResolveResult> {
		const path = await this.#paths.pathFor(params.uri);
		const followSymlinks = params.followSymlinks ?? true;
		try {
			const stats = followSymlinks ? await stat(path) : await lstat(path);
			const realPath = followSymlinks ? await realpath(path) : path;
			const type = stats.isDirectory()
				? ResourceType.Directory
				: stats.isSymbolicLink()
					? ResourceType.Symlink
					: ResourceType.File;
			const contentType = type === ResourceType.File ? contentTypeOf(path) : undefined;
			return {
				uri: pathToFileURL(realPath).toString(),
				type,
				size: stats.size,
				mtime: stats.mtime.toISOString(),
				ctime: stats.ctime.toISOString(),
				...(contentType ? { contentType } : {}),
				// Opaque change token shared with resourceWrite's ifMatch check.
				etag: etagOf(stats),
			};
		} catch (error) {
			throw translate(error, params.uri);
		}
	}

	async mkdir(params: ResourceMkdirParams): Promise<Record<string, never>> {
		const path = await this.#paths.pathFor(params.uri);
		try {
			await mkdir(path, { recursive: true });
			return {};
		} catch (error) {
			throw translate(error, params.uri);
		}
	}

	async delete(params: ResourceDeleteParams): Promise<Record<string, never>> {
		const path = await this.#paths.pathFor(params.uri);
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
		const source = await this.#paths.pathFor(params.source);
		const destination = await this.#paths.pathFor(params.destination);
		await this.#guardDestination(destination, params.destination, params.failIfExists);
		try {
			await rename(source, destination);
			return {};
		} catch (error) {
			throw translate(error, params.source);
		}
	}

	async copy(params: ResourceCopyParams): Promise<Record<string, never>> {
		const source = await this.#paths.pathFor(params.source);
		const destination = await this.#paths.pathFor(params.destination);
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
