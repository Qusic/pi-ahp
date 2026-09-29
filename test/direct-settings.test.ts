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

	it("roots direct listener settings in PI_AHP_DIR", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-settings-profile-"));
		const oldPath = join(root, "legacy", "ahp", "settings.json");
		const overriddenPath = join(root, "override.json");
		const previous = {
			PI_AHP_DIR: process.env.PI_AHP_DIR,
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
			PI_AHP_SETTINGS: process.env.PI_AHP_SETTINGS,
		};
		try {
			mkdirSync(dirname(oldPath), { recursive: true });
			writeFileSync(oldPath, JSON.stringify({ port: 12345, token: "legacy-token" }));
			writeFileSync(overriddenPath, JSON.stringify({ port: 23456, token: "override-token" }));
			process.env.PI_AHP_DIR = join(root, "ahp");
			process.env.PI_CODING_AGENT_DIR = join(root, "agent");
			process.env.PI_CONFIG_DIR = join(root, "legacy");
			process.env.PI_AHP_SETTINGS = overriddenPath;

			const settings = await loadDirectListenerSettings();
			const chosenPath = join(root, "ahp", "settings.json");
			assert.deepEqual(JSON.parse(readFileSync(chosenPath, "utf8")), settings);
			assert.notEqual(settings.token, "legacy-token");
			assert.notEqual(settings.token, "override-token");
			assert.equal(JSON.parse(readFileSync(oldPath, "utf8")).token, "legacy-token");
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a relative PI_AHP_DIR before creating settings", async () => {
		const previous = process.env.PI_AHP_DIR;
		try {
			for (const value of ["", "relative/ahp", "~/.pi/ahp"]) {
				process.env.PI_AHP_DIR = value;
				await assert.rejects(loadDirectListenerSettings(), /PI_AHP_DIR must be an absolute path/u);
			}
		} finally {
			if (previous === undefined) delete process.env.PI_AHP_DIR;
			else process.env.PI_AHP_DIR = previous;
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
