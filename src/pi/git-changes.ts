/** Computes Git-backed FileEdit state without modifying the repository or index. */

import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChangesetFile, FileEdit } from "@microsoft/agent-host-protocol";
import type { PiChangesetKind } from "./changeset-uri.ts";

const GIT_BLOB_SCHEME = "git-blob:";
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const MAX_UNTRACKED_LINE_COUNT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_UNTRACKED_LINE_COUNT_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

const GIT_CONTEXT_OVERRIDES = new Set([
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_NAMESPACE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_QUARANTINE_PATH",
	"GIT_SHALLOW_FILE",
	"GIT_WORK_TREE",
]);

export interface GitWorkspace {
	readonly cwd: string;
	readonly repositoryRoot: string;
	readonly gitDirectory: string;
	readonly commonGitDirectory: string;
	readonly pathspec: string;
	readonly head?: string;
	readonly parent?: string;
}

export interface GitBlobRef {
	readonly sessionId: string;
	readonly oid: string;
	readonly path: string;
}

interface ParsedGitChange {
	readonly oldPath?: string;
	readonly newPath?: string;
	readonly oldOid?: string;
	readonly newOid?: string;
	readonly added?: number;
	readonly removed?: number;
}

export interface GitChangesBackend {
	inspect(cwd: string, signal?: AbortSignal): Promise<GitWorkspace | undefined>;
	compute(
		workspace: GitWorkspace,
		sessionId: string,
		kind: PiChangesetKind,
		signal?: AbortSignal,
	): Promise<ChangesetFile[]>;
	ignoredDirectories(workspace: GitWorkspace, signal?: AbortSignal): Promise<string[]>;
	pathForBlob(workspace: GitWorkspace, blob: GitBlobRef): string | undefined;
	readBlob(workspace: GitWorkspace, blob: GitBlobRef, signal?: AbortSignal): Promise<Buffer>;
}

class GitCommandError extends Error {}

function gitEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (GIT_CONTEXT_OVERRIDES.has(key) || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) {
			delete environment[key];
		}
	}
	return {
		...environment,
		GIT_NO_LAZY_FETCH: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		LC_ALL: "C",
	};
}

function bufferOf(value: string | Buffer): Buffer {
	return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function runGit(
	cwd: string,
	args: readonly string[],
	options: { readonly allowFailure?: boolean; readonly signal?: AbortSignal } = {},
): Promise<Buffer | undefined> {
	return new Promise((resolveCommand, rejectCommand) => {
		execFile(
			"git",
			["--literal-pathspecs", "-c", "core.filemode=false", "-c", "core.fsmonitor=false", ...args],
			{
				cwd,
				encoding: "buffer",
				env: gitEnvironment(),
				maxBuffer: MAX_GIT_OUTPUT,
				timeout: GIT_TIMEOUT_MS,
				...(options.signal ? { signal: options.signal } : {}),
			},
			(error, stdout, stderr) => {
				if (!error) {
					resolveCommand(bufferOf(stdout));
					return;
				}
				if (options.signal?.aborted) {
					rejectCommand(options.signal.reason ?? error);
					return;
				}
				const code = (error as NodeJS.ErrnoException).code;
				if (options.allowFailure && (code === "ENOENT" || typeof code === "number")) {
					resolveCommand(undefined);
					return;
				}
				if (code === "ENOENT") {
					rejectCommand(new GitCommandError("git executable was not found"));
					return;
				}
				const detail = bufferOf(stderr).toString("utf8").trim();
				rejectCommand(new GitCommandError(detail || error.message));
			},
		);
	});
}

function utf8(output: Buffer, source: string): string {
	if (!isUtf8(output)) throw new GitCommandError(`${source} returned a non-UTF-8 path`);
	return output.toString("utf8");
}

function outputLine(output: Buffer | undefined): string | undefined {
	if (!output) return undefined;
	const value = utf8(output, "git").replace(/\r?\n$/u, "");
	return value ? value : undefined;
}

function nulPaths(output: Buffer | undefined, source: string): string[] {
	if (!output || output.length === 0) return [];
	const value = utf8(output, source);
	if (!value.endsWith("\0")) throw new GitCommandError(`${source} returned an unterminated path list`);
	return value.slice(0, -1).split("\0");
}

function validOid(value: string | undefined): value is string {
	return value !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function blobOid(mode: string, oid: string | undefined): string | undefined {
	return /^100[0-7]{3}$/u.test(mode) && validOid(oid) && !/^0+$/u.test(oid) ? oid : undefined;
}

function gitPathToAbsolute(repositoryRoot: string, path: string): string | undefined {
	if (
		!path ||
		path.startsWith("/") ||
		path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		return undefined;
	}
	const absolute = resolve(repositoryRoot, ...path.split("/"));
	const rel = relative(repositoryRoot, absolute);
	return rel !== ".." && !rel.startsWith(`..${sep}`) ? absolute : undefined;
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function numberField(value: string | undefined): number | undefined {
	if (value === "-") return undefined;
	if (!value || !/^\d+$/u.test(value)) throw new GitCommandError("unexpected git numstat output");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new GitCommandError("git numstat exceeds the supported range");
	return parsed;
}

/** Parses the combined NUL-delimited `git diff --raw --numstat` stream. */
function parseGitChanges(output: Buffer): ParsedGitChange[] {
	if (output.length === 0) return [];
	const value = utf8(output, "git diff");
	if (!value.endsWith("\0")) throw new GitCommandError("git diff returned an unterminated record stream");
	const segments = value.split("\0");
	const changes: Omit<ParsedGitChange, "added" | "removed">[] = [];
	const stats = new Map<string, { readonly added?: number; readonly removed?: number }>();

	for (let index = 0; index < segments.length; ) {
		const segment = segments[index++];
		if (!segment) continue;
		if (segment.startsWith(":")) {
			const fields = segment.slice(1).split(" ");
			const oldMode = fields[0];
			const newMode = fields[1];
			const oldOid = fields[2];
			const newOid = fields[3];
			const status = fields[4]?.[0];
			const firstPath = segments[index++];
			if (!firstPath || !oldMode || !newMode || !status || !"ADMR".includes(status)) {
				throw new GitCommandError("unexpected git raw diff output");
			}
			const secondPath = status === "R" ? segments[index++] : undefined;
			if (status === "R" && !secondPath) throw new GitCommandError("git rename is missing its destination");
			const oldBlob = blobOid(oldMode, oldOid);
			const newBlob = blobOid(newMode, newOid);
			if (
				(oldMode !== "000000" && !/^100[0-7]{3}$/u.test(oldMode)) ||
				(newMode !== "000000" && !/^100[0-7]{3}$/u.test(newMode))
			) {
				continue;
			}
			switch (status) {
				case "A":
					changes.push({ newPath: firstPath, ...(newBlob ? { newOid: newBlob } : {}) });
					break;
				case "D":
					changes.push({ oldPath: firstPath, ...(oldBlob ? { oldOid: oldBlob } : {}) });
					break;
				case "M":
					changes.push({
						oldPath: firstPath,
						newPath: firstPath,
						...(oldBlob ? { oldOid: oldBlob } : {}),
						...(newBlob ? { newOid: newBlob } : {}),
					});
					break;
				case "R":
					if (secondPath) {
						changes.push({
							oldPath: firstPath,
							newPath: secondPath,
							...(oldBlob ? { oldOid: oldBlob } : {}),
							...(newBlob ? { newOid: newBlob } : {}),
						});
					}
					break;
			}
			continue;
		}

		const firstTab = segment.indexOf("\t");
		const secondTab = firstTab < 0 ? -1 : segment.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) throw new GitCommandError("unexpected git numstat output");
		const addedField = segment.slice(0, firstTab);
		const removedField = segment.slice(firstTab + 1, secondTab);
		const inlinePath = segment.slice(secondTab + 1);
		let oldPath: string | undefined;
		let newPath: string | undefined;
		if (inlinePath) {
			oldPath = inlinePath;
			newPath = inlinePath;
		} else {
			oldPath = segments[index++];
			newPath = segments[index++];
			if (!oldPath || !newPath) throw new GitCommandError("git rename numstat is missing a path");
		}
		const key = newPath ?? oldPath;
		if (key) {
			const added = numberField(addedField);
			const removed = numberField(removedField);
			stats.set(key, {
				...(added !== undefined ? { added } : {}),
				...(removed !== undefined ? { removed } : {}),
			});
		}
	}

	return changes.map((change) => {
		const counts = stats.get(change.newPath ?? change.oldPath ?? "");
		if (!counts) throw new GitCommandError("git diff is missing numstat data");
		return { ...change, ...counts };
	});
}

function lineCount(buffer: Buffer): number | undefined {
	if (!isUtf8(buffer) || buffer.includes(0)) return undefined;
	if (buffer.length === 0) return 0;
	let lines = 0;
	for (const byte of buffer) {
		if (byte === 0x0a) lines += 1;
	}
	return buffer.at(-1) === 0x0a ? lines : lines + 1;
}

interface BoundedRegularFile {
	readonly regular: boolean;
	readonly buffer?: Buffer;
	readonly bytes: number;
}

async function boundedRegularFile(path: string, budget: number): Promise<BoundedRegularFile | undefined> {
	let initial: Stats;
	try {
		initial = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!initial.isFile()) return { regular: false, bytes: 0 };
	if (budget <= 0 || initial.size > MAX_UNTRACKED_LINE_COUNT_BYTES || initial.size > budget) {
		return { regular: true, bytes: 0 };
	}

	const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP" || code === "ENOENT" || code === "ENXIO") return undefined;
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) return { regular: false, bytes: 0 };
		if (info.size > MAX_UNTRACKED_LINE_COUNT_BYTES || info.size > budget) return { regular: true, bytes: 0 };
		const buffer = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return { regular: true, buffer: buffer.subarray(0, offset), bytes: info.size };
	} finally {
		await handle.close();
	}
}

function diffCounts(change: ParsedGitChange): FileEdit["diff"] {
	return change.added === undefined && change.removed === undefined
		? undefined
		: {
				...(change.added !== undefined ? { added: change.added } : {}),
				...(change.removed !== undefined ? { removed: change.removed } : {}),
			};
}

function gitBlobUri(sessionId: string, oid: string, path: string, displayPath: string): string {
	const metadata = Buffer.from(JSON.stringify({ sessionId, oid, path } satisfies GitBlobRef)).toString("base64url");
	// Keep the query one opaque, unreserved token so URI parse/serialize round-trips preserve it.
	return `${GIT_BLOB_SCHEME}${pathToFileURL(displayPath).pathname}?${metadata}`;
}

export function parseGitBlobUri(uri: string): GitBlobRef | undefined {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== GIT_BLOB_SCHEME || parsed.hash || !parsed.search) return undefined;
	const encoded = parsed.search.slice(1);
	if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
	try {
		const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<GitBlobRef>;
		return typeof value.sessionId === "string" &&
			value.sessionId.length > 0 &&
			validOid(value.oid) &&
			typeof value.path === "string"
			? { sessionId: value.sessionId, oid: value.oid, path: value.path }
			: undefined;
	} catch {
		return undefined;
	}
}

export class GitChanges implements GitChangesBackend {
	async inspect(cwd: string, signal?: AbortSignal): Promise<GitWorkspace | undefined> {
		const rootOutput = await runGit(cwd, ["rev-parse", "--show-toplevel"], {
			allowFailure: true,
			...(signal ? { signal } : {}),
		});
		const root = outputLine(rootOutput);
		if (!root) return undefined;

		const [canonicalCwd, canonicalRoot] = await Promise.all([realpath(cwd), realpath(root)]);
		if (!isInside(canonicalRoot, canonicalCwd)) return undefined;
		const pathspec = relative(canonicalRoot, canonicalCwd).split(sep).join("/") || ".";
		const [headOutput, gitDirectoryOutput, commonGitDirectoryOutput] = await Promise.all([
			runGit(canonicalRoot, ["rev-parse", "--verify", "HEAD"], {
				allowFailure: true,
				...(signal ? { signal } : {}),
			}),
			runGit(canonicalRoot, ["rev-parse", "--absolute-git-dir"], signal ? { signal } : {}),
			runGit(canonicalRoot, ["rev-parse", "--git-common-dir"], signal ? { signal } : {}),
		]);
		const headValue = outputLine(headOutput);
		const head = validOid(headValue) ? headValue : undefined;
		const parentValue = head
			? outputLine(
					await runGit(canonicalRoot, ["rev-parse", "--verify", "HEAD^1"], {
						allowFailure: true,
						...(signal ? { signal } : {}),
					}),
				)
			: undefined;
		const parent = validOid(parentValue) ? parentValue : undefined;
		const gitDirectory = outputLine(gitDirectoryOutput);
		const commonGitDirectory = outputLine(commonGitDirectoryOutput);
		if (!gitDirectory || !commonGitDirectory) throw new GitCommandError("git did not report its metadata directory");
		return {
			cwd: canonicalCwd,
			repositoryRoot: canonicalRoot,
			gitDirectory: await realpath(resolve(canonicalRoot, gitDirectory)),
			commonGitDirectory: await realpath(resolve(canonicalRoot, commonGitDirectory)),
			pathspec,
			...(head ? { head } : {}),
			...(parent ? { parent } : {}),
		};
	}

	async compute(
		workspace: GitWorkspace,
		sessionId: string,
		kind: PiChangesetKind,
		signal?: AbortSignal,
	): Promise<ChangesetFile[]> {
		if (kind === "latest-commit") {
			if (!workspace.head) return [];
			const args = workspace.parent
				? [
						"diff",
						"--no-ext-diff",
						"--no-textconv",
						"--raw",
						"--numstat",
						"--no-abbrev",
						"--diff-filter=ADMR",
						"--find-renames",
						"-z",
						workspace.parent,
						workspace.head,
						"--",
						workspace.pathspec,
					]
				: [
						"diff-tree",
						"--no-ext-diff",
						"--no-textconv",
						"--root",
						"--no-commit-id",
						"-r",
						"--raw",
						"--numstat",
						"--no-abbrev",
						"--diff-filter=ADMR",
						"--find-renames",
						"-z",
						workspace.head,
						"--",
						workspace.pathspec,
					];
			const output = await runGit(workspace.repositoryRoot, args, signal ? { signal } : {});
			return this.#toFiles(workspace, sessionId, "latest-commit", parseGitChanges(output ?? Buffer.alloc(0)));
		}

		const changes: ParsedGitChange[] = [];
		if (workspace.head) {
			const output = await runGit(
				workspace.repositoryRoot,
				[
					"diff",
					"--no-ext-diff",
					"--no-textconv",
					"--raw",
					"--numstat",
					"--no-abbrev",
					"--diff-filter=ADMR",
					"--find-renames",
					"-z",
					workspace.head,
					"--",
					workspace.pathspec,
				],
				signal ? { signal } : {},
			);
			changes.push(...parseGitChanges(output ?? Buffer.alloc(0)));
		}
		const untracked = await runGit(
			workspace.repositoryRoot,
			[
				"ls-files",
				...(workspace.head ? [] : ["--cached"]),
				"--others",
				"--exclude-standard",
				"-z",
				"--",
				workspace.pathspec,
			],
			signal ? { signal } : {},
		);
		const known = new Set(changes.map((change) => change.newPath ?? change.oldPath));
		let remainingLineCountBytes = MAX_TOTAL_UNTRACKED_LINE_COUNT_BYTES;
		for (const path of nulPaths(untracked, "git ls-files")) {
			if (known.has(path)) continue;
			const absolute = gitPathToAbsolute(workspace.repositoryRoot, path);
			if (!absolute || !isInside(workspace.cwd, absolute)) continue;
			const content = await boundedRegularFile(absolute, remainingLineCountBytes);
			if (!content?.regular) continue;
			const added = content.buffer ? lineCount(content.buffer) : undefined;
			remainingLineCountBytes -= content.bytes;
			changes.push({ newPath: path, ...(added !== undefined ? { added, removed: 0 } : {}) });
		}
		return this.#toFiles(workspace, sessionId, "uncommitted", changes);
	}

	async ignoredDirectories(workspace: GitWorkspace, signal?: AbortSignal): Promise<string[]> {
		const output = await runGit(
			workspace.repositoryRoot,
			["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", workspace.pathspec],
			signal ? { signal } : {},
		);
		const directories: string[] = [];
		for (const path of nulPaths(output, "git ls-files --ignored")) {
			const absolute = gitPathToAbsolute(workspace.repositoryRoot, path.replace(/\/$/u, ""));
			if (absolute && isInside(workspace.cwd, absolute)) directories.push(absolute);
		}
		return directories;
	}

	pathForBlob(workspace: GitWorkspace, blob: GitBlobRef): string | undefined {
		const absolute = gitPathToAbsolute(workspace.repositoryRoot, blob.path);
		return absolute && isInside(workspace.cwd, absolute) ? absolute : undefined;
	}

	async readBlob(workspace: GitWorkspace, blob: GitBlobRef, signal?: AbortSignal): Promise<Buffer> {
		if (!validOid(blob.oid) || !this.pathForBlob(workspace, blob)) {
			throw new GitCommandError("invalid git blob reference");
		}
		const output = await runGit(workspace.repositoryRoot, ["cat-file", "blob", blob.oid], signal ? { signal } : {});
		if (!output) throw new GitCommandError("git blob was not found");
		return output;
	}

	#toFiles(
		workspace: GitWorkspace,
		sessionId: string,
		kind: PiChangesetKind,
		changes: readonly ParsedGitChange[],
	): ChangesetFile[] {
		const files: ChangesetFile[] = [];
		for (const change of changes) {
			const oldAbsolute = change.oldPath ? gitPathToAbsolute(workspace.repositoryRoot, change.oldPath) : undefined;
			const newAbsolute = change.newPath ? gitPathToAbsolute(workspace.repositoryRoot, change.newPath) : undefined;
			const oldPath = oldAbsolute && isInside(workspace.cwd, oldAbsolute) ? change.oldPath : undefined;
			const newPath = newAbsolute && isInside(workspace.cwd, newAbsolute) ? change.newPath : undefined;
			if ((!oldPath || !oldAbsolute) && (!newPath || !newAbsolute)) continue;

			let before: NonNullable<FileEdit["before"]> | undefined;
			let after: NonNullable<FileEdit["after"]> | undefined;
			if (kind === "latest-commit") {
				if ((oldPath && !change.oldOid) || (newPath && !change.newOid)) {
					throw new GitCommandError("git diff did not provide a committed blob id");
				}
				const afterBlob =
					newPath && newAbsolute && change.newOid
						? gitBlobUri(sessionId, change.newOid, newPath, newAbsolute)
						: undefined;
				const beforeBlob =
					oldPath && oldAbsolute && change.oldOid
						? gitBlobUri(sessionId, change.oldOid, oldPath, oldAbsolute)
						: undefined;
				if (beforeBlob) {
					// For an in-place edit both sides share one file identity. Using the
					// committed after-side URI also keeps clients from substituting the
					// mutable working-tree file for this immutable view.
					before = { uri: oldPath === newPath && afterBlob ? afterBlob : beforeBlob, content: { uri: beforeBlob } };
				}
				if (afterBlob) after = { uri: afterBlob, content: { uri: afterBlob } };
			} else if (kind === "uncommitted") {
				if (oldPath && !change.oldOid) throw new GitCommandError("git diff did not provide a baseline blob id");
				if (oldPath && oldAbsolute && change.oldOid) {
					before = {
						uri: pathToFileURL(oldAbsolute).toString(),
						content: { uri: gitBlobUri(sessionId, change.oldOid, oldPath, oldAbsolute) },
					};
				}
				if (newPath && newAbsolute) {
					const uri = pathToFileURL(newAbsolute).toString();
					after = { uri, content: { uri } };
				}
			}
			if (!before && !after) continue;
			const diff = diffCounts(change);
			const edit: FileEdit = {
				...(before ? { before } : {}),
				...(after ? { after } : {}),
				...(diff ? { diff } : {}),
			};
			const identity = (newPath ? newAbsolute : undefined) ?? (oldPath ? oldAbsolute : undefined);
			if (identity) files.push({ id: pathToFileURL(identity).toString(), edit });
		}
		return files.sort((left, right) => left.id.localeCompare(right.id));
	}
}
