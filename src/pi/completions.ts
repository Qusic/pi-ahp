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

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type CompletionItem,
	type CompletionsParams,
	type CompletionsResult,
	MessageAttachmentKind,
	type URI,
} from "@microsoft/agent-host-protocol";

/** The character that opens a resource mention. */
export const MENTION_TRIGGER = "@";

/** Directories never worth offering; they drown out everything else. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", "build"]);

/** Upper bound on returned items. The client renders a picker, not a file tree. */
const MAX_ITEMS = 50;

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
		const workingDirectory = this.#options.workingDirectoryFor(params.channel);
		if (!workingDirectory) {
			return { items: [] };
		}
		const mention = findMention(params.text ?? "", params.offset ?? 0);
		if (!mention) {
			return { items: [] };
		}

		// `@src/comp` splits into the directory to scan and the prefix to match.
		const separatorIndex = mention.query.lastIndexOf("/");
		const directoryPart = separatorIndex < 0 ? "" : mention.query.slice(0, separatorIndex);
		const prefix = (separatorIndex < 0 ? mention.query : mention.query.slice(separatorIndex + 1)).toLowerCase();

		const scanDirectory = resolve(workingDirectory, directoryPart);
		if (!this.#isInside(workingDirectory, scanDirectory)) {
			// A mention is workspace-relative; `@../../etc/passwd` is not a typo
			// worth completing.
			return { items: [] };
		}

		let entries: Dirent<string>[];
		try {
			entries = await readdir(scanDirectory, { withFileTypes: true });
		} catch {
			return { items: [] };
		}

		const items: CompletionItem[] = [];
		for (const entry of entries) {
			if (items.length >= (this.#options.maxItems ?? MAX_ITEMS)) {
				break;
			}
			if (entry.name.toLowerCase().startsWith(prefix) === false) {
				continue;
			}
			if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			if (prefix.length === 0 && entry.name.startsWith(".")) {
				// Dotfiles are offered only once the user asks for them.
				continue;
			}

			const absolute = join(scanDirectory, entry.name);
			const relativePath = relative(workingDirectory, absolute).split(sep).join("/");
			const isDirectory = entry.isDirectory();
			items.push({
				// A directory keeps the mention open so the user can descend.
				insertText: `${MENTION_TRIGGER}${relativePath}${isDirectory ? "/" : ""}`,
				rangeStart: mention.start,
				rangeEnd: mention.end,
				attachment: {
					type: MessageAttachmentKind.Resource,
					label: entry.name,
					displayKind: isDirectory ? "folder" : "document",
					uri: pathToFileURL(absolute).toString(),
				},
			});
		}

		// Directories first, then alphabetical — the order a picker wants.
		items.sort((a, b) => {
			const aDir = a.insertText.endsWith("/");
			const bDir = b.insertText.endsWith("/");
			return aDir === bDir ? a.insertText.localeCompare(b.insertText) : aDir ? -1 : 1;
		});
		return { items };
	}

	#isInside(root: string, candidate: string): boolean {
		const rel = relative(root, candidate);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	}
}
