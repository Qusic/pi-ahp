/** One reader per watch subscription; assertions observe a retained event journal. */
import { ActionType, type ResourceChange } from "@microsoft/agent-host-protocol";
import type { Subscription, SubscriptionEvent } from "@microsoft/agent-host-protocol/client";

export class WatchEvents {
	readonly batches: ResourceChange[][] = [];
	readonly #source: Pick<Subscription, "next" | "return">;
	readonly #describeState: () => unknown;
	readonly #listeners = new Set<() => void>();
	readonly #reading: Promise<void>;
	#error: unknown;
	#closed = false;
	#stopRead: (() => void) | undefined;

	constructor(source: Pick<Subscription, "next" | "return">, describeState: () => unknown = () => ({})) {
		this.#source = source;
		this.#describeState = describeState;
		this.#reading = this.#read();
	}

	get changes(): ResourceChange[] {
		return this.batches.flat();
	}
	mark(): number {
		return this.changes.length;
	}

	async #read(): Promise<void> {
		try {
			while (!this.#closed) {
				const event = await new Promise<IteratorResult<SubscriptionEvent>>((resolve, reject) => {
					// The SDK's return() detaches the iterator but does not wake a
					// parked next(). End our reader explicitly when closing it.
					this.#stopRead = () => resolve({ done: true, value: undefined });
					this.#source.next().then(resolve, reject);
				});
				this.#stopRead = undefined;
				if (this.#closed) return;
				if (event.done) throw new Error("Watch subscription ended");
				if (event.value.type !== "action") continue;
				const { action, rejectionReason } = event.value.params;
				if (action.type !== ActionType.ResourceWatchChanged || rejectionReason !== undefined) {
					throw new Error(`Unexpected watch action: ${JSON.stringify(event.value.params)}`);
				}
				this.batches.push(action.changes.items);
				this.#notify();
			}
		} catch (error) {
			this.#error = error;
			this.#notify();
		}
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}

	/** A timeout stops only this assertion; it never starts or strands another next(). */
	waitFor(
		label: string,
		complete: (changes: readonly ResourceChange[]) => boolean,
		since = 0,
		timeoutMs = 4_000,
	): Promise<ResourceChange[]> {
		return new Promise((resolve, reject) => {
			const cleanup = (): void => {
				clearTimeout(timer);
				this.#listeners.delete(check);
			};
			const fail = (cause: unknown): void => {
				cleanup();
				reject(
					new Error(
						`Expected ${label}; watch=${JSON.stringify(this.#describeState())}; batches=${JSON.stringify(this.batches)}`,
						{ cause },
					),
				);
			};
			const check = (): void => {
				if (this.#error || this.#closed) {
					fail(this.#error ?? new Error("Collector closed"));
					return;
				}
				const changes = this.changes.slice(since);
				try {
					if (complete(changes)) {
						cleanup();
						resolve(changes);
					}
				} catch (error) {
					fail(error);
				}
			};
			const timer = setTimeout(() => fail(new Error("Timed out waiting for filesystem events")), timeoutMs);
			this.#listeners.add(check);
			check();
		});
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#stopRead?.();
		this.#notify();
		await this.#source.return();
		await this.#reading;
		if (this.#error) throw this.#error;
	}
}
