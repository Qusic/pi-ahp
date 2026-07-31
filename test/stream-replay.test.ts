/**
 * Checks that a fixture's two recorded layers still agree.
 *
 * `turns` is what the provider fed pi; `events` is what pi emitted in response.
 * Both were recorded from the same live capture, so replaying the first has to
 * reproduce the second. What this pins down is pi itself: `fixture-replay`
 * drives the mapper from the stored `events`, which stay valid even if a pi
 * upgrade changes how those events are derived. Here the real `AgentSession`
 * runs, so such a change fails instead of passing quietly.
 *
 * Compared on the collapsed event *skeleton*, not the payloads: chunk counts
 * depend on how the provider split its deltas, and the recording keeps one
 * arbitrary split.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { eventSkeleton, type RecordedFixture, replayTurns } from "./support/replay.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * Workspace contents the scenarios read back.
 *
 * Replay re-runs tools for real, so a fixture that read a file needs that file.
 * Kept deliberately small: a tool whose output does not match what the recorded
 * assistant saw is fine, because only the event skeleton is compared.
 */
const WORKSPACE_FILES: Readonly<Record<string, string>> = {
	"note.txt": "ALPHA\n",
	"a.txt": "one\ntwo\nthree\n",
	// `tool-edit` replaces a line in this one. An edit against a file that is
	// missing, or whose text does not contain the recorded `oldText`, fails
	// where the capture succeeded and the turn takes a different shape.
	"greet.ts": "export function greet(name: string) {\n\treturn `Hi ${name}`;\n}\n",
};

/**
 * Scenarios whose capture involved more than the opening prompt.
 *
 * `steering` injects a second message mid-turn and `compaction` runs extra
 * prompts plus an explicit `compact()` afterwards, so their recordings hold
 * turns that replaying the prompt alone never asks for. Reproducing them would
 * mean re-encoding each scenario's choreography here, which is what the capture
 * script already owns; their event streams stay covered by `fixture-replay`.
 */
const NEEDS_SCENARIO_CHOREOGRAPHY = new Set(["steering", "compaction"]);

const fixtures = readdirSync(FIXTURE_DIR)
	.filter((file) => file.endsWith(".json"))
	.map((file) => JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as RecordedFixture);

describe("recorded provider streams reproduce the recorded pi events", () => {
	for (const fixture of fixtures) {
		it(fixture.name, { skip: NEEDS_SCENARIO_CHOREOGRAPHY.has(fixture.name) }, async () => {
			assert.ok(fixture.turns.length > 0, `${fixture.name}: no recorded provider turns`);
			const replayed = await replayTurns(fixture, { files: WORKSPACE_FILES });
			assert.deepEqual(
				eventSkeleton(replayed),
				eventSkeleton(fixture.events),
				`${fixture.name}: replaying the recorded provider stream no longer produces the recorded events`,
			);
		});
	}
});
