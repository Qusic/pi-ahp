/**
 * URI helpers shared across channels and backends. Filesystem conversion uses
 * `node:url` consistently so platform and remote-authority semantics cannot
 * diverge between commands.
 */

import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Converts a `file:` URI to a filesystem path.
 *
 * A value that is not a `file:` URI is returned unchanged: clients occasionally
 * send a bare path where the protocol asks for a URI, and treating that as a
 * path is friendlier than failing.
 *
 * @throws {TypeError} when the URI is malformed or names a remote host.
 */
export function fileUriToPath(uri: string): string {
	return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
}

/** Converts a filesystem path to a `file:` URI. */
export function pathToFileUri(path: string): string {
	return pathToFileURL(path).toString();
}
