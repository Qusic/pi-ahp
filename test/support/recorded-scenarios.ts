export type RecordedInteraction =
	| {
			readonly kind: "abort";
			readonly afterUpdates: number;
			/** The captured aborted stream is self-contained and needs no replay-side abort. */
			readonly replay: false;
	  }
	| {
			readonly kind: "steer";
			readonly afterUpdates: number;
			readonly text: string;
			/** Replaying must inject the message to request the fixture's next provider turn. */
			readonly replay: true;
	  };

export interface RecordedFollowUp {
	readonly prompts: readonly string[];
	readonly compact?: boolean;
	/** Replaying must perform these operations to request every captured provider turn. */
	readonly replay: true;
}

export interface RecordedScenario {
	readonly name: string;
	readonly description: string;
	readonly prompt: string;
	/** Files both capture and replay create in the scenario workspace. */
	readonly files?: Readonly<Record<string, string>>;
	/** Model used while capturing, when the configured default cannot serve the scenario. */
	readonly model?: string;
	readonly interaction?: RecordedInteraction;
	readonly followUp?: RecordedFollowUp;
}

/**
 * The complete recorded corpus and the choreography needed to reproduce it.
 *
 * Capture and replay deliberately share this manifest. A scenario must not gain
 * a second copy of its workspace or interaction in a test runner keyed by name.
 */
export const RECORDED_SCENARIOS: readonly RecordedScenario[] = [
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
		interaction: { kind: "abort", afterUpdates: 25, replay: false },
	},
	{
		name: "steering",
		description: "A steering message injected into a running turn.",
		prompt: "Count slowly from 1 to 60, one number per line.",
		interaction: {
			kind: "steer",
			afterUpdates: 25,
			text: "Stop counting. Reply with the word STOPPED and nothing else.",
			replay: true,
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
		followUp: {
			prompts: ["Use bash to run `seq 1 400`. Reply DONE.", "Reply with the word TWO."],
			compact: true,
			replay: true,
		},
	},
	{
		name: "bash-long-output",
		description: "A bash call whose output is large enough for pi to stream updates and report truncation.",
		prompt: "Use bash to run `seq 1 20000`. Then reply with the word DONE.",
	},
];
