/** Deterministic watch policy tests: no OS events, WebSockets, or clocks. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { ResourceChangeType as Change } from "@microsoft/agent-host-protocol";
import { isExcluded, matchesPatterns, mergeChange, relativeWatchPath } from "../src/pi/resource-watch-policy.ts";

describe("watch path scope and filters", () => {
	it("normalizes descendants and rejects siblings and prefix lookalikes", () => {
		const root = resolve("workspace");
		assert.equal(relativeWatchPath(root, root), "");
		assert.equal(relativeWatchPath(root, resolve(root, "nested/../file.txt")), "file.txt");
		assert.equal(relativeWatchPath(root, resolve(root, "nested/file.txt")), "nested/file.txt");
		for (const path of [resolve(root, ".."), resolve(root, "../sibling/file.txt"), `${root}-other/file.txt`]) {
			assert.equal(relativeWatchPath(root, path), undefined, path);
		}
	});

	it("keeps the watched root visible regardless of filters", () => {
		assert.equal(isExcluded("", ["**"]), false);
		assert.equal(matchesPatterns("", ["*.md"], ["**"]), true);
	});

	it("applies include alternatives and exclude precedence to every path", () => {
		const cases: Array<[string, readonly string[], readonly string[], boolean]> = [
			["file.txt", [], [], true],
			["nested/file.md", ["**/*.md"], [], true],
			["nested/file.txt", ["**/*.md"], [], false],
			["file.ts", ["**/*.md", "**/*.ts"], [], true],
			["nested/file.md", ["**/*.md"], ["nested/**"], false],
			["node_modules/pkg/index.js", [], ["**/node_modules/**"], false],
			["nested/node_modules/pkg/index.js", [], ["**/node_modules/**"], false],
			["node_modules", [], ["**/node_modules/**"], true],
			[".git/config", [], ["**/.git/**"], false],
			["src/.hidden.ts", ["**/*.ts"], [], false],
			["src/.hidden.ts", ["**/.*.ts"], [], true],
		];
		for (const [path, includes, excludes, expected] of cases) {
			assert.equal(matchesPatterns(path, includes, excludes), expected, JSON.stringify({ path, includes, excludes }));
		}
	});

	it("does not prune a directory just because its children alone match the include filter", () => {
		assert.equal(matchesPatterns("src", ["**/*.ts"], []), false);
		assert.equal(isExcluded("src", []), false);
		assert.equal(matchesPatterns("src/file.ts", ["**/*.ts"], []), true);
		assert.equal(isExcluded("src/generated", ["**/generated"]), true);
	});
});

describe("watch batch transitions", () => {
	const next = [Change.Added, Change.Updated, Change.Deleted];
	const rows: Array<[Change | undefined, Array<Change | undefined>]> = [
		[undefined, [Change.Added, Change.Updated, Change.Deleted]],
		[Change.Added, [Change.Added, Change.Added, undefined]],
		[Change.Updated, [Change.Updated, Change.Updated, Change.Deleted]],
		[Change.Deleted, [Change.Updated, Change.Updated, Change.Deleted]],
	];
	for (const [previous, expected] of rows) {
		it(`coalesces ${previous ?? "empty"} followed by each native event type`, () => {
			for (const [index, change] of next.entries())
				assert.equal(mergeChange(previous, change), expected[index], change);
		});
	}

	it("handles replacement and transient paths across longer sequences", () => {
		const cases: Array<[Change[], Change | undefined]> = [
			[[Change.Added, Change.Updated, Change.Deleted], undefined],
			[[Change.Added, Change.Deleted, Change.Added], Change.Added],
			[[Change.Deleted, Change.Added, Change.Deleted], Change.Deleted],
			[[Change.Deleted, Change.Added, Change.Deleted, Change.Added], Change.Updated],
			[[Change.Updated, Change.Deleted, Change.Added], Change.Updated],
		];
		for (const [sequence, expected] of cases) {
			assert.equal(sequence.reduce<Change | undefined>(mergeChange, undefined), expected, sequence.join(" → "));
		}
	});
});
