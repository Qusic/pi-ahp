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

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT_DIR, "test", "fixtures");

/** How long to wait for `agent_settled` before giving up on a scenario. */
const SETTLE_TIMEOUT_MS = 120_000;

interface Scenario {
	readonly name: string;
	readonly description: string;
	/** Files to create in the scenario's workspace. */
	readonly files?: Record<string, string>;
	readonly prompt: string;
	/** Model to run on, when the default cannot serve the scenario. */
	readonly model?: string;
	/** Optional interaction while the turn is in flight. */
	readonly during?: (backend: InProcessPiBackend) => Promise<void>;
	/** Optional interaction once the turn has settled, for events a prompt cannot provoke. */
	readonly after?: (backend: InProcessPiBackend) => Promise<void>;
}

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
			// Cancelled once the reply is demonstrably under way, rather than after
			// a fixed wait: the same 1.5s produced anywhere from 9 to 119 events
			// across runs, and the short ones cut the turn before there was any
			// streamed content for the cancellation to interrupt.
			await waitForUpdates(backend, 25);
			await backend.abort();
		},
	},
	{
		name: "steering",
		description: "A steering message injected into a running turn.",
		prompt: "Count slowly from 1 to 60, one number per line.",
		during: async (backend) => {
			await waitForUpdates(backend, 25);
			await backend.steer("Stop counting. Reply with the word STOPPED and nothing else.");
		},
	},
	{
		name: "tool-edit",
		description: "An `edit` call — the one tool whose result carries a diff and a patch.",
		files: { "greet.ts": 'export function greet(name: string) {\n\treturn "Hi " + name;\n}\n' },
		prompt: "In greet.ts, change the greeting from `Hi` to `Hello`. Use the edit tool. Then reply DONE.",
	},
	{
		name: "tool-write",
		description: "A `write` call — a whole new file rather than an edit to one.",
		prompt: "Create a file called haiku.txt containing exactly three short lines. Then reply DONE.",
	},
	{
		name: "tool-bash",
		description: "A `bash` call — stdout, exit status, and pi's truncation metadata.",
		files: { "data.txt": "one\ntwo\nthree\n" },
		prompt: "Use bash to count the lines in data.txt. Reply with just the number.",
	},
	{
		name: "tool-ls",
		description: "An `ls` call — a directory listing, which reports its own entry limit.",
		files: { "a.txt": "a\n", "b.txt": "b\n", "sub/c.txt": "c\n" },
		prompt: "Use the ls tool to list this directory. Reply with the entry names separated by commas.",
	},
	{
		name: "tool-grep",
		description: "A `grep` call — match counts and line truncation live in its details.",
		files: {
			"one.txt": "alpha\nBEACON here\ngamma\n",
			"two.txt": "delta\nnothing\n",
			"three.txt": "BEACON again\n",
		},
		prompt: "Use the grep tool to search for BEACON here. Reply with the matching file names only.",
	},
	{
		name: "tool-find",
		description: "A `find` call — path globbing, with its own result limit.",
		files: { "src/x.ts": "//x\n", "src/y.ts": "//y\n", "docs/z.md": "# z\n" },
		prompt: "Use the find tool to locate every .ts file under src. Reply with their paths only.",
	},
	{
		name: "compaction",
		description:
			"A manual compaction — `buildContextEntries` starts from the newest one, so this is the boundary history rebuilding and turn paging are built around.",
		files: { "note.txt": "ALPHA\n" },
		prompt: "Read note.txt and reply with its contents only.",
		after: async (backend) => {
			await backend.prompt("Use bash to run `seq 1 400`. Reply DONE.");
			await backend.prompt("Reply with the word TWO.");
			await backend.session.compact();
		},
	},
	{
		name: "bash-long-output",
		description: "A bash call whose output is large enough for pi to stream updates and report truncation.",
		prompt: "Use bash to run `seq 1 20000`. Then reply with the word DONE.",
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
/**
 * Fields the provider fills with an opaque blob that changes every run.
 *
 * Emptied rather than removed: their presence is part of the event shape the
 * mapper is handed, their contents are not.
 */
const OPAQUE_SIGNATURES = new Set(["thinkingSignature", "textSignature", "responseId"]);

function createScrubber(_workspace: string) {
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

/**
 * Replaces each event's `partial` with an index into a table of distinct ones.
 *
 * Every streamed event carries the message accumulated so far, and pi reads it:
 * dropping the field stops `message_update` from being emitted at all.
 *
 * Within one turn those are not snapshots but repeated references to a single
 * object pi mutates in place, so by the time the capture is serialised they all
 * hold the finished message. The intermediate states are therefore never
 * recorded — not because of this table, but because they no longer exist once
 * the stream ends. What the table removes is only writing that one object out
 * once per event, which is 1.5 MB across the corpus against 23 KB.
 *
 * A turn contributes one entry, and `replayTurns` puts them back.
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
	scenario: Scenario,
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

		// pi ships seven tools but activates four; the rest are in the registry
		// and have to be asked for. A fixture that only ever saw the default set
		// is why `grep`/`find`/`ls` results were never mapped.
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

		if (scenario.after) {
			settled = false;
			await scenario.after(backend);
			// `compact()` resolves before the session settles again.
			const secondDeadline = Date.now() + SETTLE_TIMEOUT_MS;
			while (!settled && Date.now() < secondDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}

		backend.dispose();
		const scrubber = createScrubber(workspace);
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
 * Points pi at a throwaway agent directory holding only credentials.
 *
 * Extensions are loaded from the *user's* `~/.pi/agent`, not the project, so
 * project trust does not keep them out. Without this a fixture records whoever
 * happens to be capturing it: an earlier run picked up a personal plugin's
 * `workflow` tools and would have baked them into the corpus.
 */
function isolateAgentDir(): void {
	// Fixed rather than `mkdtemp`: the path reaches the capture through session
	// paths and the env block pi records, so a random one turns every re-capture
	// into a diff of nothing.
	const dir = join(tmpdir(), "pi-ahp-capture-agent");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	// The model catalogue travels with the credentials. `models-store.json` is
	// the refreshed provider listing and carries each model's base URL; without
	// it pi falls back to its built-in catalogue, which points Copilot at the
	// individual endpoint and answers an enterprise key with a bare
	// `421 Misdirected Request`.
	for (const file of ["auth.json", "models.json", "models-store.json"]) {
		const source = join(homedir(), ".pi", "agent", file);
		if (existsSync(source)) {
			copyFileSync(source, join(dir, file));
		}
	}
	// `compact()` cuts at `keepRecentTokens` and refuses a session that never
	// reaches it. The default 20k would need a conversation far larger than any
	// scenario here; what the fixture is for is the *shape* of the compaction
	// events, so the threshold is lowered instead of the transcript inflated.
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ compaction: { keepRecentTokens: 200 } }, null, 2)}\n`);
	process.env.PI_CODING_AGENT_DIR = dir;
}

async function main(): Promise<void> {
	isolateAgentDir();
	const only = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
	const selected = only.length > 0 ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
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
