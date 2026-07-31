/**
 * Rebuilds chat history from a pi session file.
 *
 * A client lists sessions and then subscribes to one. Everything the host has
 * seen live is already in memory, but a session from the catalogue exists only
 * on disk — so subscribing has to reconstruct its state, or the client opens an
 * empty conversation.
 *
 * The window matches what pi itself renders. `buildContextEntries()` starts at
 * the most recent compaction (`session-manager.ts` builds
 * `[compaction, …kept entries, …later entries]`), which is exactly the transcript
 * pi's own TUI shows on resume. Reconstructing more would show the user history
 * their agent has already forgotten.
 *
 * This is a *second* mapper, distinct from the streaming one: it works from
 * finished messages rather than deltas, so there is no partial state, no
 * ordering to preserve, and every tool call already has its result.
 */

import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	MessageKind,
	type ResponsePart,
	ResponsePartKind,
	ToolCallStatus,
	type ToolResultContent,
	ToolResultContentType,
	type Turn,
	TurnState,
	type UsageInfo,
} from "@microsoft/agent-host-protocol";

interface ContentBlock {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: unknown;
}

interface StoredMessage {
	readonly role?: string;
	readonly content?: string | ContentBlock[];
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
	readonly usage?: { input?: number; output?: number; cacheRead?: number };
	readonly model?: string;
	readonly command?: string;
	readonly output?: string;
}

function blocksOf(message: StoredMessage): ContentBlock[] {
	if (typeof message.content === "string") {
		return [{ type: "text", text: message.content }];
	}
	return Array.isArray(message.content) ? message.content : [];
}

function plainText(message: StoredMessage): string {
	return blocksOf(message)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

function toUsage(message: StoredMessage): UsageInfo | undefined {
	const usage = message.usage;
	if (!usage) {
		return undefined;
	}
	return {
		...(usage.input !== undefined ? { inputTokens: usage.input } : {}),
		...(usage.output !== undefined ? { outputTokens: usage.output } : {}),
		...(usage.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
		...(message.model ? { model: message.model } : {}),
	};
}

function textContent(text: string): ToolResultContent[] {
	return [{ type: ToolResultContentType.Text, text }];
}

/** A turn under construction, before its tool results have been matched up. */
interface PendingTurn {
	readonly id: string;
	readonly startedAt: string;
	readonly text: string;
	readonly parts: ResponsePart[];
	usage: UsageInfo | undefined;
}

export interface RebuildOptions {
	/** Prefix for generated turn ids; only needs to be stable within a chat. */
	readonly turnIdPrefix?: string;
}

export interface RebuiltHistory {
	readonly turns: Turn[];
	/**
	 * Turn id → the session entry that turn *ends* on.
	 *
	 * This is the anchor truncation needs. `chat/truncated` keeps turns up to
	 * and including the named one, and pi's `navigateTree` is inclusive for a
	 * non-user entry — so pointing it at a turn's last entry expresses exactly
	 * the protocol's meaning.
	 *
	 * The first user entry is recorded under the empty key: navigating to it
	 * lands the leaf on its parent, which is `null`, which is how "clear
	 * everything" is expressed.
	 */
	readonly anchors: ReadonlyMap<string, string>;
}

/** Key under which the whole-conversation anchor is stored. */
export const CLEAR_ALL_ANCHOR = "";

/**
 * Converts session entries into completed turns.
 *
 * Turn boundaries come from user messages: each one opens a turn that absorbs
 * every assistant message and tool result until the next. That mirrors the live
 * mapper, where a turn spans everything from one prompt to `agent_settled`.
 */
function rebuildTurns(entries: readonly SessionEntry[], options: RebuildOptions = {}): Turn[] {
	return rebuildHistory(entries, options).turns;
}

/** As {@link rebuildTurns}, but also reporting each turn's truncation anchor. */
export function rebuildHistory(entries: readonly SessionEntry[], options: RebuildOptions = {}): RebuiltHistory {
	const prefix = options.turnIdPrefix ?? "turn";
	const turns: Turn[] = [];
	const anchors = new Map<string, string>();
	/** The entry most recently folded into the turn being built. */
	let lastEntryId: string | undefined;
	let current: PendingTurn | undefined;
	/** toolCallId → index in `current.parts`, so a result can find its call. */
	let toolCallParts = new Map<string, number>();

	const closeTurn = (): void => {
		if (!current) {
			return;
		}
		if (lastEntryId) {
			anchors.set(current.id, lastEntryId);
		}
		turns.push({
			id: current.id,
			startedAt: current.startedAt,
			message: { text: current.text, origin: { kind: MessageKind.User } },
			responseParts: current.parts,
			usage: current.usage,
			state: TurnState.Complete,
		});
		current = undefined;
		toolCallParts = new Map();
	};

	const openTurn = (id: string, startedAt: string, text: string): void => {
		closeTurn();
		current = { id, startedAt, text, parts: [], usage: undefined };
	};

	for (const entry of entries) {
		if (entry.type === "message" && (entry.message as unknown as StoredMessage).role === "user") {
			anchors.set(CLEAR_ALL_ANCHOR, anchors.get(CLEAR_ALL_ANCHOR) ?? entry.id);
		}

		if (entry.type === "compaction") {
			// The summary replaces everything before it. Surfacing it as a turn
			// of its own tells the user why the history starts where it does.
			closeTurn();
			turns.push({
				id: `${prefix}-compaction-${entry.id}`,
				startedAt: entry.timestamp,
				message: { text: "", origin: { kind: MessageKind.User } },
				responseParts: [
					{
						kind: ResponsePartKind.SystemNotification,
						content: `Conversation compacted.\n\n${entry.summary}`,
					},
				],
				usage: undefined,
				state: TurnState.Complete,
			});
			continue;
		}

		if (entry.type !== "message") {
			// Model / thinking-level changes and labels carry no transcript.
			continue;
		}

		const message = entry.message as unknown as StoredMessage;
		switch (message.role) {
			case "user": {
				openTurn(`${prefix}-${entry.id}`, entry.timestamp, plainText(message));
				break;
			}

			case "assistant": {
				if (!current) {
					// An assistant message with no preceding user message (a
					// truncated file, or history that starts mid-turn). Give it a
					// turn so the content is not dropped.
					openTurn(`${prefix}-${entry.id}`, entry.timestamp, "");
				}
				const turn = current as PendingTurn;
				let index = 0;
				for (const block of blocksOf(message)) {
					if (block.type === "text" && block.text) {
						turn.parts.push({
							kind: ResponsePartKind.Markdown,
							id: `${turn.id}:${entry.id}:${index}`,
							content: block.text,
						});
					} else if (block.type === "thinking" && block.thinking) {
						turn.parts.push({
							kind: ResponsePartKind.Reasoning,
							id: `${turn.id}:${entry.id}:${index}`,
							content: block.thinking,
						});
					} else if (block.type === "toolCall" && block.id) {
						toolCallParts.set(block.id, turn.parts.length);
						turn.parts.push({
							kind: ResponsePartKind.ToolCall,
							toolCall: {
								status: ToolCallStatus.Running,
								toolCallId: block.id,
								toolName: block.name ?? "tool",
								displayName: block.name ?? "tool",
								invocationMessage: block.name ?? "tool",
								toolInput: block.arguments === undefined ? undefined : JSON.stringify(block.arguments),
								confirmed: "setting",
							} as never,
						});
					}
					index += 1;
				}
				turn.usage = toUsage(message) ?? turn.usage;
				break;
			}

			case "toolResult": {
				const partIndex = message.toolCallId ? toolCallParts.get(message.toolCallId) : undefined;
				if (!current || partIndex === undefined) {
					break;
				}
				const existing = current.parts[partIndex] as { toolCall: Record<string, unknown> } | undefined;
				if (!existing) {
					break;
				}
				const text = plainText(message);
				const success = message.isError !== true;
				current.parts[partIndex] = {
					kind: ResponsePartKind.ToolCall,
					toolCall: {
						...existing.toolCall,
						status: ToolCallStatus.Completed,
						success,
						pastTenseMessage: success ? `Ran ${message.toolName ?? "tool"}` : `${message.toolName ?? "tool"} failed`,
						...(text ? { content: textContent(text) } : {}),
					},
				} as ResponsePart;
				break;
			}

			case "bashExecution": {
				// pi records `!command` runs as their own message role; they are
				// part of the transcript even though no model produced them.
				if (!current) {
					openTurn(`${prefix}-${entry.id}`, entry.timestamp, `!${message.command ?? ""}`);
				}
				(current as PendingTurn).parts.push({
					kind: ResponsePartKind.SystemNotification,
					content: `\`${message.command ?? ""}\`\n\n${message.output ?? ""}`,
				});
				break;
			}

			default:
				break;
		}

		// Recorded after the entry has been folded in, so a user message that
		// opens a new turn does not become the previous turn's anchor.
		lastEntryId = entry.id;
	}

	closeTurn();
	return { turns, anchors };
}

/** Rebuilds the turns of a session file, using the same window pi's TUI shows. */
export function rebuildTurnsFromSession(manager: SessionManager, options: RebuildOptions = {}): Turn[] {
	return rebuildTurns(manager.buildContextEntries(), options);
}

/** As {@link rebuildTurnsFromSession}, with truncation anchors. */
export function rebuildHistoryFromSession(manager: SessionManager, options: RebuildOptions = {}): RebuiltHistory {
	return rebuildHistory(manager.buildContextEntries(), options);
}
