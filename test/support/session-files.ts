import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Mirrors Pi's default cwd partition solely for synthetic JSONL fixtures. */
export function fixtureSessionDirectory(root: string, cwd: string): string {
	const partition = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	const directory = join(root, partition);
	mkdirSync(directory, { recursive: true });
	return directory;
}
