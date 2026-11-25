/**
 * Self-expiring guard for the upstream workaround in `test/support/schema.ts`.
 * It fails when the AHP schemas no longer need the repair.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closedEmptyStates } from "./support/schema.ts";

describe("upstream workarounds", () => {
	it("still needs EmptyState closed", () => {
		assert.ok(
			closedEmptyStates.length > 0,
			[
				"No upstream schema lets EmptyState match a non-empty object any more.",
				"ACTION: delete `closeEmptyState` (and this test) from test/support/schema.ts.",
			].join("\n"),
		);
	});
});
