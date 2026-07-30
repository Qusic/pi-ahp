/**
 * Replays a recorded provider stream through a real `AgentSession`.
 *
 * A fixture records two layers of the same capture: `turns` is what the
 * provider fed pi, `events` is what pi emitted in response. Feeding `turns`
 * back in re-runs pi's own orchestration — turn boundaries, tool execution,
 * compaction — so a change in its semantics surfaces as a diff rather than
 * passing against a frozen copy of the old output.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { InProcessPiBackend } from "../../src/pi/in-process-backend.ts";

export interface RecordedFixture {
	readonly name: string;
	readonly prompt: string;
	readonly turns: readonly (readonly unknown[])[];
	/** Distinct `partial` payloads the turns refer to by index. */
	readonly partials?: readonly unknown[];
	readonly events: readonly AgentSessionEvent[];
}

export interface ReplayOptions {
	/** Files the scenario expects in its workspace. */
	readonly files?: Readonly<Record<string, string>>;
	/** Milliseconds to wait for `agent_settled` before giving up. */
	readonly settleTimeoutMs?: number;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Points pi at a throwaway agent directory holding a placeholder credential.
 *
 * Replay never reaches a provider — `streamFunction` is replaced before the
 * first prompt — but pi resolves auth while *selecting* the model and refuses
 * to start without one. Pointing at the real user directory instead would make
 * the suite depend on whoever runs it, and load their extensions.
 */
function useStubAgentDir(): void {
	if (process.env.PI_CODING_AGENT_DIR) {
		return;
	}
	const dir = join(tmpdir(), "pi-ahp-replay-agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({
			"github-copilot": { type: "oauth", refresh: "stub", access: "stub", expires: Date.now() + 86_400_000 },
		}),
	);
	process.env.PI_CODING_AGENT_DIR = dir;
}

/**
 * Drives pi with `turns` and returns the events it emits.
 *
 * The workspace is a fresh temporary directory: tools run for real, so a
 * scenario that edits a file needs that file to exist.
 */
export async function replayTurns(fixture: RecordedFixture, options: ReplayOptions = {}): Promise<AgentSessionEvent[]> {
	useStubAgentDir();
	const workspace = join(tmpdir(), `pi-ahp-replay-${fixture.name}`);
	rmSync(workspace, { recursive: true, force: true });
	mkdirSync(workspace, { recursive: true });

	try {
		for (const [name, contents] of Object.entries(options.files ?? {})) {
			const target = join(workspace, name);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, contents);
		}

		const backend = await InProcessPiBackend.create({
			cwd: workspace,
			sessionManager: SessionManager.create(workspace, undefined, { id: `replay-${fixture.name}` }),
		});
		backend.session.setActiveToolsByName(backend.session.getAllTools().map((tool) => tool.name));

		let index = 0;
		backend.session.agent.streamFunction = () => {
			const stream = createAssistantMessageEventStream();
			const turn = fixture.turns[index++];
			queueMicrotask(() => {
				if (!turn) {
					// pi asked for more turns than were recorded. Ending an empty
					// stream would hang on `result()`, so this fails loudly instead.
					stream.push({ type: "error", reason: "error", error: { message: "replay exhausted" } } as never);
					stream.end({ role: "assistant", content: [], stopReason: "error" } as never);
					return;
				}
				let last: unknown;
				for (const event of turn) {
					const record = event as Record<string, unknown>;
					// `partial` was factored into a lookup table at capture time;
					// pi reads it, so it has to come back before pi sees the event.
					// Every event in a turn gets the finished message rather than the
					// prefix it carried live, because pi accumulates into one object
					// and the capture only ever saw its final state.
					const restored =
						"partialRef" in record ? { ...record, partial: fixture.partials?.[record.partialRef as number] } : record;
					stream.push(restored as never);
					last = restored;
				}
				const done = last as { message?: unknown; error?: unknown } | undefined;
				stream.end((done?.message ?? done?.error) as never);
			});
			return stream;
		};

		const events: AgentSessionEvent[] = [];
		let settled = false;
		backend.subscribe((event) => {
			events.push(event);
			if (event.type === "agent_settled") {
				settled = true;
			}
		});

		await backend.prompt(fixture.prompt);
		const deadline = Date.now() + (options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
		while (!settled && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		backend.dispose();
		if (!settled) {
			throw new Error(`${fixture.name}: replay never settled`);
		}
		return events;
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

/** The event-type sequence, with runs of the same type collapsed to one. */
export function eventSkeleton(events: readonly { type: string }[]): string[] {
	return events.map((event) => event.type).filter((type, i, all) => type !== all[i - 1]);
}
