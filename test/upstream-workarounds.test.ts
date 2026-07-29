/**
 * Self-expiring guards for the upstream workarounds in `test/support/schema.ts`.
 *
 * A comment saying "remove this when upstream fixes it" is never read again.
 * These tests fail the moment a `nix flake update ahp` pulls in schemas that no
 * longer need the workaround, so the cleanup is forced rather than remembered.
 * Each failure message says exactly what to delete.
 *
 * The pinned commit lives in `flake.lock`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	KNOWN_BITSET_ENUMS,
	KNOWN_REQUIRED_DEVIATIONS,
	relaxedBitsetEnums,
	relaxedRequiredFields,
	strippedDanglingRefs,
} from "./support/schema.ts";

describe("upstream workarounds", () => {
	it("still needs the dangling-$ref strip", () => {
		assert.ok(
			strippedDanglingRefs > 0,
			[
				"The upstream schemas no longer contain a dangling `$ref` to an empty `$defs` name.",
				"Upstream appears to have fixed generate-json-schema.ts.",
				"ACTION: delete `stripDanglingRefs` (and this test) from test/support/schema.ts,",
				"and drop the matching note from the research log.",
			].join("\n"),
		);
	});

	it("still needs every KNOWN_REQUIRED_DEVIATIONS entry", () => {
		const unused = KNOWN_REQUIRED_DEVIATIONS.filter(
			({ schema, def, field }) => !relaxedRequiredFields.includes(`${schema}#/$defs/${def}.${field}`),
		);

		assert.deepEqual(
			unused.map(({ schema, def, field }) => `${schema}#/$defs/${def}.${field}`),
			[],
			[
				"These schema `required` deviations no longer apply — upstream fixed them:",
				...unused.map(
					({ schema, def, field, evidence }) => `  ${schema}#/$defs/${def}.${field} (evidence: ${evidence})`,
				),
				"ACTION: remove the listed entries from KNOWN_REQUIRED_DEVIATIONS in test/support/schema.ts,",
				"and update the research log.",
			].join("\n"),
		);
	});
});

describe("upstream workarounds — bitsets", () => {
	it("still needs every KNOWN_BITSET_ENUMS entry", () => {
		const unused = KNOWN_BITSET_ENUMS.filter(
			({ def }) => !relaxedBitsetEnums.some((entry) => entry.endsWith(`#/$defs/${def}`)),
		);

		assert.deepEqual(
			unused.map(({ def }) => def),
			[],
			[
				"These bitset types are no longer emitted as closed enums — upstream fixed them:",
				...unused.map(({ def, evidence }) => `  ${def} (evidence: ${evidence})`),
				"ACTION: remove the listed entries from KNOWN_BITSET_ENUMS in test/support/schema.ts,",
				"and update the research log.",
			].join("\n"),
		);
	});
});
