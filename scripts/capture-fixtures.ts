/**
 * Records real pi event streams as offline fixtures.
 *
 * A maintenance task, not part of the daily loop, so it has no `package.json`
 * script — node runs the file directly. Needs credentials present:
 *
 *     nix develop -c pnpm exec node scripts/capture-fixtures.ts
 *
 * Each scenario drives a real model, captures its provider stream and the
 * resulting `AgentSessionEvent[]`, scrubs machine- and tenant-specific data,
 * and writes `test/fixtures/<name>.json`. `test/mapper-fixtures.test.ts` then replays them
 * through the mapper offline.
 *
 * Recording at the *event* layer rather than the HTTP layer is deliberate: the
 * mapper's contract is with pi's event stream, so that is the boundary worth
 * pinning. It is also far more stable than provider wire formats, which differ
 * per API dialect and change without notice.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";
import { RECORDED_SCENARIOS, type RecordedScenario } from "../test/support/recorded-scenarios.ts";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT_DIR, "test", "fixtures");

/** How long to wait for `agent_settled` before giving up on a scenario. */
const SETTLE_TIMEOUT_MS = 120_000;

/** Resolves once the running turn has streamed `count` updates, or it ends. */
function waitForUpdates(backend: InProcessPiBackend, count: number): Promise<void> {
	return new Promise((resolve) => {
		let seen = 0;
		const unsubscribe = backend.subscribe((event) => {
			if (event.type === "message_update") {
				seen++;
			}
			if (seen >= count || event.type === "agent_settled") {
				unsubscribe();
				resolve();
			}
		});
	});
}

/**
 * Fields the provider fills with an opaque blob that changes every run.
 * Emptied rather than removed: field presence is part of the event shape, but
 * the mapper does not consume the value.
 */
const OPAQUE_SIGNATURES = new Set(["thinkingSignature", "textSignature", "responseId"]);

/**
 * Replaces machine- and tenant-specific values. Opaque tool call ids become
 * stable `toolcall_N` handles. Usernames are only audited: common account names
 * such as `user` also occur as protocol values and cannot be replaced safely.
 */
function createScrubber() {
	const home = homedir();
	const toolCallIds = new Map<string, string>();

	const scrubString = (value: string): string => {
		// Only the home directory is left to rewrite: the workspace, the agent
		// directory, and the session id are fixed at the source now.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: placeholder text
		let out = value.split(home).join("${homedir}");
		for (const [real, stable] of toolCallIds) {
			out = out.split(real).join(stable);
		}
		return out;
	};

	const registerToolCallId = (value: string): void => {
		if (!toolCallIds.has(value)) {
			toolCallIds.set(value, `toolcall_${toolCallIds.size}`);
		}
	};

	// Two passes: collect ids first so every later occurrence rewrites to the
	// same handle regardless of where it appears.
	const collect = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) {
				collect(item);
			}
			return;
		}
		if (typeof node !== "object" || node === null) {
			return;
		}
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if ((key === "id" || key === "toolCallId") && typeof value === "string" && value.length > 0) {
				registerToolCallId(value);
			}
			collect(value);
		}
	};

	const apply = (node: unknown): unknown => {
		if (typeof node === "string") {
			return scrubString(node);
		}
		if (Array.isArray(node)) {
			return node.map(apply);
		}
		if (typeof node !== "object" || node === null) {
			return node;
		}
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (key === "timestamp" && typeof value === "number") {
				// Wall-clock timestamps would make every re-capture a diff.
				out[key] = 0;
			} else if (OPAQUE_SIGNATURES.has(key) && typeof value === "string") {
				// Kilobytes of server-side blobs — encrypted reasoning, response
				// correlation — opaque and different on every run. The mapper reads
				// none of them, so the fixture keeps the field and drops the payload.
				out[key] = "";
			} else {
				out[key] = apply(value);
			}
		}
		return out;
	};

	return { collect, apply };
}

/**
 * Strips the two fields that make a capture quadratic in output length.
 *
 * Both repeat the whole message so far on *every* streamed delta:
 *
 * - `message_update.message` — the accumulated `AgentMessage`. The mapper never
 *   reads it on an update (only on `message_start` / `message_end`), so only
 *   `role` is kept.
 * - `assistantMessageEvent.partial` — kept **only** on `toolcall_start`, where
 *   the mapper reads `partial.content[contentIndex]` to recover a tool call's
 *   id and name. For text and reasoning it is fully reconstructible from the
 *   deltas, and `toolcall_end` carries its own resolved `toolCall`.
 */
function pruneAccumulated(events: AgentSessionEvent[]): AgentSessionEvent[] {
	return events.map((event) => {
		if (event.type !== "message_update") {
			return event;
		}
		const record = event as unknown as Record<string, unknown>;
		const delta = record.assistantMessageEvent as Record<string, unknown> | undefined;
		const message = record.message as { role?: string } | undefined;

		let nextDelta = delta;
		if (delta?.partial && typeof delta.type === "string" && delta.type !== "toolcall_start") {
			const { partial: _dropped, ...rest } = delta;
			nextDelta = rest;
		}

		return {
			...record,
			...(message ? { message: { role: message.role } } : {}),
			...(nextDelta ? { assistantMessageEvent: nextDelta } : {}),
		} as unknown as AgentSessionEvent;
	});
}

/**
 * Replaces each event's `partial` with an index into a table of distinct ones.
 *
 * Every streamed event carries the message accumulated so far, and pi reads it:
 * dropping the field stops `message_update` from being emitted at all.
 *
 * Within a turn these are repeated references to one object that pi mutates in
 * place, so serialization would write the same finished message on every event.
 * The table stores each distinct value once, and `replayTurns` restores it.
 */
function dedupePartials(turns: unknown[][]): { turns: unknown[][]; partials: unknown[] } {
	const partials: unknown[] = [];
	const index = new Map<string, number>();
	const next = turns.map((turn) =>
		turn.map((event) => {
			const record = event as Record<string, unknown>;
			if (!("partial" in record)) {
				return event;
			}
			const key = JSON.stringify(record.partial);
			let at = index.get(key);
			if (at === undefined) {
				at = partials.length;
				index.set(key, at);
				partials.push(record.partial);
			}
			const { partial: _replaced, ...rest } = record;
			return { ...rest, partialRef: at };
		}),
	);
	return { turns: next, partials };
}

/** Reports anything that still looks machine-specific, for human review. */
function auditFixture(name: string, serialised: string): void {
	const problems: string[] = [];
	const home = homedir();
	const user = userInfo().username;
	if (serialised.includes(home)) {
		problems.push(`raw home directory (${home})`);
	}
	// The capture paths are fixed and carry no identity, so they are allowed to
	// appear — `tool-error` records an ENOENT message that names one. What is
	// still worth reporting is a path from some *other* run, which would mean
	// the fixed-path scheme stopped holding.
	for (const stray of serialised.match(/\/tmp\/pi-ahp-capture-[a-z-]*-[A-Za-z0-9]{6}/g) ?? []) {
		problems.push(`randomised capture path (${stray})`);
	}
	// Reported, never auto-replaced — see createScrubber.
	if (new RegExp(`\\b${user}\\b`).test(serialised) && user !== "user") {
		problems.push(`OS username (${user}) — check whether it is real identity or incidental`);
	}
	if (problems.length > 0) {
		process.stderr.write(`\n  ⚠ ${name}: ${problems.join("; ")}\n`);
	}
}

async function runScenario(
	scenario: RecordedScenario,
): Promise<{ turns: unknown[][]; partials: unknown[]; events: AgentSessionEvent[] }> {
	// Fixed path and session id, for the same reason as the agent directory:
	// what is deterministic at the source needs no scrubbing afterwards.
	const workspace = join(tmpdir(), `pi-ahp-capture-${scenario.name}`);
	rmSync(workspace, { recursive: true, force: true });
	mkdirSync(workspace, { recursive: true });
	try {
		for (const [name, contents] of Object.entries(scenario.files ?? {})) {
			const target = join(workspace, name);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, contents);
		}

		const backend = await InProcessPiBackend.create({
			cwd: workspace,
			sessionManager: SessionManager.create(workspace, undefined, { id: `capture-${scenario.name}` }),
		});

		// Some built-in tools are registered but inactive by default. Enable the
		// complete set so captures exercise every tool-result shape.
		backend.session.setActiveToolsByName(backend.session.getAllTools().map((tool) => tool.name));
		if (scenario.model) {
			await backend.selectModel({ id: scenario.model });
		}

		// The provider's own event stream, recorded by relaying it through a
		// stream of our own. This is what pi is *fed*; `events` below is what pi
		// *emits* in response. Replaying the former runs the real `AgentSession`,
		// so a change in pi's semantics shows up as a diff instead of passing
		// silently against a frozen recording of its output.
		const turns: unknown[][] = [];
		const upstream = backend.session.agent.streamFunction;
		backend.session.agent.streamFunction = (model, context, options) => {
			const turn: unknown[] = [];
			turns.push(turn);
			const relay = createAssistantMessageEventStream();
			void (async () => {
				const source = await upstream(model, context, options);
				for await (const event of source) {
					turn.push(event);
					relay.push(event);
				}
				relay.end(await source.result());
			})();
			return relay;
		};

		const events: AgentSessionEvent[] = [];
		let settled = false;
		backend.subscribe((event) => {
			events.push(event);
			if (event.type === "agent_settled") {
				settled = true;
			}
		});

		const interactionReady = scenario.interaction
			? waitForUpdates(backend, scenario.interaction.afterUpdates)
			: undefined;
		const prompting = backend.prompt(scenario.prompt);
		if (scenario.interaction && interactionReady) {
			await interactionReady;
			if (scenario.interaction.kind === "abort") await backend.abort();
			else await backend.steer(scenario.interaction.text);
		}
		await prompting;

		const deadline = Date.now() + SETTLE_TIMEOUT_MS;
		while (!settled && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!settled) {
			throw new Error(`${scenario.name}: never settled`);
		}

		if (scenario.followUp) {
			settled = false;
			for (const prompt of scenario.followUp.prompts) await backend.prompt(prompt);
			if (scenario.followUp.compact) await backend.session.compact();
			if (scenario.followUp.prompts.length > 0) {
				const secondDeadline = Date.now() + SETTLE_TIMEOUT_MS;
				while (!settled && Date.now() < secondDeadline) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				if (!settled) throw new Error(`${scenario.name}: follow-up never settled`);
			}
		}

		backend.dispose();
		const scrubber = createScrubber();
		scrubber.collect(events);
		scrubber.collect(turns);
		const deduped = dedupePartials(scrubber.apply(turns) as unknown[][]);
		return {
			turns: deduped.turns,
			partials: deduped.partials,
			events: pruneAccumulated(scrubber.apply(events) as AgentSessionEvent[]),
		};
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

/**
 * Points pi at a throwaway agent directory containing only capture essentials.
 *
 * User-level extensions are outside project-trust gating. Isolating the agent
 * directory prevents a maintainer's personal tools from contaminating the
 * recorded corpus.
 */
function isolateAgentDir(): void {
	// Fixed rather than `mkdtemp`: the path reaches the capture through session
	// paths and the env block pi records, so a random one turns every re-capture
	// into a diff of nothing.
	const dir = join(tmpdir(), "pi-ahp-capture-agent");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	// Copy the model catalogue with the credentials because refreshed provider
	// entries may carry endpoints that differ from pi's built-in defaults.
	for (const file of ["auth.json", "models.json", "models-store.json"]) {
		const source = join(homedir(), ".pi", "agent", file);
		if (existsSync(source)) {
			copyFileSync(source, join(dir, file));
		}
	}
	// The default compaction threshold exceeds these small scenarios. Lower it
	// so the fixture captures event shape without inflating the transcript.
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ compaction: { keepRecentTokens: 200 } }, null, 2)}\n`);
	process.env.PI_CODING_AGENT_DIR = dir;
}

async function main(): Promise<void> {
	isolateAgentDir();
	const only = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
	const selected =
		only.length > 0 ? RECORDED_SCENARIOS.filter((scenario) => only.includes(scenario.name)) : RECORDED_SCENARIOS;
	mkdirSync(FIXTURE_DIR, { recursive: true });

	const written: string[] = [];
	for (const scenario of selected) {
		process.stderr.write(`capturing ${scenario.name}… `);
		try {
			const { turns, partials, events } = await runScenario(scenario);
			const serialised = `${JSON.stringify({ name: scenario.name, description: scenario.description, prompt: scenario.prompt, partials, turns, events }, null, "\t")}\n`;
			const path = join(FIXTURE_DIR, `${scenario.name}.json`);
			writeFileSync(path, serialised);
			written.push(path);
			process.stderr.write(
				`${turns.length} turns / ${events.length} events, ${Math.round(serialised.length / 1024)} KB\n`,
			);
			auditFixture(scenario.name, serialised);
		} catch (error) {
			process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}

	// Written through the formatter the repository already checks with, so a
	// capture lands in the form `pnpm run lint` expects instead of needing the
	// directory excluded from it.
	if (written.length > 0) {
		execFileSync(join(ROOT_DIR, "node_modules", ".bin", "biome"), ["format", "--write", ...written], {
			stdio: "ignore",
		});
	}
}

await main();
