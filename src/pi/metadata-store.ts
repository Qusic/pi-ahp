import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LowSync, MemorySync } from "lowdb";
import { JSONFileSync } from "lowdb/node";

interface Metadata {
	sessions: Record<string, Record<string, unknown>>;
	clients: Record<string, Record<string, unknown>>;
}

/** Host-owned metadata, separate from Pi's append-only conversation files.
 * One host per profile is assumed; lowdb's atomic replace is not a cross-process lock.
 */
export class MetadataStore {
	readonly #db: LowSync<Metadata>;

	constructor(path?: string) {
		if (path) mkdirSync(dirname(path), { recursive: true });
		this.#db = new LowSync(path ? new JSONFileSync<Metadata>(path) : new MemorySync<Metadata>(), {
			sessions: {},
			clients: {},
		});
		this.#db.read();
		if (!this.#db.data?.sessions || Array.isArray(this.#db.data.sessions) || typeof this.#db.data.sessions !== "object")
			throw new Error("Invalid session metadata");
		if (!this.#db.data.clients || Array.isArray(this.#db.data.clients) || typeof this.#db.data.clients !== "object")
			throw new Error("Invalid client metadata");
	}

	getSessionArchived(id: string): boolean {
		return this.#db.data.sessions[id]?.isArchived === true;
	}

	setSessionArchived(id: string, archived: boolean): void {
		const sessions = this.#db.data.sessions;
		const previous = structuredClone(sessions);
		try {
			if (archived) sessions[id] = { ...sessions[id], isArchived: true };
			else {
				const { isArchived: _discard, ...rest } = sessions[id] ?? {};
				if (Object.keys(rest).length) sessions[id] = rest;
				else delete sessions[id];
			}
			this.#db.write();
		} catch (error) {
			this.#db.data.sessions = previous;
			throw error;
		}
	}

	deleteSession(id: string): void {
		const previous = structuredClone(this.#db.data.sessions);
		try {
			delete this.#db.data.sessions[id];
			this.#db.write();
		} catch (error) {
			this.#db.data.sessions = previous;
			throw error;
		}
	}
}
