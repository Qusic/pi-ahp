/**
 * URI helpers shared across channels and backends.
 *
 * The protocol carries filesystem locations as `file:` URIs. Converting them
 * lives here rather than in whichever module happened to need it first, because
 * having two conversions is how they drift: a hand-rolled
 * `decodeURIComponent(new URL(uri).pathname)` silently turns the UNC URI
 * `file://host/share/x` into the local path `/share/x`, while `node:url`
 * rejects it — so the same input was accepted in one command and refused in
 * another.
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
