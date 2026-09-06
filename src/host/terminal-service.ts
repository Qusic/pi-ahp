import { stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename } from "node:path";
import {
	ActionType,
	AhpErrorCodes,
	type CreateTerminalParams,
	type StateAction,
	TerminalClaimKind,
	TerminalLifecycleStatus,
	type TerminalState,
	type URI,
} from "@microsoft/agent-host-protocol";
import { spawn as spawnPty } from "node-pty";
import { terminalInfo } from "../channels/terminal.ts";
import { channelKind, ROOT_CHANNEL } from "../core/channels.ts";
import type { AhpHost, TerminalHandler } from "../core/host.ts";
import { fileUriToPath, pathToFileUri } from "../core/uri.ts";
import { ProtocolError } from "../protocol/errors.ts";

interface Disposable {
	dispose(): void;
}

interface PtyProcess {
	onData(listener: (data: string) => void): Disposable;
	onExit(listener: (event: { exitCode: number }) => void): Disposable;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}

type PtySpawner = (
	file: string,
	args: string[],
	options: { name: string; cols: number; rows: number; cwd: string },
) => PtyProcess;

export interface TerminalServiceOptions {
	readonly defaultWorkingDirectory: string;
	readonly shell?: string;
	readonly log?: (message: string) => void;
}

interface TerminalEntry {
	readonly pty: PtyProcess;
	dataListener: Disposable | undefined;
	exitListener: Disposable | undefined;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 65_535;

function validDimension(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0 && value <= MAX_DIMENSION;
}

function dimension(value: number | undefined, fallback: number, name: string): number {
	const result = value ?? fallback;
	if (!validDimension(result)) {
		throw ProtocolError.invalidParams(`${name} must be an integer between 1 and ${MAX_DIMENSION}`);
	}
	return result;
}

function defaultShell(): string {
	try {
		return userInfo().shell || process.env.SHELL || "sh";
	} catch {
		return process.env.SHELL || "sh";
	}
}

/** Bridges terminal channel actions to independent pseudoterminal processes. */
export class TerminalService implements TerminalHandler {
	readonly #host: AhpHost;
	readonly #options: TerminalServiceOptions;
	readonly #spawn: PtySpawner;
	readonly #entries = new Map<URI, TerminalEntry>();
	readonly #unhookAction: () => void;
	readonly #unhookValidator: () => void;
	#closed = false;

	constructor(host: AhpHost, options: TerminalServiceOptions, spawn: PtySpawner = spawnPty) {
		this.#host = host;
		this.#options = options;
		this.#spawn = spawn;
		this.#unhookValidator = host.addClientActionValidator((channel, action, clientId) =>
			this.#validateClientAction(channel, action, clientId),
		);
		this.#unhookAction = host.onClientAction((channel, action) => this.#applyClientAction(channel, action));
	}

	async create(params: CreateTerminalParams, clientId: string): Promise<void> {
		if (this.#closed) {
			throw new Error("Terminal service is closed");
		}
		const channel = params?.channel;
		if (typeof channel !== "string" || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/[^/?#]+$/.test(channel)) {
			throw ProtocolError.invalidParams("createTerminal requires a URI channel");
		}
		const inferredKind = channelKind(channel);
		if (inferredKind !== undefined && inferredKind !== "terminal") {
			throw ProtocolError.invalidParams(`Channel belongs to ${inferredKind}, not terminal: ${channel}`);
		}
		this.#assertAvailable(channel);
		if (params.claim?.kind !== TerminalClaimKind.Client) {
			throw ProtocolError.invalidParams("Only client-owned terminals are supported");
		}
		if (!clientId || params.claim.clientId !== clientId) {
			throw ProtocolError.invalidParams("Terminal claim must match the initialized client");
		}
		if (params.name !== undefined && typeof params.name !== "string") {
			throw ProtocolError.invalidParams("Terminal name must be a string");
		}

		const cols = dimension(params.cols, DEFAULT_COLS, "cols");
		const rows = dimension(params.rows, DEFAULT_ROWS, "rows");
		const cwdUri = params.cwd ?? pathToFileUri(this.#options.defaultWorkingDirectory);
		if (typeof cwdUri !== "string" || !cwdUri.startsWith("file://")) {
			throw ProtocolError.invalidParams("Terminal cwd must be a file: URI");
		}
		let cwd: string;
		try {
			cwd = fileUriToPath(cwdUri);
		} catch {
			throw ProtocolError.invalidParams(`Invalid terminal cwd: ${cwdUri}`);
		}
		let cwdStat: Awaited<ReturnType<typeof stat>>;
		try {
			cwdStat = await stat(cwd);
		} catch {
			throw ProtocolError.notFound(cwdUri);
		}
		if (!cwdStat.isDirectory()) {
			throw ProtocolError.invalidParams(`Terminal cwd is not a directory: ${cwdUri}`);
		}
		// `stat` yielded to other requests; close the duplicate-create race before spawning.
		this.#assertAvailable(channel);

		const shell = this.#options.shell ?? defaultShell();
		const title = params.name ?? basename(shell);
		const pty = this.#spawn(shell, [], {
			name: "xterm-256color",
			cols,
			rows,
			cwd,
		});
		const state: TerminalState = {
			title,
			cwd: pathToFileUri(cwd),
			cols,
			rows,
			content: [],
			lifecycle: { status: TerminalLifecycleStatus.Running },
			claim: { kind: TerminalClaimKind.Client, clientId },
			isPty: true,
		};
		this.#host.store.create(channel, state, "terminal");

		const entry: TerminalEntry = { pty, dataListener: undefined, exitListener: undefined };
		this.#entries.set(channel, entry);
		entry.dataListener = pty.onData((data) => this.#onData(channel, entry, data));
		entry.exitListener = pty.onExit((event) => this.#onExit(channel, entry, event.exitCode));
		this.#publishCatalogue();
	}

	dispose(channel: URI): void {
		const entry = this.#entries.get(channel);
		if (entry) this.#remove(channel, entry, true);
	}

	/** Kills every PTY and unregisters side-effect hooks. Safe to call more than once. */
	shutdown(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unhookValidator();
		this.#unhookAction();
		const hadEntries = this.#entries.size > 0;
		for (const [channel, entry] of this.#entries) {
			this.#remove(channel, entry, false);
		}
		if (hadEntries) this.#publishCatalogue();
	}

	#assertAvailable(channel: URI): void {
		if (this.#entries.has(channel) || this.#host.store.has(channel)) {
			throw new ProtocolError(AhpErrorCodes.AlreadyExists, `Terminal already exists: ${channel}`);
		}
	}

	#state(channel: URI): TerminalState | undefined {
		return this.#host.store.kindOf(channel) === "terminal"
			? (this.#host.store.get(channel) as TerminalState)
			: undefined;
	}

	#validateClientAction(channel: URI, action: StateAction, clientId: string): string | undefined {
		if (this.#host.store.kindOf(channel) !== "terminal") return undefined;
		const state = this.#state(channel);
		if (!state || !this.#entries.has(channel)) return "Terminal process is unavailable";

		switch (action.type) {
			case ActionType.TerminalClaimed:
				return "This host does not support transferring terminal claims";
			case ActionType.TerminalInput:
				if (typeof action.data !== "string") return "Terminal input must be a string";
				break;
			case ActionType.TerminalResized:
				if (!validDimension(action.cols) || !validDimension(action.rows)) {
					return `Terminal dimensions must be integers between 1 and ${MAX_DIMENSION}`;
				}
				break;
			case ActionType.TerminalTitleChanged:
				if (typeof action.title !== "string") return "Terminal title must be a string";
				break;
			case ActionType.TerminalCleared:
				break;
			default:
				return `This host does not accept ${action.type} on terminal channels`;
		}

		if (state.claim.kind !== TerminalClaimKind.Client || state.claim.clientId !== clientId) {
			return "This terminal is claimed by another client";
		}
		if (
			(action.type === ActionType.TerminalInput || action.type === ActionType.TerminalResized) &&
			state.lifecycle.status !== TerminalLifecycleStatus.Running
		) {
			return "Terminal process has exited";
		}
		return undefined;
	}

	#applyClientAction(channel: URI, action: StateAction): void {
		const entry = this.#entries.get(channel);
		if (!entry) return;
		switch (action.type) {
			case ActionType.TerminalInput:
				entry.pty.write(action.data);
				break;
			case ActionType.TerminalResized:
				entry.pty.resize(action.cols, action.rows);
				break;
			case ActionType.TerminalTitleChanged:
				this.#publishCatalogue();
				break;
			case ActionType.TerminalCleared:
				// The reducer already cleared retained output; the PTY itself is unchanged.
				break;
		}
	}

	#onData(channel: URI, entry: TerminalEntry, data: string): void {
		if (this.#entries.get(channel) !== entry || data.length === 0) return;
		this.#host.dispatchServerAction(channel, { type: ActionType.TerminalData, data });
	}

	#onExit(channel: URI, entry: TerminalEntry, exitCode: number): void {
		if (this.#entries.get(channel) !== entry) return;
		const state = this.#state(channel);
		if (!state || state.lifecycle.status === TerminalLifecycleStatus.Exited) return;
		entry.dataListener?.dispose();
		entry.exitListener?.dispose();
		entry.dataListener = undefined;
		entry.exitListener = undefined;
		this.#host.dispatchServerAction(channel, { type: ActionType.TerminalExited, exitCode });
		this.#publishCatalogue();
	}

	#remove(channel: URI, entry: TerminalEntry, notify: boolean): void {
		if (this.#entries.get(channel) !== entry) return;
		const state = this.#state(channel);
		this.#entries.delete(channel);
		entry.dataListener?.dispose();
		entry.exitListener?.dispose();
		if (state?.lifecycle.status === TerminalLifecycleStatus.Running) {
			if (notify) {
				this.#host.dispatchServerAction(channel, { type: ActionType.TerminalExited });
			}
			try {
				entry.pty.kill();
			} catch (error) {
				this.#options.log?.(`cannot kill terminal ${channel}: ${String(error)}`);
			}
		}
		this.#host.store.delete(channel);
		if (notify) this.#publishCatalogue();
	}

	#publishCatalogue(): void {
		const terminals = [...this.#entries.keys()].sort().flatMap((resource) => {
			const state = this.#state(resource);
			return state ? [terminalInfo(resource, state)] : [];
		});
		this.#host.dispatchServerAction(ROOT_CHANNEL, { type: ActionType.RootTerminalsChanged, terminals });
	}
}
