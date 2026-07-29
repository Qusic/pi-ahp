/**
 * The authoritative state store.
 *
 * Every state-bearing channel holds an immutable state tree mutated only by
 * actions run through the protocol's pure reducers — the same reducers the
 * client runs, imported from `@microsoft/agent-host-protocol`, so both sides
 * converge on identical state.
 *
 * @see https://microsoft.github.io/agent-host-protocol/guide/state-model
 */

import {
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
	type URI,
} from "@microsoft/agent-host-protocol";
import { type ChannelKind, channelKind } from "./channels.ts";

/** Any state tree this host serves. */
export type ChannelState = RootState | SessionState | ChatState | ResourceWatchState;

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
			// The reducer unions are wider than what a single channel accepts; the
			// store validates the channel/action pairing before it gets here.
			return rootReducer(state as RootState, action as never);
		case "session":
			return sessionReducer(state as SessionState, action as never);
		case "chat":
			return chatReducer(state as ChatState, action as never);
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
	 * `kind` is normally inferred from the scheme. It has to be passed
	 * explicitly for a session opened at a non-standard URI — clients written
	 * against the reference host still use `<provider>:/<uuid>`, and the caller
	 * already knows it is creating a session.
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
