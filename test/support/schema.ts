/**
 * Validates every message the host puts on the wire against the published
 * JSON Schema.
 *
 * The protocol's reducers are total, so a structurally wrong action may become
 * a silent no-op. Schema validation turns that into an explicit test failure.
 *
 * The schemas are not included in the npm package, so Nix supplies the matching
 * spec checkout through `AHP_SPEC_PATH`; see `test/support/upstream.ts`.
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
 * Closes `EmptyState`, which the schemas publish open, so it matches any object.
 *
 * ---------------------------------------------------------------------------
 * UPSTREAM WORKAROUND — remove when fixed upstream.
 *
 * `Snapshot.state` is a `oneOf` over every channel's state and `EmptyState`,
 * which the spec calls "always the empty object `{}`" but defines as
 * `{ "type": "object", "properties": {} }`. Every other state then matches two
 * members, so every snapshot fails. Closing it makes it what the spec says.
 *
 * Each schema file carries its own copy, so every copy that still accepts a
 * non-empty object is closed. Removal is enforced, not remembered:
 * `test/upstream-workarounds.test.ts` fails once no copy needs it.
 * ---------------------------------------------------------------------------
 */
function closeEmptyState(ajv: AjvInstance, schemas: ReadonlyMap<SchemaName, Record<string, unknown>>): void {
	for (const [name, schema] of schemas) {
		const def = (schema.$defs as Record<string, Record<string, unknown>> | undefined)?.EmptyState;
		if (def && ajv.compile(def)({ unexpected: true })) {
			def.additionalProperties = false;
			closedEmptyStates.push(name);
		}
	}
}

/** Which schema files had `EmptyState` closed. Empty means the workaround is obsolete. */
export const closedEmptyStates: SchemaName[] = [];

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
	closeEmptyState(ajv, loaded);
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

export function assertValid(schema: SchemaName, def: string, value: unknown, context?: string): void {
	const failure = checkSchema(schema, def, value);
	if (failure) {
		throw new Error(
			`${context ? `${context}: ` : ""}${failure.ref} validation failed:\n  ${failure.errors}\n\npayload: ${JSON.stringify(failure.value, null, 2)}`,
		);
	}
}
