import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { loadDirectListenerSettings, SettingsError } from "../src/host/direct-settings.ts";

function fixture(): { path: string; write(value: unknown): void; close(): void } {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-settings-"));
	const path = join(root, "nested", "settings.json");
	return {
		path,
		write(value) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
		},
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

describe("direct listener settings", () => {
	it("creates a private, reusable endpoint configuration on first use", async () => {
		const f = fixture();
		try {
			const settings = await loadDirectListenerSettings(f.path);
			assert.equal(settings.host, "127.0.0.1");
			assert.equal(Number.isInteger(settings.port) && settings.port >= 1 && settings.port <= 65_535, true);
			assert.match(settings.token ?? "", /^[A-Za-z0-9_-]{43}$/u);
			assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), settings);
			assert.equal(statSync(f.path).mode & 0o777, 0o600);
			assert.deepEqual(await loadDirectListenerSettings(f.path), settings);
		} finally {
			f.close();
		}
	});

	it("takes an existing file literally and defaults only optional fields", async () => {
		const f = fixture();
		try {
			f.write({ port: 12345 });
			assert.deepEqual(await loadDirectListenerSettings(f.path), {
				port: 12345,
				token: null,
				host: "127.0.0.1",
			});

			f.write({ port: 23456, token: null, host: "0.0.0.0" });
			assert.deepEqual(await loadDirectListenerSettings(f.path), {
				port: 23456,
				token: null,
				host: "0.0.0.0",
			});
		} finally {
			f.close();
		}
	});

	it("rejects malformed or incomplete files instead of inventing replacements", async () => {
		const f = fixture();
		try {
			const cases: Array<[unknown, RegExp]> = [
				["not json", /not valid JSON/],
				[{}, /no `port`/],
				[{ port: 0 }, /integer 1-65535/],
				[{ port: 65_536 }, /integer 1-65535/],
				[{ port: 1.5 }, /integer 1-65535/],
				[{ port: 12345, token: 42 }, /string or null/],
				[{ port: 12345, host: 42 }, /host.*string/],
			];
			for (const [value, message] of cases) {
				f.write(value);
				await assert.rejects(
					loadDirectListenerSettings(f.path),
					(error: unknown) => error instanceof SettingsError && message.test(error.message),
				);
			}
		} finally {
			f.close();
		}
	});
});
