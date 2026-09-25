/**
 * The session catalogue, backed by pi's on-disk session files.
 *
 * Production points it at pi's default per-directory JSONL tree under
 * `getAgentDir()/sessions`; tests and embeddings provide their root explicitly.
 * It does not resolve pi's optional custom `sessionDir` setting. Parsing a
 * summary reads the session file, so `listSessions` stats and sorts the corpus
 * but parses only the requested page.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/root-channel
 */

import { closeSync, openSync, readSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type ListSessionsResult, SessionStatus, type SessionSummary, type URI } from "@microsoft/agent-host-protocol";
import { sessionUri } from "../core/channels.ts";
import { pathToFileUri } from "../core/uri.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { MetadataStore } from "./metadata-store.ts";
import { PI_PROVIDER } from "./provider.ts";
import { sessionDisplayTitle } from "./session-title.ts";
import { textFromPiUserContent } from "./user-message.ts";

/** Page size when the client does not ask for one. */
const DEFAULT_PAGE_SIZE = 30;
/** Upper bound regardless of what the client asks for; each entry costs a file parse. */
const MAX_PAGE_SIZE = 100;
/** Enough for pi's session header line, which is written first. */
const HEADER_SCAN_BYTES = 8192;

interface SessionFile {
	readonly path: string;
	readonly mtimeMs: number;
}

/** In-memory summary for a session that may not have reached disk yet. */
export interface LiveSessionCatalogueEntry {
	readonly file?: string;
	readonly summary: SessionSummary;
}

/** Read lazily so a turn ending during disk discovery wins before the response is built. */
export type LiveSessionCatalogueSource = () => readonly LiveSessionCatalogueEntry[];

interface CatalogueEntry extends SessionFile {
	/** Real file to parse; absent for a live session with no backing path. */
	readonly file?: string;
	/** Whether the file existed in this catalogue scan and is safe to cache. */
	readonly onDisk?: boolean;
	/** Present when live state is more authoritative than the file. */
	readonly summary?: SessionSummary;
}

/**
 * Every session file with its mtime, newest first.
 *
 * `stat` only — no parsing. mtime is a good proxy for pi's own "last activity"
 * ordering because the file is appended on every message.
 */
async function listSessionFiles(root: string): Promise<SessionFile[]> {
	let directories: string[];
	try {
		directories = await readdir(root);
	} catch (error) {
		// No sessions directory yet is an empty catalogue, not an error.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}

	const files: SessionFile[] = [];
	await Promise.all(
		directories.map(async (directory) => {
			const directoryPath = join(root, directory);
			let entries: string[];
			try {
				entries = await readdir(directoryPath);
			} catch {
				return; // A file (not a directory) at the top level, or a race with deletion.
			}
			await Promise.all(
				entries
					.filter((name) => name.endsWith(".jsonl"))
					.map(async (name) => {
						const path = join(directoryPath, name);
						try {
							const stats = await stat(path);
							files.push({ path, mtimeMs: stats.mtimeMs });
						} catch {
							// Deleted between readdir and stat.
						}
					}),
			);
		}),
	);

	// Ties broken by path so the keyset cursor is total and stable.
	files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return files;
}

/** Cursors are opaque to clients; this is just a keyset encoding. */
function encodeCursor(file: SessionFile): string {
	return Buffer.from(`${file.mtimeMs}\u0000${file.path}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): SessionFile {
	const decoded = Buffer.from(cursor, "base64url").toString("utf8");
	const separator = decoded.indexOf("\u0000");
	const mtimeMs = Number(decoded.slice(0, separator));
	const path = decoded.slice(separator + 1);
	if (separator < 0 || !Number.isFinite(mtimeMs) || path.length === 0) {
		throw ProtocolError.invalidParams("Unrecognised listSessions cursor");
	}
	return { path, mtimeMs };
}

/**
 * Reads just the session id from a file's header line.
 *
 * pi writes the `session` header first, so this never parses the transcript.
 */
function readSessionId(path: string): string | undefined {
	let handle: number | undefined;
	try {
		handle = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(HEADER_SCAN_BYTES);
		const read = readSync(handle, buffer, 0, buffer.length, 0);
		const newline = buffer.indexOf(0x0a, 0);
		const line = buffer.toString("utf8", 0, newline >= 0 && newline < read ? newline : read);
		const header = JSON.parse(line) as { type?: string; id?: string };
		return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	} finally {
		if (handle !== undefined) {
			closeSync(handle);
		}
	}
}

/**
 * Parses one session file into a summary.
 *
 * Returns `undefined` for a file that is not a readable pi session so a single
 * corrupt file cannot break the whole catalogue.
 */
function readSessionSummary(file: SessionFile, metadata: MetadataStore): SessionSummary | undefined {
	let manager: SessionManager;
	try {
		manager = SessionManager.open(file.path);
	} catch {
		return undefined;
	}

	const sessionId = manager.getSessionId();
	if (!sessionId) {
		return undefined;
	}

	const entries = manager.getEntries();
	let firstUserMessage: string | undefined;
	let createdAt: string | undefined;
	for (const entry of entries) {
		createdAt ??= entry.timestamp;
		if (entry.type !== "message") {
			continue;
		}
		const message = (entry as { message?: { role?: string; content?: unknown } }).message;
		if (message?.role === "user") {
			const text = textFromPiUserContent(message.content).trim();
			if (text) {
				firstUserMessage = text;
				break;
			}
		}
	}

	const cwd = manager.getCwd();
	return {
		resource: sessionUri(sessionId),
		provider: PI_PROVIDER,
		title: sessionDisplayTitle(manager.getSessionName(), firstUserMessage),
		// Idle by definition and reported as read; archive state is host-owned metadata.
		status: (SessionStatus.Idle |
			SessionStatus.IsRead |
			(metadata.getSessionArchived(sessionId) ? SessionStatus.IsArchived : 0)) as SessionStatus,
		createdAt: createdAt ?? new Date(file.mtimeMs).toISOString(),
		modifiedAt: new Date(file.mtimeMs).toISOString(),
		...(cwd ? { workingDirectories: [pathToFileUri(cwd)] } : {}),
		_meta: { piSessionFile: file.path },
	};
}

/**
 * Serves `listSessions`, newest first, parsing only the requested page.
 */
export class PiSessionCatalogue {
	readonly #root: string;
	readonly #metadata: MetadataStore;
	/** Session URI → file path, populated as pages are read. Purely a cache. */
	readonly #index = new Map<URI, string>();
	constructor(root: string, metadata: MetadataStore = new MetadataStore()) {
		this.#root = root;
		this.#metadata = metadata;
	}

	/** The pi session file backing a URI, if a page has surfaced it. */
	fileFor(uri: URI): string | undefined {
		return this.#index.get(uri);
	}

	/**
	 * Locates the file backing a session id, scanning if necessary.
	 *
	 * A client can subscribe to a session it learned about on an earlier
	 * connection, so the in-memory index built while paging is not enough. The
	 * scan reads headers only — `stat` plus the first line — and stops at the
	 * first match, ordered newest-first so a recently-touched session is found
	 * almost immediately.
	 */
	async findSessionFile(sessionId: string): Promise<string | undefined> {
		const uri = sessionUri(sessionId);
		const cached = this.#index.get(uri);
		if (cached) {
			// The cache is only an index hint: deletion by this host, pi, or the
			// user must invalidate a path before it is returned again.
			if (readSessionId(cached) === sessionId) {
				return cached;
			}
			this.#index.delete(uri);
		}
		for (const file of await listSessionFiles(this.#root)) {
			const id = readSessionId(file.path);
			if (id) {
				this.#index.set(sessionUri(id), file.path);
			}
			if (id === sessionId) {
				return file.path;
			}
		}
		return undefined;
	}

	async list(
		limit: number | undefined,
		cursor: string | undefined,
		live: LiveSessionCatalogueSource = () => [],
	): Promise<ListSessionsResult> {
		const pageSize = Math.min(Math.max(1, limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
		const entries = new Map<string, CatalogueEntry>();
		for (const file of await listSessionFiles(this.#root)) {
			entries.set(file.path, { ...file, file: file.path, onDisk: true });
		}
		// Read live state after asynchronous disk discovery. From here through
		// response construction there is no await, so a turn transition cannot
		// make the returned page older than a notification sent before it.
		for (const item of live()) {
			const parsed = Date.parse(item.summary.modifiedAt);
			const path = item.file ?? `live:${item.summary.resource}`;
			const existing = entries.get(path);
			entries.set(path, {
				path,
				mtimeMs: Number.isFinite(parsed) ? parsed : 0,
				...(item.file ? { file: item.file } : {}),
				...(existing?.onDisk ? { onDisk: true } : {}),
				summary: item.summary,
			});
		}
		const ordered = [...entries.values()].sort(
			(a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		);

		let start = 0;
		if (cursor !== undefined) {
			const after = decodeCursor(cursor);
			const index = ordered.findIndex((entry) => entry.path === after.path);
			if (index < 0) {
				// The entry the cursor named is gone (deleted between pages).
				// Fall back to the position it would have occupied rather than
				// failing the whole call.
				start = ordered.findIndex(
					(entry) => entry.mtimeMs < after.mtimeMs || (entry.mtimeMs === after.mtimeMs && entry.path > after.path),
				);
				if (start < 0) {
					return { items: [] };
				}
			} else {
				start = index + 1;
			}
		}

		const page = ordered.slice(start, start + pageSize);
		const items: SessionSummary[] = [];
		for (const entry of page) {
			const summary =
				entry.summary ??
				(entry.file ? readSessionSummary({ path: entry.file, mtimeMs: entry.mtimeMs }, this.#metadata) : undefined);
			if (summary) {
				if (entry.file && entry.onDisk) {
					this.#index.set(summary.resource, entry.file);
				}
				items.push(summary);
			}
		}

		const last = page[page.length - 1];
		const hasMore = start + page.length < ordered.length;
		return {
			items,
			...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
		};
	}
}
