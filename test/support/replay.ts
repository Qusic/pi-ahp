/**
 * Replays a recorded provider stream through a real `AgentSession`.
 *
 * The resulting current pi events are mapped into AHP state by the caller. This
 * keeps the compatibility check at the host boundary instead of treating pi's
 * internal event sequence as a public contract.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { InProcessPiBackend } from "../../src/pi/in-process-backend.ts";
import type { RecordedFixture } from "./recorded-fixtures.ts";
import type { RecordedInteraction, RecordedScenario } from "./recorded-scenarios.ts";

export interface ReplayEnvironment {
	readonly agentDir: string;
	close(): void;
}

export interface ReplayOptions {
	/** Milliseconds to wait for `agent_settled` before giving up. */
	readonly settleTimeoutMs?: number;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Gives a replay suite an isolated pi agent directory for its whole lifetime.
 *
 * Always overriding and later restoring the environment is intentional: using
 * a caller's existing directory would load their extensions into the corpus.
 */
export function createReplayEnvironment(): ReplayEnvironment {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-ahp-replay-agent-"));
	let closed = false;
	try {
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				"github-copilot": { type: "oauth", refresh: "stub", access: "stub", expires: Date.now() + 86_400_000 },
			}),
		);
		// The manual-compaction scenario deliberately uses a small history
		// budget; otherwise pi correctly refuses to compact this fixture.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 200 } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	} catch (error) {
		rmSync(agentDir, { recursive: true, force: true });
		throw error;
	}

	return {
		agentDir,
		close() {
			if (closed) return;
			closed = true;
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

function waitForMessageUpdates(backend: InProcessPiBackend, count: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let seen = 0;
		const unsubscribe = backend.subscribe((event) => {
			if (event.type === "message_update") seen += 1;
			if (seen >= count) {
				unsubscribe();
				resolve();
			} else if (event.type === "agent_settled") {
				unsubscribe();
				reject(new Error(`turn settled after ${seen} updates; replay interaction was never injected`));
			}
		});
	});
}

async function performInteraction(
	backend: InProcessPiBackend,
	interaction: Extract<RecordedInteraction, { replay: true }>,
): Promise<void> {
	switch (interaction.kind) {
		case "steer":
			await backend.steer(interaction.text);
			break;
	}
}

/**
 * Drives pi with every provider turn in a recorded scenario.
 *
 * The workspace is fresh for each invocation. Tools run for real, so capture
 * and replay obtain their files and interaction choreography from one manifest.
 */
export async function replayTurns(
	fixture: RecordedFixture,
	scenario: RecordedScenario,
	environment: ReplayEnvironment,
	options: ReplayOptions = {},
): Promise<AgentSessionEvent[]> {
	if (fixture.name !== scenario.name) {
		throw new Error(`fixture ${fixture.name} cannot be replayed as scenario ${scenario.name}`);
	}
	if (process.env.PI_CODING_AGENT_DIR !== environment.agentDir) {
		throw new Error("replay environment is not active");
	}

	const workspace = mkdtempSync(join(tmpdir(), `pi-ahp-replay-${fixture.name}-`));
	let backend: InProcessPiBackend | undefined;

	try {
		for (const [name, contents] of Object.entries(scenario.files ?? {})) {
			const target = join(workspace, name);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, contents);
		}

		backend = await InProcessPiBackend.create({
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
					// pi reads it, so restore it before pi sees the event.
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
			if (event.type === "agent_settled") settled = true;
		});

		const interaction = scenario.interaction?.replay ? scenario.interaction : undefined;
		const interactionReady = interaction ? waitForMessageUpdates(backend, interaction.afterUpdates) : undefined;
		const prompting = backend.prompt(scenario.prompt);
		if (interaction && interactionReady) {
			await interactionReady;
			await performInteraction(backend, interaction);
		}
		await prompting;

		if (scenario.followUp?.replay) {
			for (const prompt of scenario.followUp.prompts) await backend.prompt(prompt);
			if (scenario.followUp.compact) await backend.session.compact();
		}

		const deadline = Date.now() + (options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
		while (!settled && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		if (!settled) throw new Error(`${fixture.name}: replay never settled`);
		if (index !== fixture.turns.length) {
			throw new Error(`${fixture.name}: replay consumed ${index} of ${fixture.turns.length} provider turns`);
		}
		return events;
	} finally {
		backend?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	}
}
