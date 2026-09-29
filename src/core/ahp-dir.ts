/** One profile root for pi-ahp-owned settings and metadata. */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function getAhpDir(): string {
	const configured = process.env.PI_AHP_DIR;
	if (configured === undefined) return join(homedir(), ".pi", "ahp");
	if (!isAbsolute(configured)) throw new Error("PI_AHP_DIR must be an absolute path");
	return resolve(configured);
}
