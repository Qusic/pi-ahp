/**
 * Records real pi event streams as offline fixtures.
 *
 * A maintenance task, not part of the daily loop, so it has no `package.json`
 * script — node runs the file directly. Needs credentials present:
 *
 *     nix develop -c node scripts/capture-fixtures.ts
 *
 * Each scenario drives a real model, captures the raw `AgentSessionEvent[]`,
 * scrubs anything machine- or tenant-specific, and writes
 * `test/fixtures/<name>.json`. `test/fixture-replay.test.ts` then replays them
 * through the mapper offline.
 *
 * Recording at the *event* layer rather than the HTTP layer is deliberate: the
 * mapper's contract is with pi's event stream, so that is the boundary worth
 * pinning. It is also far more stable than provider wire formats, which differ
 * per API dialect and change without notice.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

/** How long to wait for `agent_settled` before giving up on a scenario. */
const SETTLE_TIMEOUT_MS = 120_000;

interface Scenario {
	readonly name: string;
	readonly description: string;
	/** Files to create in the scenario's workspace. */
	readonly files?: Record<string, string>;
	readonly prompt: string;
	/** Optional interaction while the turn is in flight. */
	readonly during?: (backend: InProcessPiBackend) => Promise<void>;
}

const SCENARIOS: Scenario[] = [
	{
		name: "plain-text",
		description: "A reply with no tool calls — the simplest possible turn.",
		prompt: "Reply with exactly the word PONG and nothing else.",
	},
	{
		name: "single-tool",
		description: "One tool call, then an answer derived from its result.",
		files: { "note.txt": "ALPHA BETA GAMMA\n" },
		prompt: "Read note.txt and reply with its exact contents only.",
	},
	{
		name: "parallel-tools",
		description: "Several tool calls in one assistant message — exercises contentIndex fan-out.",
		files: { "a.txt": "FIRST\n", "b.txt": "SECOND\n" },
		prompt: "Read both a.txt and b.txt, then reply with their contents separated by a comma.",
	},
	{
		name: "tool-loop",
		description:
			"Two or more assistant messages in one turn — the case where contentIndex restarts and partIds must not collide.",
		files: { "data/values.txt": "42\n" },
		prompt:
			"First list the files under the data directory, then read the file you find there, then reply with its contents only.",
	},
	{
		name: "tool-error",
		description: "A failing tool call the agent has to recover from.",
		prompt: "Read a file called does-not-exist.txt and tell me plainly whether it exists.",
	},
	{
		name: "abort",
		description: "A turn cancelled while it is running.",
		prompt: "Count slowly from 1 to 60, one number per line, with no other text.",
		during: async (backend) => {
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			await backend.abort();
		},
	},
	{
		name: "steering",
		description: "A steering message injected into a running turn.",
		prompt: "Count slowly from 1 to 60, one number per line.",
		during: async (backend) => {
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			await backend.steer("Stop counting. Reply with the word STOPPED and nothing else.");
		},
	},
];

/**
 * Replaces machine- and tenant-specific values.
 *
 * Tool call ids matter most: Copilot's are long signed blobs that may carry
 * tenant information, and they change on every run, so they are rewritten to
 * stable `toolcall_N` handles.
 *
 * The OS username is deliberately **not** substituted blindly. An early version
 * did, and on a machine where the account is literally `user` it rewrote every
 * `"role": "user"` in the capture into `"role": "${user}"` — silently
 * corrupting every fixture. Paths are already covered by the `homedir`
 * substitution; anything left over is reported by {@link auditFixture} for a
 * human to look at rather than mangled automatically.
 */
function createScrubber(workspace: string) {
	const home = homedir();
	const toolCallIds = new Map<string, string>();

	const scrubString = (value: string): string => {
		// The `${...}` text is the fixture's placeholder syntax, not an unescaped
		// template literal.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: placeholder text
		let out = value.split(workspace).join("${workdir}");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: placeholder text
		out = out.split(home).join("${homedir}");
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
			// Wall-clock timestamps would make every re-capture a diff.
			out[key] = key === "timestamp" && typeof value === "number" ? 0 : apply(value);
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
 *
 * Before this, a 60-line count captured at 5.6 MB.
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

/** Reports anything that still looks machine-specific, for human review. */
function auditFixture(name: string, serialised: string): void {
	const problems: string[] = [];
	const home = homedir();
	const user = userInfo().username;
	if (serialised.includes(home)) {
		problems.push(`raw home directory (${home})`);
	}
	if (serialised.includes("/tmp/pi-ahp-capture-")) {
		problems.push("raw capture workspace path");
	}
	// Reported, never auto-replaced — see createScrubber.
	if (new RegExp(`\\b${user}\\b`).test(serialised) && user !== "user") {
		problems.push(`OS username (${user}) — check whether it is real identity or incidental`);
	}
	if (problems.length > 0) {
		process.stderr.write(`\n  ⚠ ${name}: ${problems.join("; ")}\n`);
	}
}

async function runScenario(scenario: Scenario): Promise<AgentSessionEvent[]> {
	const workspace = mkdtempSync(join(tmpdir(), `pi-ahp-capture-${scenario.name}-`));
	try {
		for (const [name, contents] of Object.entries(scenario.files ?? {})) {
			const target = join(workspace, name);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, contents);
		}

		const backend = await InProcessPiBackend.create({
			cwd: workspace,
			sessionManager: SessionManager.create(workspace),
		});

		const events: AgentSessionEvent[] = [];
		let settled = false;
		backend.subscribe((event) => {
			events.push(event);
			if (event.type === "agent_settled") {
				settled = true;
			}
		});

		const prompting = backend.prompt(scenario.prompt);
		if (scenario.during) {
			await scenario.during(backend);
		}
		await prompting;

		const deadline = Date.now() + SETTLE_TIMEOUT_MS;
		while (!settled && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!settled) {
			throw new Error(`${scenario.name}: never settled`);
		}

		backend.dispose();
		const scrubber = createScrubber(workspace);
		scrubber.collect(events);
		return pruneAccumulated(scrubber.apply(events) as AgentSessionEvent[]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const only = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
	const selected = only.length > 0 ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
	mkdirSync(FIXTURE_DIR, { recursive: true });

	for (const scenario of selected) {
		process.stderr.write(`capturing ${scenario.name}… `);
		try {
			const events = await runScenario(scenario);
			const serialised = `${JSON.stringify({ name: scenario.name, description: scenario.description, prompt: scenario.prompt, events }, null, "\t")}\n`;
			writeFileSync(join(FIXTURE_DIR, `${scenario.name}.json`), serialised);
			process.stderr.write(`${events.length} events, ${Math.round(serialised.length / 1024)} KB\n`);
			auditFixture(scenario.name, serialised);
		} catch (error) {
			process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
}

await main();
