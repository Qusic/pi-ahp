/** Atomic, profile-scoped metadata files with declared namespaces and Zod schemas. */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

interface StoredValue {
	readonly namespace: string;
	readonly id: string;
	readonly key: string;
	readonly value: unknown;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function validateName(name: string): void {
	if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new Error(`Invalid metadata namespace or key: ${name}`);
}

/** One typed namespace; schemas should accept their JSON representation unchanged. */
class MetadataNamespace<Keys extends Record<string, z.ZodType>> {
	readonly #root: string;
	readonly #name: string;
	readonly #keys: Keys;

	constructor(root: string, name: string, keys: Keys) {
		validateName(name);
		for (const key of Object.keys(keys)) validateName(key);
		this.#root = resolve(root);
		this.#name = name;
		this.#keys = keys;
	}

	get<Key extends keyof Keys & string>(id: string, key: Key): z.output<Keys[Key]> | undefined;
	get<Key extends keyof Keys & string>(id: string, key: Key, fallback: z.output<Keys[Key]>): z.output<Keys[Key]>;
	get<Key extends keyof Keys & string>(
		id: string,
		key: Key,
		fallback?: z.output<Keys[Key]>,
	): z.output<Keys[Key]> | undefined {
		const schema = this.#schema(key);
		const path = this.#path(id, key);
		let contents: string;
		try {
			contents = fs.readFileSync(path, "utf8");
		} catch (error) {
			if (isMissing(error)) return fallback;
			throw error;
		}
		let record: unknown;
		try {
			record = JSON.parse(contents);
		} catch {
			return fallback;
		}
		if (typeof record !== "object" || record === null) return fallback;
		const stored = record as Partial<StoredValue>;
		if (stored.namespace !== this.#name || stored.id !== id || stored.key !== key || !Object.hasOwn(stored, "value")) {
			return fallback;
		}
		const parsed = schema.safeParse(stored.value);
		return parsed.success ? (parsed.data as z.output<Keys[Key]>) : fallback;
	}

	set<Key extends keyof Keys & string>(id: string, key: Key, value: z.input<Keys[Key]>): void {
		const schema = this.#schema(key);
		const path = this.#path(id, key);
		const parsed = schema.safeParse(value);
		if (!parsed.success) throw new Error(`Invalid metadata value for ${this.#name}/${key}`, { cause: parsed.error });
		const record: StoredValue = { namespace: this.#name, id, key, value: parsed.data };
		const serialized = JSON.stringify(record);
		fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(temporary, `${serialized}\n`, { flag: "wx", mode: 0o600 });
			fs.renameSync(temporary, path);
		} catch (error) {
			try {
				fs.unlinkSync(temporary);
			} catch {
				// A failed write or rename may leave no temporary file to remove.
			}
			throw error;
		}
	}

	delete<Key extends keyof Keys & string>(id: string, key: Key): void {
		this.#schema(key);
		try {
			fs.unlinkSync(this.#path(id, key));
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}

	/** Call after the owning session/client has been durably removed. */
	deleteId(id: string): void {
		fs.rmSync(this.#directory(id), { recursive: true, force: true });
	}

	#schema<Key extends keyof Keys & string>(key: Key): Keys[Key] {
		if (!Object.hasOwn(this.#keys, key)) throw new Error(`Unknown metadata key: ${this.#name}/${key}`);
		return this.#keys[key];
	}

	#directory(id: string): string {
		if (!id) throw new Error("Metadata needs an ID");
		// Session and client IDs are caller-chosen, never trusted as path segments.
		const hash = createHash("sha256").update(id).digest("hex");
		return join(this.#root, this.#name, hash);
	}

	#path(id: string, key: keyof Keys & string): string {
		return join(this.#directory(id), `${key}.json`);
	}
}

/** Host-owned metadata. The supplied AHP directory stays isolated from Pi's JSONL sessions. */
export class MetadataStore {
	readonly sessions;

	constructor(ahpDir: string) {
		if (!ahpDir) throw new Error("Metadata needs an explicit AHP directory");
		const root = join(ahpDir, "metadata");
		// Storage shapes only; absence and defaults belong to the session service.
		this.sessions = new MetadataNamespace(root, "session", { archive: z.boolean() });
	}
}
