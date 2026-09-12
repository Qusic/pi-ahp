import { inspect } from "node:util";

export interface EventuallyOptions {
	readonly timeoutMs?: number;
	readonly intervalMs?: number;
	/** Captures useful state only when the condition times out. */
	readonly describe?: () => unknown;
}

/** Polls an observable condition with one timeout policy and a useful failure label. */
export async function eventually(
	label: string,
	predicate: () => boolean | Promise<boolean>,
	options: EventuallyOptions = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 2_000;
	const intervalMs = options.intervalMs ?? 5;
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) {
			const observation = options.describe ? `; last observation: ${inspect(options.describe())}` : "";
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${observation}`);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
	}
}
