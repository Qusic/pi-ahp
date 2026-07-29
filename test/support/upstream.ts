/**
 * Locates the upstream protocol repo.
 *
 * The JSON schemas and reducer fixtures the suite validates against are not
 * published to npm, so they have to come from the spec repo itself. They used
 * to be copied into `vendor/`; the flake input supplies them instead, which is
 * why neither the copy nor a hand-written commit note lives in this repo.
 *
 * `$AHP_SPEC_PATH` is the only way in. There is no in-tree fallback copy: the
 * checkout can only be produced by nix in the first place, so a second
 * resolution path would just be a way to test against a stale one.
 *
 * Absent is a hard error rather than a skip. Schema validation is the only
 * thing standing between us and a whole class of silent bugs — the protocol's
 * reducers are total, so a structurally wrong action is a no-op, not an error —
 * and a suite that quietly stops checking is worse than one that refuses to run.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

function resolveSpec(): string {
	const path = process.env.AHP_SPEC_PATH;
	if (path && existsSync(path)) {
		return path;
	}
	throw new Error(
		[
			`AHP_SPEC_PATH is ${path ? `set to a missing path: ${path}` : "not set"}.`,
			"",
			"The JSON schemas and reducer fixtures are not published to npm and are not",
			"vendored; they come from the `ahp` flake input.",
			"",
			"    nix develop -c npm test",
			"    nix develop            # then npm test, npm run check, ...",
		].join("\n"),
	);
}

const SPEC = resolveSpec();

/** The five generated JSON Schema files. */
export const SCHEMA_DIR = join(SPEC, "schema");

/** The reducer conformance corpus. */
export const REDUCER_CASE_DIR = join(SPEC, "types", "test-cases", "reducers");
