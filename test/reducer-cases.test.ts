/**
 * Runs the protocol's own reducer conformance cases against the version of
 * `@microsoft/agent-host-protocol` we depend on.
 *
 * This deliberately tests a dependency, which normally would be a smell. The
 * reason it earns its place: our event mapper is written against *exact*
 * reducer semantics — `chat/delta` appends rather than replaces, an action
 * naming an unknown `partId` is a silent no-op, `root/configChanged` does
 * nothing until a config schema exists, and so on. If a version bump changes
 * any of that, the mapper breaks in ways that are invisible at runtime (state
 * simply stops updating). This suite turns that into a failing test at upgrade
 * time.
 *
 * The cases are excluded from the npm package, so they come from the `ahp`
 * flake input; see `test/support/upstream.ts` for how that is located.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	annotationsReducer,
	automationReducer,
	automationRunReducer,
	changesetReducer,
	chatReducer,
	resourceWatchReducer,
	rootReducer,
	sessionReducer,
	terminalReducer,
} from "@microsoft/agent-host-protocol";
import { REDUCER_CASE_DIR } from "./support/upstream.ts";

type AnyReducer = (state: never, action: never) => unknown;

const REDUCERS: Record<string, AnyReducer> = {
	root: rootReducer as AnyReducer,
	session: sessionReducer as AnyReducer,
	chat: chatReducer as AnyReducer,
	terminal: terminalReducer as AnyReducer,
	changeset: changesetReducer as AnyReducer,
	annotations: annotationsReducer as AnyReducer,
	resourceWatch: resourceWatchReducer as AnyReducer,
	automation: automationReducer as AnyReducer,
	automationRun: automationRunReducer as AnyReducer,
};

interface ReducerCase {
	readonly description: string;
	readonly reducer: string;
	readonly initial: unknown;
	readonly actions: unknown[];
	readonly expected: unknown;
}

/**
 * JSON has no `undefined`, so the fixtures encode an absent optional field as
 * `null` while the reducers produce `undefined`. Upstream's own runner
 * (`types/reducers.test.ts`) normalises the same way.
 */
function nullToUndefined<T>(value: T): T {
	if (value === null) {
		return undefined as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map(nullToUndefined) as unknown as T;
	}
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			result[key] = nullToUndefined(inner);
		}
		return result as T;
	}
	return value;
}

describe("protocol reducer conformance", () => {
	const files = readdirSync(REDUCER_CASE_DIR)
		.filter((name) => name.endsWith(".json"))
		.sort();

	it("has the upstream corpus available", () => {
		assert.ok(files.length > 200, `expected the full corpus, found ${files.length} cases`);
	});

	for (const file of files) {
		const testCase = nullToUndefined(JSON.parse(readFileSync(join(REDUCER_CASE_DIR, file), "utf8")) as ReducerCase);

		it(`${file.replace(/\.json$/, "")} — ${testCase.description}`, () => {
			const reduce = REDUCERS[testCase.reducer];
			assert.ok(reduce, `unknown reducer in fixture: ${testCase.reducer}`);

			let state = testCase.initial;
			for (const action of testCase.actions) {
				state = reduce(state as never, action as never);
			}

			assert.deepStrictEqual(state, testCase.expected);
		});
	}
});
