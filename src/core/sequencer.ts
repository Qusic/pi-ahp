/**
 * Server sequence allocation and the action replay buffer.
 *
 * The host is the sole authority for ordering: every accepted action gets a
 * monotonically increasing `serverSeq` and is retained in a bounded ring
 * buffer so a reconnecting client can replay the gap instead of refetching
 * every snapshot.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/lifecycle
 */

import type { ActionEnvelope } from "@microsoft/agent-host-protocol";

/**
 * How many envelopes to retain for replay. Matches the reference host's
 * `REPLAY_BUFFER_CAPACITY`. A client whose gap predates the buffer gets fresh
 * snapshots instead — correct, just more expensive.
 */
export const DEFAULT_REPLAY_BUFFER_CAPACITY = 1000;

export class Sequencer {
	#serverSeq = 0;
	readonly #buffer: ActionEnvelope[] = [];
	readonly #capacity: number;

	constructor(capacity: number = DEFAULT_REPLAY_BUFFER_CAPACITY) {
		this.#capacity = Math.max(1, capacity);
	}

	/** The seq of the most recently emitted envelope (0 before anything is emitted). */
	get current(): number {
		return this.#serverSeq;
	}

	/** Allocates the next seq. Callers must emit the envelope they build with it. */
	next(): number {
		return ++this.#serverSeq;
	}

	/** Retains an envelope for replay, evicting the oldest when at capacity. */
	retain(envelope: ActionEnvelope): void {
		this.#buffer.push(envelope);
		if (this.#buffer.length > this.#capacity) {
			this.#buffer.shift();
		}
	}

	/** The oldest seq still replayable, or `undefined` when the buffer is empty. */
	get oldestRetainedSeq(): number | undefined {
		return this.#buffer[0]?.serverSeq;
	}

	/**
	 * Whether the gap after `lastSeenServerSeq` is fully covered by the buffer.
	 *
	 * A client that is already current (`lastSeenServerSeq >= current`) trivially
	 * qualifies. Otherwise the buffer must still hold `lastSeenServerSeq + 1`.
	 */
	canReplayFrom(lastSeenServerSeq: number): boolean {
		if (lastSeenServerSeq >= this.#serverSeq) {
			return true;
		}
		const oldest = this.oldestRetainedSeq;
		return oldest !== undefined && oldest <= lastSeenServerSeq + 1;
	}

	/**
	 * Envelopes after `lastSeenServerSeq` whose channel the client subscribes to.
	 *
	 * Returned in seq order. Only call after {@link canReplayFrom} returns true;
	 * otherwise the result silently omits evicted envelopes.
	 */
	replayFrom(lastSeenServerSeq: number, channels: ReadonlySet<string>): ActionEnvelope[] {
		return this.#buffer.filter((envelope) => envelope.serverSeq > lastSeenServerSeq && channels.has(envelope.channel));
	}
}
