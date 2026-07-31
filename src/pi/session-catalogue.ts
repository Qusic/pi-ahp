/**
 * The session catalogue, backed by pi's on-disk session files.
 *
 * pi stores each session as a JSONL file under
 * `~/.pi/agent/sessions/--<encoded-cwd>--/`. Reading one means parsing the whole
 * file, so a naive "list everything" is O(all bytes on disk) — pi's own TUI
 * pays that cost behind a progress bar.
 *
 * The protocol gives us a way out that pi's TUI does not have: `listSessions`
 * is paginated. So we `stat` every file (cheap), sort by mtime, and parse only
 * the page we are about to return.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/root-channel
 */

import { closeSync, openSync, readSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { type ListSessionsResult, SessionStatus, type SessionSummary, type URI } from "@microsoft/agent-host-protocol";
import { sessionUri } from "../core/channels.ts";
import { ProtocolError } from "../protocol/errors.ts";
import { PI_PROVIDER } from "./provider.ts";

/** Page size when the client does not ask for one. */
const DEFAULT_PAGE_SIZE = 30;
/** Upper bound regardless of what the client asks for; each entry costs a file parse. */
const MAX_PAGE_SIZE = 100;
/** How much of the first user message to use when a session has no name. */
const TITLE_FALLBACK_LENGTH = 60;
/** Enough for pi's session header line, which is written first. */
const HEADER_SCAN_BYTES = 8192;

interface SessionFile {
	readonly path: string;
	readonly mtimeMs: number;
}

function sessionsRoot(): string {
	return join(getAgentDir(), "sessions");
}

/**
 * Every session file with its mtime, newest first.
 *
 * `stat` only — no parsing. mtime is a good proxy for pi's own "last activity"
 * ordering because the file is appended on every message.
 */
async function listSessionFiles(root: string = sessionsRoot()): Promise<SessionFile[]> {
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

function firstLine(text: string, limit: number): string {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/**
 * Title, using pi's own rule: the user-assigned name, else the first user
 * message. Mirrors `session-selector.ts` (`session.name ?? session.firstMessage`)
 * so a session reads the same in this host as it does in pi's `/resume` picker.
 */
function deriveTitle(name: string | undefined, firstUserMessage: string | undefined): string {
	const trimmed = name?.trim();
	if (trimmed) {
		return trimmed;
	}
	const fallback = firstUserMessage ? firstLine(firstUserMessage, TITLE_FALLBACK_LENGTH) : "";
	return fallback || "Untitled session";
}

function extractText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block): block is { type: "text"; text: string } => (block as { type?: string })?.type === "text")
		.map((block) => block.text)
		.join(" ");
}

/**
 * Parses one session file into a summary.
 *
 * Returns `undefined` for a file that is not a readable pi session so a single
 * corrupt file cannot break the whole catalogue.
 */
function readSessionSummary(file: SessionFile): SessionSummary | undefined {
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
			const text = extractText(message.content).trim();
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
		title: deriveTitle(manager.getSessionName(), firstUserMessage),
		// Idle by definition, and reported as read.
		//
		// Read/unread is not modelled: pi has no such concept, so tracking it
		// would mean this host inventing durable state of its own — and without
		// archiving to go with it, a catalogue where everything is permanently
		// unread is worse than one that is quiet. A live session that starts a
		// turn still becomes unread, because the reducer clears the bit on
		// `chat/turnStarted`.
		status: SessionStatus.Idle | SessionStatus.IsRead,
		createdAt: createdAt ?? new Date(file.mtimeMs).toISOString(),
		modifiedAt: new Date(file.mtimeMs).toISOString(),
		...(cwd ? { workingDirectory: `file://${cwd}` } : {}),
		_meta: { piSessionFile: file.path },
	};
}

/**
 * Serves `listSessions`, newest first, parsing only the requested page.
 */
export class PiSessionCatalogue {
	readonly #root: string;
	/** Session URI → file path, populated as pages are read. Purely a cache. */
	readonly #index = new Map<URI, string>();
	constructor(root: string = sessionsRoot()) {
		this.#root = root;
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
		const cached = this.#index.get(sessionUri(sessionId));
		if (cached) {
			return cached;
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

	async list(limit: number | undefined, cursor: string | undefined): Promise<ListSessionsResult> {
		const pageSize = Math.min(Math.max(1, limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
		const files = await listSessionFiles(this.#root);

		let start = 0;
		if (cursor !== undefined) {
			const after = decodeCursor(cursor);
			const index = files.findIndex((file) => file.path === after.path);
			if (index < 0) {
				// The entry the cursor named is gone (deleted between pages).
				// Fall back to the position it would have occupied rather than
				// failing the whole call.
				start = files.findIndex(
					(file) => file.mtimeMs < after.mtimeMs || (file.mtimeMs === after.mtimeMs && file.path > after.path),
				);
				if (start < 0) {
					return { items: [] };
				}
			} else {
				start = index + 1;
			}
		}

		const page = files.slice(start, start + pageSize);
		const items: SessionSummary[] = [];
		for (const file of page) {
			const summary = readSessionSummary(file);
			if (summary) {
				this.#index.set(summary.resource, file.path);
				items.push(summary);
			}
		}

		const last = page[page.length - 1];
		const hasMore = start + page.length < files.length;
		return {
			items,
			...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
		};
	}
}
