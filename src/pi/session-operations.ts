/** Orders metadata actions, creation, deletion and materialization for one Pi session identity. */

export class SessionOperations {
	readonly #tails = new Map<string, Promise<unknown>>();

	run<Value>(id: string, operation: () => Promise<Value>): Promise<Value>;
	run<Value>(id: string, operation: () => Value): Value | Promise<Value>;
	run<Value>(id: string, operation: () => Value | Promise<Value>): Value | Promise<Value> {
		const previous = this.#tails.get(id);
		if (previous) return this.#track(id, previous.catch(() => undefined).then(operation));
		// With no pending work, keep synchronous operations (including live actions) synchronous.
		const result = operation();
		return result instanceof Promise ? this.#track(id, result) : result;
	}

	#track<Value>(id: string, operation: Promise<Value>): Promise<Value> {
		const current = operation.finally(() => {
			if (this.#tails.get(id) === current) this.#tails.delete(id);
		});
		this.#tails.set(id, current);
		return current;
	}
}
