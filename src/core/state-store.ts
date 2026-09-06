/**
 * The authoritative state store.
 *
 * Every state-bearing channel holds an immutable state tree mutated only by
 * actions run through the protocol's pure reducers. Terminal state additionally
 * caps retained output so reconnect snapshots cannot grow without bound.
 *
 * @see https://microsoft.github.io/agent-host-protocol/guide/state-model
 */

import {
	ActionType,
	type ChatState,
	chatReducer,
	type ResourceWatchState,
	type RootState,
	resourceWatchReducer,
	rootReducer,
	type SessionState,
	type Snapshot,
	type StateAction,
	sessionReducer,
	type TerminalAction,
	type TerminalContentPart,
	type TerminalState,
	terminalReducer,
	type URI,
} from "@microsoft/agent-host-protocol";
import { type ChannelKind, channelKind } from "./channels.ts";

/** Any state tree this host serves. */
export type ChannelState = RootState | SessionState | ChatState | TerminalState | ResourceWatchState;

/** Maximum output characters retained for snapshots; live clients still receive every action. */
const MAX_RETAINED_TERMINAL_CHARS = 1_000_000;

function terminalOutput(part: TerminalContentPart): string {
	return part.type === "unclassified" ? part.value : part.output;
}

function withTerminalOutput(part: TerminalContentPart, output: string): TerminalContentPart {
	return part.type === "unclassified" ? { ...part, value: output } : { ...part, output };
}

/** Applies the official reducer, then trims only the oldest retained output. */
function reduceTerminal(state: TerminalState, action: TerminalAction): TerminalState {
	const reduced = terminalReducer(state, action);
	if (action.type !== ActionType.TerminalData) return reduced;

	let remaining = MAX_RETAINED_TERMINAL_CHARS;
	let trimmed = false;
	const newestFirst: TerminalContentPart[] = [];

	for (let index = reduced.content.length - 1; index >= 0; index -= 1) {
		const part = reduced.content[index];
		if (!part) continue;
		const output = terminalOutput(part);
		if (output.length <= remaining) {
			newestFirst.push(part);
			remaining -= output.length;
			continue;
		}
		if (remaining > 0) {
			newestFirst.push(withTerminalOutput(part, output.slice(-remaining)));
		}
		trimmed = true;
		break;
	}

	return trimmed ? { ...reduced, content: newestFirst.reverse() } : reduced;
}

interface ChannelEntry {
	readonly kind: ChannelKind;
	state: ChannelState;
}

/**
 * Applies an action to a channel's state using the reducer for that channel
 * kind. Reducers are total: an action they do not recognise is a no-op, which
 * is how forward compatibility works.
 */
function reduce(kind: ChannelKind, state: ChannelState, action: StateAction): ChannelState {
	switch (kind) {
		case "root":
			// Channel routing chooses the reducer; generated unions still require
			// narrowing at this boundary.
			return rootReducer(state as RootState, action as never);
		case "session":
			return sessionReducer(state as SessionState, action as never);
		case "chat":
			return chatReducer(state as ChatState, action as never);
		case "terminal":
			return reduceTerminal(state as TerminalState, action as never);
		case "resourceWatch":
			// Pass-through by design: a watch's state describes what is being
			// watched, and `resourceWatch/changed` carries pure event traffic.
			return resourceWatchReducer(state as ResourceWatchState, action as never);
		default:
			return state;
	}
}

export class StateStore {
	readonly #channels = new Map<URI, ChannelEntry>();

	/**
	 * Registers a channel with its initial state. Replaces any existing entry.
	 *
	 * `kind` is normally inferred from the scheme. Callers pass it explicitly
	 * when the command establishes the kind of a client-chosen URI, such as a
	 * provider-aliased session or VS Code terminal.
	 */
	create(uri: URI, state: ChannelState, kind: ChannelKind | undefined = channelKind(uri)): void {
		if (kind === undefined) {
			throw new Error(`Cannot create channel with unknown scheme: ${uri}`);
		}
		this.#channels.set(uri, { kind, state });
	}

	delete(uri: URI): boolean {
		return this.#channels.delete(uri);
	}

	has(uri: URI): boolean {
		return this.#channels.has(uri);
	}

	get(uri: URI): ChannelState | undefined {
		return this.#channels.get(uri)?.state;
	}

	kindOf(uri: URI): ChannelKind | undefined {
		return this.#channels.get(uri)?.kind;
	}

	/**
	 * Reduces an action into a channel.
	 *
	 * Returns `false` when the channel does not exist — the spec requires the
	 * host to silently ignore actions targeting an unknown channel rather than
	 * echoing a rejection.
	 */
	apply(uri: URI, action: StateAction): boolean {
		const entry = this.#channels.get(uri);
		if (!entry) {
			return false;
		}
		entry.state = reduce(entry.kind, entry.state, action);
		return true;
	}

	/** Builds a subscribe/initialize snapshot for a channel at the given seq. */
	snapshot(uri: URI, fromSeq: number): Snapshot | undefined {
		const entry = this.#channels.get(uri);
		return entry === undefined ? undefined : { resource: uri, state: entry.state, fromSeq };
	}
}
