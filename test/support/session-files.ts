import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ONE_PIXEL_PNG } from "./images.ts";

/** Mirrors Pi's default cwd partition solely for synthetic JSONL fixtures. */
export function fixtureSessionDirectory(root: string, cwd: string): string {
	const partition = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	const directory = join(root, partition);
	mkdirSync(directory, { recursive: true });
	return directory;
}

/** Writes a synthetic Pi session with one tool turn and a trailing user message; starts no host. */
export function writeSessionFixture(root: string, id: string, cwd: string, includeImage = false): string {
	const directory = fixtureSessionDirectory(root, cwd);
	const at = "2026-01-01T00:00:00.000Z";
	let parentId: string | null = null;
	const lines: string[] = [JSON.stringify({ type: "session", id, parentId: null, timestamp: at, version: 3, cwd })];
	const push = (entry: Record<string, unknown>): void => {
		const entryId = randomUUID();
		lines.push(JSON.stringify({ ...entry, id: entryId, parentId, timestamp: at }));
		parentId = entryId;
	};

	push({
		type: "message",
		message: {
			role: "user",
			content: includeImage
				? [
						{ type: "text", text: "Read note.txt" },
						{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
					]
				: "Read note.txt",
			timestamp: 0,
		},
	});
	push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I should read it." },
				{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "note.txt" } },
			],
			usage: { input: 10, output: 5, cacheRead: 0 },
			provider: "fixture",
			model: "test-model",
			timestamp: 0,
		},
	});
	push({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "ALPHA" }],
			timestamp: 0,
		},
	});
	push({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "It says ALPHA." }],
			provider: "fixture",
			model: "test-model",
			timestamp: 0,
		},
	});
	push({ type: "message", message: { role: "user", content: "Thanks", timestamp: 0 } });

	const file = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}
