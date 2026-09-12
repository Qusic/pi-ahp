import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { deleteSessionFile } from "../src/pi/delete-session.ts";

function withPath(path: string, run: () => void): void {
	const previous = process.env.PATH;
	process.env.PATH = path;
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	}
}

function fakeTrash(
	root: string,
	behavior: "remove" | "fail" | "remove-and-fail" | "leave",
): {
	bin: string;
	calls: string;
} {
	const bin = join(root, "bin");
	const calls = join(root, "trash-calls.json");
	mkdirSync(bin);
	const executable = join(bin, "trash");
	writeFileSync(
		executable,
		[
			`#!${process.execPath}`,
			'const fs = require("node:fs");',
			"const args = process.argv.slice(2);",
			`fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(args));`,
			"const target = args.at(-1);",
			...(["remove", "remove-and-fail"].includes(behavior) ? ["fs.rmSync(target, { force: true });"] : []),
			...(behavior === "fail" ? ["process.exit(1);"] : []),
			...(behavior === "remove-and-fail" ? ["process.exit(1);"] : []),
		].join("\n"),
	);
	chmodSync(executable, 0o755);
	return { bin, calls };
}

describe("session file deletion", () => {
	it("treats an already-missing file as success", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-delete-missing-"));
		try {
			assert.deepEqual(deleteSessionFile(join(root, "session.jsonl")), {
				ok: true,
				method: "missing",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers trash and guards a path that looks like an option", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-delete-trash-"));
		const previousCwd = process.cwd();
		try {
			const fake = fakeTrash(root, "remove");
			process.chdir(root);
			writeFileSync("-session.jsonl", "session\n");
			withPath(`${fake.bin}${delimiter}${process.env.PATH ?? ""}`, () => {
				assert.deepEqual(deleteSessionFile("-session.jsonl"), { ok: true, method: "trash" });
			});
			assert.equal(existsSync("-session.jsonl"), false);
			assert.deepEqual(JSON.parse(readFileSync(fake.calls, "utf8")), ["--", "-session.jsonl"]);
		} finally {
			process.chdir(previousCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to unlink when trash exits successfully but leaves the file", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-delete-left-behind-"));
		try {
			const fake = fakeTrash(root, "leave");
			const target = join(root, "session.jsonl");
			writeFileSync(target, "session\n");
			withPath(`${fake.bin}${delimiter}${process.env.PATH ?? ""}`, () => {
				assert.deepEqual(deleteSessionFile(target), { ok: true, method: "unlink" });
			});
			assert.equal(existsSync(target), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("recognizes trash success even when the command exits nonzero", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-delete-moved-"));
		try {
			const fake = fakeTrash(root, "remove-and-fail");
			const target = join(root, "session.jsonl");
			writeFileSync(target, "session\n");
			withPath(`${fake.bin}${delimiter}${process.env.PATH ?? ""}`, () => {
				assert.deepEqual(deleteSessionFile(target), { ok: true, method: "trash" });
			});
			assert.equal(existsSync(target), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to unlink when trash is unavailable or fails", () => {
		for (const behavior of ["missing", "fail"] as const) {
			const root = mkdtempSync(join(tmpdir(), `pi-ahp-delete-${behavior}-`));
			try {
				const bin = behavior === "fail" ? fakeTrash(root, "fail").bin : join(root, "empty-bin");
				if (behavior === "missing") mkdirSync(bin);
				const target = join(root, "session.jsonl");
				writeFileSync(target, "session\n");
				withPath(bin, () => {
					assert.deepEqual(deleteSessionFile(target), { ok: true, method: "unlink" });
				});
				assert.equal(existsSync(target), false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("returns an unlink error instead of claiming deletion", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-delete-error-"));
		const target = join(root, "directory.jsonl");
		mkdirSync(target);
		try {
			withPath(root, () => {
				const result = deleteSessionFile(target);
				assert.equal(result.ok, false);
				assert.equal(result.method, "unlink");
				assert.match(result.error ?? "", /directory|operation not permitted|permission denied/is);
				assert.equal(existsSync(target), true);
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
