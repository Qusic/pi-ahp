/** The public store owns its archive schema and file-KV behavior. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { MetadataStore } from "../src/pi/metadata-store.ts";

function fixture(t: { after(cleanup: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-metadata-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ahpDir = join(root, "ahp");
	const store = new MetadataStore(ahpDir);
	return { root, ahpDir, directory: join(ahpDir, "metadata"), sessions: store.sessions };
}

it("persists archive and read per session and cleans only the requested ID", (t) => {
	const { root, ahpDir, sessions } = fixture(t);
	assert.equal(sessions.get("same", "archive"), false);
	assert.equal(sessions.get("same", "read"), false);
	assert.deepEqual(readdirSync(root), [], "reads must not create directories");

	sessions.set("same", "archive", true);
	sessions.set("same", "read", true);
	sessions.set("other", "archive", true);
	const reopened = new MetadataStore(ahpDir);
	assert.equal(reopened.sessions.get("same", "archive"), true);
	assert.equal(reopened.sessions.get("same", "read"), true);
	assert.equal(reopened.sessions.get("other", "archive"), true);

	sessions.delete("same", "archive");
	assert.equal(reopened.sessions.get("same", "archive"), false);
	assert.equal(reopened.sessions.get("same", "read"), true);
	sessions.set("same", "archive", true);
	sessions.deleteId("same");
	sessions.deleteId("same");
	assert.equal(reopened.sessions.get("same", "archive"), false);
	assert.equal(reopened.sessions.get("same", "read"), false);
	assert.equal(reopened.sessions.get("other", "archive"), true);
});

it("hashes session IDs, validates record identity and protects private files", (t) => {
	const { root, directory, sessions } = fixture(t);
	const id = "../__proto__\\escape/%2F";
	sessions.set(id, "archive", true);
	assert.deepEqual(readdirSync(root), ["ahp"]);
	assert.deepEqual(readdirSync(directory), ["session"]);
	const hash = createHash("sha256").update(id).digest("hex");
	assert.deepEqual(readdirSync(join(directory, "session")), [hash]);
	const sessionIdDir = join(directory, "session", hash);
	assert.deepEqual(readdirSync(sessionIdDir), ["archive.json"]);
	assert.deepEqual(JSON.parse(readFileSync(join(sessionIdDir, "archive.json"), "utf8")), {
		namespace: "session",
		id,
		key: "archive",
		value: true,
	});
	if (process.platform !== "win32") {
		assert.equal(statSync(sessionIdDir).mode & 0o077, 0, "session directory is private");
		assert.equal(statSync(join(sessionIdDir, "archive.json")).mode & 0o077, 0, "archive file is private");
	}
});

it("rejects invalid new values and empty IDs without writing", (t) => {
	const { root, sessions } = fixture(t);
	assert.throws(() => sessions.set("one", "archive", "yes" as never), /Invalid metadata value/u);
	assert.throws(() => sessions.get("", "archive"), /Metadata needs an ID/u);
	assert.deepEqual(readdirSync(root), []);
});

it("uses the declared default for missing, malformed or invalid stored values", (t) => {
	const { directory, sessions } = fixture(t);
	sessions.set("one", "archive", true);
	const sessionDir = join(directory, "session", createHash("sha256").update("one").digest("hex"));
	const file = join(sessionDir, "archive.json");
	writeFileSync(
		file,
		JSON.stringify({ namespace: "session", id: "one", key: "archive", value: true, extra: "ignored" }),
	);
	assert.equal(sessions.get("one", "archive"), true);
	for (const contents of [
		"{broken",
		JSON.stringify({ namespace: "session", id: "one", key: "archive" }),
		JSON.stringify({ namespace: "client", id: "one", key: "archive", value: true }),
		JSON.stringify({ namespace: "session", id: "wrong", key: "archive", value: true }),
		JSON.stringify({ namespace: "session", id: "one", key: "other", value: true }),
		JSON.stringify({ namespace: "session", id: "one", key: "archive", value: "yes" }),
	]) {
		writeFileSync(file, contents);
		assert.equal(sessions.get("one", "archive"), false);
		// A new valid write replaces malformed low-value metadata.
		sessions.set("one", "archive", true);
		assert.equal(sessions.get("one", "archive"), true);
	}
	writeFileSync(file, "{broken");
	sessions.delete("one", "archive");
	assert.equal(sessions.get("one", "archive"), false);
});

it("keeps I/O failures visible and never claims a failed write succeeded", (t) => {
	const { directory, sessions } = fixture(t);
	sessions.set("kept", "archive", true);
	const readError = Object.assign(new Error("read unavailable"), { code: "EACCES" });
	const read = t.mock.method(fs, "readFileSync", () => {
		throw readError;
	});
	try {
		assert.throws(() => sessions.get("kept", "archive"), { code: "EACCES", message: "read unavailable" });
	} finally {
		read.mock.restore();
	}

	const rename = t.mock.method(fs, "renameSync", () => {
		throw new Error("rename unavailable");
	});
	try {
		assert.throws(() => sessions.set("kept", "archive", false), /rename unavailable/u);
		assert.equal(sessions.get("kept", "archive"), true, "failed overwrite preserves the old value");
		const keptDir = join(directory, "session", createHash("sha256").update("kept").digest("hex"));
		assert.deepEqual(readdirSync(keptDir), ["archive.json"], "failed writes must remove their temporary file");
	} finally {
		rename.mock.restore();
	}

	const unlink = t.mock.method(fs, "unlinkSync", () => {
		throw new Error("unlink unavailable");
	});
	try {
		assert.throws(() => sessions.delete("kept", "archive"), /unlink unavailable/u);
		assert.equal(sessions.get("kept", "archive"), true);
	} finally {
		unlink.mock.restore();
	}
});
