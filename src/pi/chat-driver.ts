/**
 * Drives one chat channel against a pi agent session.
 *
 * The host owns the turn: a client's `chat/turnStarted` is reduced into
 * authoritative state first, then handed to the backend. Everything the agent
 * emits comes back through {@link TurnMapper} and is dispatched as
 * host-originated actions, so every subscribed client sees the same stream in
 * the same order.
 *
 * Queued messages deliberately never reach pi. The protocol's own state *is*
 * the queue — `ChatState.queuedMessages`, with ids the client chose — and the
 * host consumes the head on idle by dispatching a `chat/turnStarted` carrying
 * `queuedMessageId`, which the reducer applies atomically (create the turn,
 * drop the queue entry). Pushing the queue down to pi as well would duplicate
 * the state and, because pi consumes follow-ups *inside* the same agent run,
 * would silently merge two user messages into one turn.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/chat-channel
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatState,
	type Message,
	MessageKind,
	type ModelSelection,
	PendingMessageKind,
	type StateAction,
	type URI,
} from "@microsoft/agent-host-protocol";
import type { AhpHost } from "../core/host.ts";
import { TurnMapper } from "./event-mapper.ts";
import { messageTextForPi } from "./message-input.ts";

/**
 * The slice of a pi agent session this host needs.
 *
 * Narrow on purpose: an in-process `AgentSession` satisfies it directly, and so
 * would a subprocess driver, without the mapper or driver changing.
 */
export interface PiBackend {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose?(): void;
	/**
	 * Applies a per-message model choice before the turn runs.
	 *
	 * The protocol carries model selection on the message
	 * ({@link Message.model}), not in session config, so a client may switch
	 * model or reasoning effort on any turn.
	 */
	selectModel?(selection: ModelSelection): Promise<void>;
	/** The model and reasoning effort a new message would use by default. */
	currentSelection?(): ModelSelection | undefined;
	/**
	 * Moves the conversation back to an earlier point.
	 *
	 * Returns `false` when the agent declined (an extension may veto), which
	 * the caller must surface rather than swallow — the protocol state has
	 * already been truncated by then.
	 */
	truncate?(entryId: string): Promise<boolean>;
}

export interface ChatDriverOptions {
	readonly host: AhpHost;
	readonly chatChannel: URI;
	readonly backend: PiBackend;
	readonly workingDirectory?: string;
	/** Called with a turn id once that turn has finished, to anchor truncation. */
	readonly recordTurnAnchor?: (turnId: string) => void;
	readonly log?: (message: string) => void;
}

export class ChatDriver {
	readonly #host: AhpHost;
	readonly #chatChannel: URI;
	readonly #backend: PiBackend;
	/** Used to render tool paths relative to the workspace in activity strings. */
	readonly #workingDirectory: string | undefined;
	readonly #recordTurnAnchor: ((turnId: string) => void) | undefined;
	readonly #log: ((message: string) => void) | undefined;
	readonly #unsubscribe: () => void;

	#mapper: TurnMapper | undefined;
	/** Id of the steering message pi has been handed but not yet consumed. */
	#pendingSteeringId: string | undefined;
	/** Its text, so the transcript can show what was injected. */
	/** Last steering-queue length pi reported, to detect a consumption. */
	#steeringQueueLength = 0;

	constructor(options: ChatDriverOptions) {
		this.#host = options.host;
		this.#chatChannel = options.chatChannel;
		this.#backend = options.backend;
		this.#workingDirectory = options.workingDirectory;
		this.#recordTurnAnchor = options.recordTurnAnchor;
		this.#log = options.log;
		this.#unsubscribe = options.backend.subscribe((event) => {
			this.#onAgentEvent(event);
		});
	}

	get chatChannel(): URI {
		return this.#chatChannel;
	}

	/** Whether a turn is currently mapping agent output. */
	get busy(): boolean {
		return this.#mapper !== undefined;
	}

	dispose(): void {
		this.#unsubscribe();
		this.#backend.dispose?.();
	}

	/** Asks the agent to move its conversation back to `entryId`. */
	async truncate(entryId: string): Promise<boolean> {
		if (!this.#backend.truncate) {
			return false;
		}
		try {
			return await this.#backend.truncate(entryId);
		} catch (error) {
			this.#log?.(`truncate failed: ${String(error)}`);
			return false;
		}
	}

	// ── Client actions ──────────────────────────────────────────────────────

	/**
	 * Reacts to a client action already applied to state.
	 *
	 * Returns `true` when the action belonged to this chat, so the caller can
	 * tell handled actions from ones meant for another channel.
	 */
	handleClientAction(channel: URI, action: StateAction): boolean {
		if (channel !== this.#chatChannel) {
			return false;
		}
		switch (action.type) {
			case ActionType.ChatTurnStarted:
				this.#startTurn(action.turnId, action.message);
				return true;
			case ActionType.ChatTurnCancelled:
				void this.#backend.abort().catch((error: unknown) => {
					this.#log?.(`abort failed: ${String(error)}`);
				});
				return true;
			case ActionType.ChatPendingMessageSet:
				// Steering is the only kind pi needs to know about: it is
				// injected into the run already in flight. Queued messages stay
				// in protocol state until this host consumes them.
				if (action.kind === PendingMessageKind.Steering) {
					// Remember the id so the pending message can be cleared once
					// pi actually injects it — the client shows it as waiting
					// until then.
					this.#pendingSteeringId = action.id;
					void this.#steer(action.message);
				} else {
					// A message queued while the chat is idle is consumed straight
					// away; otherwise it waits for the running turn to finish.
					this.#consumeNextQueuedMessage();
				}
				return true;
			default:
				return true;
		}
	}

	// ── Turn lifecycle ──────────────────────────────────────────────────────

	async #steer(message: Message): Promise<void> {
		try {
			await this.#backend.steer(messageTextForPi(message));
		} catch (error) {
			this.#log?.(`steer failed: ${String(error)}`);
			this.#clearPendingSteering();
		}
	}

	#startTurn(turnId: string, message: Message): void {
		this.#mapper = new TurnMapper(turnId, Date.now(), {
			...(this.#workingDirectory ? { workingDirectory: this.#workingDirectory } : {}),
		});

		// The client's choice has to land before the prompt, or the turn runs on
		// whatever the previous one used.
		const ready =
			message.model && this.#backend.selectModel
				? this.#backend.selectModel(message.model).catch((error: unknown) => {
						this.#log?.(`selectModel failed: ${String(error)}`);
					})
				: Promise.resolve();

		void ready
			.then(() => this.#backend.prompt(messageTextForPi(message)))
			.catch((error: unknown) => {
				// `prompt()` rejects before any agent event when the model is
				// unavailable or a turn is already running. Nothing will ever emit
				// `agent_settled`, so the turn has to be closed here or it stays
				// active forever.
				this.#log?.(`prompt failed: ${String(error)}`);
				this.#finishTurn("error", error instanceof Error ? error.message : String(error));
			});
	}

	#onAgentEvent(event: AgentSessionEvent): void {
		// Handled before the active-turn check: a steering message is consumed
		// during a run, but the queue can also be cleared outside one.
		if (event.type === "queue_update") {
			this.#reconcileSteering(event as { steering: readonly string[] });
			return;
		}

		const mapper = this.#mapper;
		if (!mapper) {
			// Events outside a turn (a stray settle after cancellation, or
			// activity pi started on its own) have no turn to attach to.
			return;
		}

		for (const action of mapper.handle(event)) {
			this.#host.dispatchServerAction(this.#chatChannel, action);
		}

		if (mapper.finished) {
			this.#recordTurnAnchor?.(mapper.turnId);
			this.#mapper = undefined;
			this.#consumeNextQueuedMessage();
		}
	}

	/**
	 * Clears the pending steering message once pi has taken it.
	 *
	 * pi removes a queued message from its own queue immediately before the
	 * `message_start` that injects it, emitting `queue_update` at that point
	 * (`agent-session.ts`). Without mirroring that into
	 * `chat/pendingMessageRemoved`, `ChatState.steeringMessage` never clears and
	 * the client shows the message as forever unsent — even though the model
	 * already received it.
	 */
	#reconcileSteering(event: { steering: readonly string[] }): void {
		const length = event.steering?.length ?? 0;
		const consumed = length < this.#steeringQueueLength;
		this.#steeringQueueLength = length;
		if (consumed) {
			this.#clearPendingSteering();
		}
	}

	#clearPendingSteering(): void {
		const id = this.#pendingSteeringId;
		if (!id) {
			return;
		}
		this.#pendingSteeringId = undefined;

		// The injected text is not recorded here: pi delivers it as an ordinary
		// user message, which the mapper turns into its own turn — the same
		// shape it will have when the session is later rebuilt from disk.
		this.#host.dispatchServerAction(this.#chatChannel, {
			type: ActionType.ChatPendingMessageRemoved,
			kind: PendingMessageKind.Steering,
			id,
		});
	}

	#finishTurn(outcome: "complete" | "cancelled" | "error", message?: string): void {
		const mapper = this.#mapper;
		if (!mapper) {
			return;
		}
		for (const action of mapper.finish(outcome, message)) {
			this.#host.dispatchServerAction(this.#chatChannel, action);
		}
		this.#mapper = undefined;
		// A turn that ends without consuming its steering message must not leave
		// it pending for the next one.
		this.#clearPendingSteering();
		this.#consumeNextQueuedMessage();
	}

	/**
	 * Starts the next queued message, if any.
	 *
	 * The `queuedMessageId` is what makes this atomic: the reducer creates the
	 * active turn and removes that entry from `queuedMessages` in one step, so
	 * no client can observe a state where the message is both queued and
	 * running.
	 */
	#consumeNextQueuedMessage(): void {
		const state = this.#host.store.get(this.#chatChannel) as ChatState | undefined;
		const next = state?.queuedMessages?.[0];
		if (!next || this.#mapper) {
			return;
		}

		const turnId = `turn-${next.id}`;
		this.#mapper = new TurnMapper(turnId, Date.now(), {
			...(this.#workingDirectory ? { workingDirectory: this.#workingDirectory } : {}),
		});
		this.#host.dispatchServerAction(this.#chatChannel, {
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: new Date().toISOString(),
			message: next.message,
			queuedMessageId: next.id,
		});

		const selection = next.message.model;
		const ready =
			selection && this.#backend.selectModel
				? this.#backend.selectModel(selection).catch(() => undefined)
				: Promise.resolve();
		void ready
			.then(() => this.#backend.prompt(messageTextForPi(next.message)))
			.catch((error: unknown) => {
				this.#log?.(`queued prompt failed: ${String(error)}`);
				this.#finishTurn("error", error instanceof Error ? error.message : String(error));
			});
	}

	/**
	 * Publishes the model a new message would use as the chat's draft.
	 *
	 * There is no protocol field for "the default model", but a client is told
	 * to initialise its input from {@link ChatState.draft}. Seeding the draft's
	 * model selection is therefore how a host says which model and reasoning
	 * effort are actually in effect — without it the client has to guess, and
	 * will guess wrong.
	 */
	publishDefaultSelection(): void {
		const selection = this.#backend.currentSelection?.();
		if (!selection) {
			return;
		}
		const state = this.#host.store.get(this.#chatChannel) as ChatState | undefined;
		if (state?.draft?.model?.id === selection.id) {
			return;
		}
		this.#host.dispatchServerAction(this.#chatChannel, {
			type: ActionType.ChatDraftChanged,
			draft: {
				text: state?.draft?.text ?? "",
				origin: { kind: MessageKind.User },
				model: selection,
			},
		});
	}
}
