/**
 * Inline completions for a message being composed — the `completions` command.
 *
 * Note what the protocol's shape implies: every `CompletionItem` carries a
 * **required** `attachment`. Completions here are therefore specifically about
 * producing attachments — the `@`-mention picker — not about generic text
 * completion.
 *
 * That is why pi's slash commands are absent. An extension command, prompt
 * template or skill (`/skill:brave-search`) attaches nothing; it is text pi
 * expands server-side when the message is sent. Dressing one up as a
 * `simple` attachment would leave a meaningless chip on the message, so this
 * host advertises `@` alone as a trigger character and lets `/…` be typed
 * plainly — it still works, just without completion assistance.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/chat-channel
 */

import { glob } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type CompletionItem,
	CompletionItemKind,
	type CompletionsParams,
	type CompletionsResult,
	MessageAttachmentKind,
	type URI,
} from "@microsoft/agent-host-protocol";

/** The character that opens a resource mention. */
export const MENTION_TRIGGER = "@";

/**
 * An intentionally small, arbitrary guard for this temporary glob-based
 * implementation. Revisit it when completions gain a real file index.
 */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/** Upper bound on returned items. The client renders a picker, not a file tree. */
const MAX_ITEMS = 50;

/** Keeps a completion request bounded even when the workspace is enormous. */
const MAX_SCANNED_ENTRIES = 10_000;

function score(relativePath: string, query: string): number {
	if (!query) {
		return 1;
	}
	const path = relativePath.toLowerCase();
	const name = basename(path);
	if (name === query) return 4;
	if (name.startsWith(query)) return 3;
	if (name.includes(query)) return 2;
	return path.includes(query) ? 1 : 0;
}

export interface CompletionServiceOptions {
	/** Resolves the directory a chat's mentions are relative to. */
	readonly workingDirectoryFor: (chat: URI) => string | undefined;
	readonly maxItems?: number;
}

interface MentionToken {
	/** Offset of the `@`. */
	readonly start: number;
	/** Offset just past the token. */
	readonly end: number;
	/** Everything after the `@`. */
	readonly query: string;
}

/**
 * Finds the mention the cursor sits in, if any.
 *
 * A mention only counts at the start of the text or after whitespace, so an
 * email address or a decorator does not trigger the picker.
 */
export function findMention(text: string, offset: number): MentionToken | undefined {
	const clamped = Math.max(0, Math.min(offset, text.length));
	let index = clamped;
	while (index > 0) {
		const char = text[index - 1] as string;
		if (/\s/u.test(char)) {
			return undefined;
		}
		if (char === MENTION_TRIGGER) {
			const preceding = index >= 2 ? (text[index - 2] as string) : undefined;
			if (preceding !== undefined && !/\s/u.test(preceding)) {
				return undefined;
			}
			return { start: index - 1, end: clamped, query: text.slice(index, clamped) };
		}
		index -= 1;
	}
	return undefined;
}

export class CompletionService {
	readonly #options: CompletionServiceOptions;

	constructor(options: CompletionServiceOptions) {
		this.#options = options;
	}

	/**
	 * Best-effort and prompt, as the protocol asks: anything that cannot be
	 * answered cheaply comes back as an empty list rather than an error, since
	 * a client debouncing keystrokes should never see a failed request for
	 * typing something odd.
	 */
	async complete(params: CompletionsParams): Promise<CompletionsResult> {
		if (params.kind !== CompletionItemKind.UserMessage) return { items: [] };
		const workingDirectory = this.#options.workingDirectoryFor(params.channel);
		if (!workingDirectory) {
			return { items: [] };
		}
		const mention = findMention(params.text ?? "", params.offset ?? 0);
		if (!mention) {
			return { items: [] };
		}

		const query = mention.query.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
		const candidates: { absolute: string; relativePath: string; score: number }[] = [];
		let scanned = 0;
		try {
			for await (const entry of glob("**/*", {
				cwd: workingDirectory,
				withFileTypes: true,
				exclude: (candidate) => candidate.isDirectory() && SKIPPED_DIRECTORIES.has(candidate.name),
			})) {
				if (++scanned > MAX_SCANNED_ENTRIES) {
					break;
				}
				if (!entry.isFile() && !entry.isSymbolicLink()) {
					continue;
				}
				const absolute = join(entry.parentPath, entry.name);
				const relativePath = relative(workingDirectory, absolute).split(sep).join("/");
				const rank = score(relativePath, query);
				if (rank) {
					candidates.push({ absolute, relativePath, score: rank });
				}
			}
		} catch {
			return { items: [] };
		}

		candidates.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
		const items: CompletionItem[] = candidates.slice(0, this.#options.maxItems ?? MAX_ITEMS).map((candidate) => ({
			insertText: `${MENTION_TRIGGER}${candidate.relativePath}`,
			rangeStart: mention.start,
			rangeEnd: mention.end,
			attachment: {
				type: MessageAttachmentKind.Resource,
				label: basename(candidate.relativePath),
				displayKind: "document",
				uri: pathToFileURL(candidate.absolute).toString(),
			},
		}));
		return { items };
	}
}
