/** Locates the generated AHP JSON schemas supplied by the Nix environment. */

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
			"The schemas are not included in the npm package. Run tests through Nix:",
			"",
			"    nix develop -c pnpm test",
		].join("\n"),
	);
}

const SPEC = resolveSpec();

/** The five generated JSON Schema files. */
export const SCHEMA_DIR = join(SPEC, "schema");
