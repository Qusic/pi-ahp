/**
 * Human-readable descriptions of what the agent is doing right now.
 *
 * `SessionState.activity` / `ChatState.activity` are the protocol's slot for
 * the line a client shows next to its spinner. Without them a long turn is an
 * opaque wait — pi's event stream knows it is reading `src/main.ts`, but the
 * client only sees "working".
 *
 * These are display strings, not a machine contract: a client renders them
 * verbatim, so they should read like something a person would say.
 */

/** Longest a rendered command or path may be before it is shortened. */
const MAX_LENGTH = 60;

/**
 * Shortens the middle rather than the end.
 *
 * The informative parts of both a path and a shell command sit at the two ends
 * — the file name, the flags — so trimming the tail loses the most useful half.
 */
function shorten(value: string, limit = MAX_LENGTH): string {
	const collapsed = value.replace(/\s+/gu, " ").trim();
	if (collapsed.length <= limit) {
		return collapsed;
	}
	const head = Math.ceil((limit - 1) / 2);
	const tail = Math.floor((limit - 1) / 2);
	return `${collapsed.slice(0, head)}…${collapsed.slice(collapsed.length - tail)}`;
}

/** Renders a path relative to the working directory when it sits underneath it. */
function displayPath(value: unknown, workingDirectory?: string): string | undefined {
	if (typeof value !== "string" || value.length === 0) {
		return undefined;
	}
	const relative =
		workingDirectory && value.startsWith(`${workingDirectory}/`) ? value.slice(workingDirectory.length + 1) : value;
	return shorten(relative);
}

/**
 * Describes a tool invocation.
 *
 * pi's built-in tools are named individually so the common cases read well;
 * anything else — an extension tool, a custom tool — falls back to its own
 * name, which is still better than nothing.
 */
export function describeToolCall(toolName: string, args: unknown, workingDirectory?: string): string {
	const input = (args ?? {}) as Record<string, unknown>;
	const path = displayPath(input.path, workingDirectory);

	switch (toolName) {
		case "read":
			return path ? `Reading ${path}` : "Reading a file";
		case "write":
			return path ? `Writing ${path}` : "Writing a file";
		case "edit":
			return path ? `Editing ${path}` : "Editing a file";
		case "bash": {
			const command = typeof input.command === "string" ? shorten(input.command) : undefined;
			return command ? `Running ${command}` : "Running a command";
		}
		case "ls":
			return path ? `Listing ${path}` : "Listing files";
		case "find": {
			const pattern = typeof input.pattern === "string" ? shorten(input.pattern, 30) : undefined;
			return pattern ? `Finding ${pattern}` : "Finding files";
		}
		case "grep": {
			const pattern = typeof input.pattern === "string" ? shorten(input.pattern, 30) : undefined;
			return pattern ? `Searching for ${pattern}` : "Searching";
		}
		default:
			return `Running ${shorten(toolName, 40)}`;
	}
}

/**
 * The one argument that says what a tool call is about.
 *
 * `toolInput` is rendered for the call itself, and the protocol carries no
 * structured parameters next to it, so serialising the whole argument object
 * spends the field on quoting and braces — a shell command comes out as
 * `{"command":"ls -la","timeout":5}` rather than something a reader can run.
 * Anything without an obvious subject keeps the full arguments, which is still
 * the most informative thing available for it.
 */
export function toolInputFor(toolName: string, args: unknown): string | undefined {
	const input = (args ?? {}) as Record<string, unknown>;
	switch (toolName) {
		case "bash":
			return stringArg(input.command) ?? fullArguments(args);
		case "grep":
		case "find":
			return searchInput(input) ?? fullArguments(args);
		case "read":
		case "write":
		case "edit":
		case "ls":
			return stringArg(input.path) ?? fullArguments(args);
		default:
			return fullArguments(args);
	}
}

function stringArg(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fullArguments(args: unknown): string | undefined {
	return args === undefined ? undefined : JSON.stringify(args, null, 2);
}

/**
 * A search rendered as its pattern plus whatever narrows it.
 *
 * The pattern alone loses the difference between searching one directory and
 * searching the tree. Models fill the defaults in explicitly — a capture has
 * `path: "."`, a glob matching everything, `ignoreCase: false`, `limit: 100`
 * — so appending everything present would bury the pattern in restated
 * defaults. Only arguments that actually narrow the search are shown, in the
 * order `rg` writes them, which is also how they read aloud.
 */
function searchInput(input: Record<string, unknown>): string | undefined {
	const pattern = stringArg(input.pattern);
	if (!pattern) {
		return undefined;
	}
	const parts = [pattern];
	const glob = stringArg(input.glob);
	if (glob && glob !== "**/*") {
		parts.push(`--glob ${glob}`);
	}
	if (input.ignoreCase === true) {
		parts.push("--ignore-case");
	}
	const path = stringArg(input.path);
	if (path && path !== ".") {
		parts.push(`in ${path}`);
	}
	return parts.join(" ");
}

/** What to show between tool calls, while the model is producing output. */
/**
 * The same description, phrased for a call that has finished.
 *
 * The two sit next to each other in a transcript — one line for a call in
 * flight, one for a call that completed — so reusing the present-tense text
 * leaves a finished call still claiming to be running. Only the leading verb
 * changes, which keeps the subject identical between them.
 */
const PAST_TENSE_VERBS: Record<string, string> = {
	Reading: "Read",
	Writing: "Wrote",
	Editing: "Edited",
	Running: "Ran",
	Listing: "Listed",
	Finding: "Found",
	Searching: "Searched",
};

export function describeFinishedToolCall(toolName: string, args: unknown, workingDirectory?: string): string {
	const description = describeToolCall(toolName, args, workingDirectory);
	const [verb, ...rest] = description.split(" ");
	const past = verb ? PAST_TENSE_VERBS[verb] : undefined;
	return past ? [past, ...rest].join(" ") : description;
}

export const THINKING_ACTIVITY = "Thinking";
export const RESPONDING_ACTIVITY = "Responding";
