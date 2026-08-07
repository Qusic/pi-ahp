/**
 * Validates every message the host puts on the wire against the published
 * JSON Schema.
 *
 * This is the one defence against a whole class of otherwise-silent bugs: the
 * protocol's reducers are total, so a structurally wrong action is not an
 * error — it is a no-op. Content simply never appears, with nothing logged.
 * Schema validation turns that into a loud test failure.
 *
 * The schemas are not published to npm, so they come from the `ahp` flake
 * input; see `test/support/upstream.ts` for how that is located.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { SCHEMA_DIR } from "./upstream.ts";

// ajv ships CJS; `createRequire` avoids the ESM default-interop dance.
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as new (options: object) => AjvInstance;

interface AjvValidate {
	(value: unknown): boolean;
	errors?: unknown;
}

interface AjvInstance {
	addSchema(schema: object): void;
	compile(schema: object): AjvValidate;
	errorsText(errors: unknown, options?: { separator?: string }): string;
}

export type SchemaName = "state" | "actions" | "commands" | "notifications" | "errors";

const SCHEMA_NAMES: readonly SchemaName[] = ["state", "actions", "commands", "notifications", "errors"];

/**
 * Strips `oneOf` / `anyOf` members that are dangling `$ref`s to an empty `$defs`
 * name.
 *
 * ---------------------------------------------------------------------------
 * UPSTREAM WORKAROUND — remove when fixed upstream.
 *
 * Bug: `scripts/generate-json-schema.ts:462` builds `StateAction` by calling
 * `splitUnionType()` *without* the `.filter(p => p !== 'undefined' && p !== '')`
 * that line 206 applies for the same hazard. The alias's printed text carries a
 * leading `|` (`types/common/actions.ts:245`), so the split yields an empty
 * first element and the schema gets `{"$ref": "#/$defs/"}`. Ajv then refuses to
 * compile anything transitively referencing `StateAction` — including
 * `ActionEnvelope`, i.e. every action we emit.
 *
 * Present in `spec/v0.6.0` and `main`. Upstream's own guard
 * (`generate-json-schema.test.ts:43`) misses it because `/^#\/\$defs\/(.+)$/`
 * requires at least one character.
 *
 * Removal is enforced, not remembered: `test/upstream-workarounds.test.ts`
 * fails once a re-sync brings in schemas that no longer need this.
 * ---------------------------------------------------------------------------
 *
 * A member that can never resolve can never match, so dropping it does not
 * change what validates. Returns the number of members removed.
 */
function stripDanglingRefs(node: unknown): number {
	if (Array.isArray(node)) {
		let removed = 0;
		for (const item of node) {
			removed += stripDanglingRefs(item);
		}
		return removed;
	}
	if (typeof node !== "object" || node === null) {
		return 0;
	}

	const record = node as Record<string, unknown>;
	let removed = 0;
	for (const key of ["oneOf", "anyOf", "allOf"]) {
		const members = record[key];
		if (!Array.isArray(members)) {
			continue;
		}
		const kept = members.filter((member) => {
			const ref = (member as { $ref?: unknown } | null)?.$ref;
			return !(typeof ref === "string" && /#\/\$defs\/$/.test(ref));
		});
		removed += members.length - kept.length;
		record[key] = kept;
	}
	for (const value of Object.values(record)) {
		removed += stripDanglingRefs(value);
	}
	return removed;
}

/** How many dangling refs the upstream schemas needed stripped. Exported for visibility. */
export let strippedDanglingRefs = 0;

/**
 * Bitset types the generator emitted as a closed `enum` of their declared
 * members.
 *
 * ---------------------------------------------------------------------------
 * UPSTREAM WORKAROUND — remove entries as they are fixed upstream.
 *
 * `SessionStatus` is documented as a bitset ("Use bitwise checks instead of
 * equality"), and the spec's own round-trip fixtures require combinations to
 * survive: `004-session-status-bitset-flags` round-trips
 * `InProgress(8)|IsArchived(64)` = 72, and
 * `005-session-status-unknown-bits-preserved` round-trips a value carrying an
 * unknown forward-compatibility bit (2147483720). The generated schema instead
 * says `enum: [1, 2, 8, 24, 32, 64]`, so **every combined status fails**,
 * including an ordinary idle-and-read session (`1 | 32` = 33).
 *
 * Dropping the `enum` keeps `type: number`, which is what a bitset actually is.
 *
 * Each of the five schema files carries its own copy of the definition, so the
 * fix is applied wherever the name appears rather than per file.
 * ---------------------------------------------------------------------------
 */
export const KNOWN_BITSET_ENUMS: readonly { def: string; evidence: string }[] = [
	{
		def: "SessionStatus",
		evidence: "round-trips/004-session-status-bitset-flags + 005-session-status-unknown-bits-preserved",
	},
];

/** Which bitset enums were actually relaxed. Empty means the workaround is obsolete. */
export const relaxedBitsetEnums: string[] = [];

function relaxKnownBitsetEnums(schemas: ReadonlyMap<SchemaName, Record<string, unknown>>): void {
	for (const { def } of KNOWN_BITSET_ENUMS) {
		for (const [name, schema] of schemas) {
			const target = (schema.$defs as Record<string, { enum?: unknown[] }> | undefined)?.[def];
			if (!target?.enum) {
				continue;
			}
			delete target.enum;
			relaxedBitsetEnums.push(`${name}#/$defs/${def}`);
		}
	}
}

function loadAjv(): { ajv: AjvInstance; schemaIds: Map<SchemaName, string> } {
	const ajv = new Ajv2020({
		// The generated schemas use annotations ajv does not know; they are not
		// constraints, so strict mode would reject them for no benefit.
		strict: false,
		allErrors: true,
		validateSchema: false,
	});
	const loaded = new Map<SchemaName, Record<string, unknown>>();
	const schemaIds = new Map<SchemaName, string>();
	for (const name of SCHEMA_NAMES) {
		const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), "utf8")) as Record<string, unknown>;
		strippedDanglingRefs += stripDanglingRefs(schema);
		loaded.set(name, schema);
		// Nothing is fetched — the files come from `$AHP_SPEC_PATH` — but ajv
		// keys them by `$id`, so that is what a `$ref` has to name. Taking it
		// from the file rather than restating the URL means a spec that moves
		// its `$id` fails here instead of silently validating against nothing.
		const id = schema.$id;
		if (typeof id !== "string") {
			throw new Error(`${name}.schema.json has no $id to reference it by`);
		}
		schemaIds.set(name, id);
	}
	relaxKnownBitsetEnums(loaded);
	// The five schemas cross-reference each other by `$id`, so register them all
	// before compiling anything.
	for (const schema of loaded.values()) {
		ajv.addSchema(schema);
	}
	return { ajv, schemaIds };
}

const { ajv, schemaIds } = loadAjv();
const validators = new Map<string, AjvValidate>();

/** Compiles (and caches) a validator for one named `$defs` entry. */
function validatorFor(schema: SchemaName, def: string): AjvValidate {
	const id = schemaIds.get(schema);
	if (id === undefined) {
		throw new Error(`no schema loaded for ${schema}`);
	}
	const ref = `${id}#/$defs/${def}`;
	let validate = validators.get(ref);
	if (validate === undefined) {
		validate = ajv.compile({ $ref: ref });
		validators.set(ref, validate);
	}
	return validate;
}

export interface ValidationFailure {
	readonly ref: string;
	readonly errors: string;
	readonly value: unknown;
}

/**
 * Returns a failure description, or `undefined` when the value conforms.
 *
 * Tests assert on `undefined` so a failure message carries the offending
 * payload rather than a bare boolean.
 */
export function checkSchema(schema: SchemaName, def: string, value: unknown): ValidationFailure | undefined {
	const validate = validatorFor(schema, def);
	if (validate(value)) {
		return undefined;
	}
	return {
		ref: `${schema}#/$defs/${def}`,
		errors: ajv.errorsText(validate.errors, { separator: "\n  " }),
		value,
	};
}

export function assertValid(schema: SchemaName, def: string, value: unknown): void {
	const failure = checkSchema(schema, def, value);
	if (failure) {
		throw new Error(
			`${failure.ref} validation failed:\n  ${failure.errors}\n\npayload: ${JSON.stringify(failure.value, null, 2)}`,
		);
	}
}
