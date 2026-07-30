/**
 * Builds provider streams for turns a recording cannot capture.
 *
 * Fixtures under `test/fixtures` are recorded from a live provider; these are
 * written by hand, for outcomes a provider will not produce on request — a
 * content filter tripping, a reply cut off at the token ceiling, a transient
 * server error. Keeping them as code rather than more JSON is the point: a
 * recorded fixture is data nobody should edit, and the difference is visible
 * from the file it lives in.
 *
 * Only the LLM response is authored. pi runs for real on the other side, so
 * what these turns exercise is its own handling of the outcome.
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Why a reply ended, as pi models it.
 *
 * The provider layer has already collapsed its own vocabulary into these five
 * by the time a stream reaches pi: OpenAI's `content_filter` and Google's nine
 * safety and recitation reasons all arrive as `error` with the detail left in
 * `errorMessage`, and `length` is the token ceiling. Authoring outside this set
 * would describe a stream pi can never be given.
 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface AuthoredTurn {
	/** Reply text, streamed as one delta unless `chunks` splits it. */
	readonly text?: string;
	/** Splits `text` into that many deltas, for turns that test accumulation. */
	readonly chunks?: number;
	/** Reasoning text, streamed before the reply. */
	readonly thinking?: string;
	/** A tool call to make instead of replying. */
	readonly toolCall?: { readonly name: string; readonly args: Record<string, unknown> };
	/** Defaults to `toolUse` with a tool call, `error` with a message, else `stop`. */
	readonly stopReason?: StopReason;
	/**
	 * Provider detail behind an `error`.
	 *
	 * pi decides whether to retry by matching this text — `overloaded`, `429`,
	 * `503` and similar are transient, a content filter is not — so the wording
	 * is what selects between the two paths.
	 */
	readonly errorMessage?: string;
	/** Token counts, when a turn is about usage reporting. */
	readonly usage?: { readonly input?: number; readonly output?: number };
}

const MODEL_FIELDS = { api: "openai-responses", provider: "github-copilot", model: "gpt-5.4" } as const;

function splitIntoChunks(text: string, count: number): string[] {
	if (count <= 1) {
		return [text];
	}
	const size = Math.ceil(text.length / count);
	const chunks: string[] = [];
	for (let at = 0; at < text.length; at += size) {
		chunks.push(text.slice(at, at + size));
	}
	return chunks;
}

function resolveStopReason(turn: AuthoredTurn): StopReason {
	if (turn.stopReason) {
		return turn.stopReason;
	}
	if (turn.toolCall) {
		return "toolUse";
	}
	return turn.errorMessage ? "error" : "stop";
}

/**
 * Replaces a session's provider with one that replies with `turns` in order.
 *
 * A turn is consumed per request, so a scenario that expects pi to continue
 * after a tool result or a retry needs a turn for each. Running past the end
 * throws rather than looping, which would hide a miscounted scenario as a hang.
 */
export function authorTurns(session: AgentSession, turns: readonly AuthoredTurn[]): void {
	let index = 0;
	session.agent.streamFunction = () => {
		const turn = turns[index++];
		if (!turn) {
			throw new Error(`authored stream exhausted after ${turns.length} turn(s)`);
		}
		const stream = createAssistantMessageEventStream();

		const content: unknown[] = [];
		let contentIndex = 0;
		if (turn.thinking !== undefined) {
			content.push({ type: "thinking", thinking: turn.thinking, thinkingSignature: "" });
		}
		if (turn.toolCall) {
			content.push({
				type: "toolCall",
				id: `authored_${index}`,
				name: turn.toolCall.name,
				arguments: turn.toolCall.args,
			});
		} else if (turn.text !== undefined) {
			content.push({ type: "text", text: turn.text, textSignature: "" });
		}

		const stopReason = resolveStopReason(turn);
		// One object shared across the turn's events, matching how pi accumulates
		// into a single message during a live stream.
		const partial = {
			role: "assistant",
			content,
			...MODEL_FIELDS,
			usage: {
				input: turn.usage?.input ?? 100,
				output: turn.usage?.output ?? 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
			stopReason,
			...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial } as never);

			if (turn.thinking !== undefined) {
				stream.push({ type: "thinking_start", contentIndex, partial } as never);
				stream.push({ type: "thinking_delta", contentIndex, delta: turn.thinking, partial } as never);
				stream.push({ type: "thinking_end", contentIndex, content: turn.thinking, partial } as never);
				contentIndex++;
			}

			if (turn.toolCall) {
				const args = JSON.stringify(turn.toolCall.args);
				stream.push({ type: "toolcall_start", contentIndex, partial } as never);
				stream.push({ type: "toolcall_delta", contentIndex, delta: args, partial } as never);
				stream.push({
					type: "toolcall_end",
					contentIndex,
					toolCall: content[content.length - 1],
					partial,
				} as never);
			} else if (turn.text !== undefined) {
				stream.push({ type: "text_start", contentIndex, partial } as never);
				for (const chunk of splitIntoChunks(turn.text, turn.chunks ?? 1)) {
					stream.push({ type: "text_delta", contentIndex, delta: chunk, partial } as never);
				}
				stream.push({ type: "text_end", contentIndex, content: turn.text, partial } as never);
			}

			if (stopReason === "error") {
				// pi reads the outcome off this event rather than `done`, and reports
				// the turn as failed only if it arrives.
				stream.push({ type: "error", reason: "error", error: partial } as never);
			} else {
				stream.push({ type: "done", reason: stopReason, message: partial } as never);
			}
			stream.end(partial as never);
		});

		return stream;
	};
}
