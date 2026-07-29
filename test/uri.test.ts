/**
 * `file:` URI conversion.
 *
 * This exists because there used to be two conversions — a hand-rolled one in
 * the session channel and `node:url` everywhere else — which disagreed on UNC
 * URIs. The same input was accepted by `createSession` and refused by
 * `resourceRead`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileUriToPath, pathToFileUri } from "../src/core/uri.ts";

describe("file URI conversion", () => {
	it("decodes percent-escapes", () => {
		assert.equal(fileUriToPath("file:///tmp/a%20b"), "/tmp/a b");
	});

	it("round-trips a path", () => {
		assert.equal(fileUriToPath(pathToFileUri("/tmp/a b/c")), "/tmp/a b/c");
	});

	it("passes a bare path through", () => {
		// Clients occasionally send a path where the protocol asks for a URI.
		assert.equal(fileUriToPath("/tmp/plain"), "/tmp/plain");
	});

	it("refuses a URI naming a remote host", () => {
		// The old hand-rolled version silently turned this into `/share/x`.
		assert.throws(() => fileUriToPath("file://host/share/x"));
	});
});
