/**
 * Drives pi with authored provider streams, for outcomes a capture cannot get.
 *
 * A live provider will not produce a content filter, a reply cut at the token
 * ceiling, or a transient server error on request, so these turns are written
 * by hand. Only the response is authored: pi runs for real, and what is checked
 * is the events it emits and the outcome it records.
 *
 * The mapper's own handling of those events is covered by the reducer tests;
 * what would go unnoticed without this file is pi reporting an outcome we never
 * see in a recording.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";
import { type AuthoredTurn, authorTurns } from "./support/authored-stream.ts";

const SETTLE_TIMEOUT_MS = 5_000;

/** See `replay.ts`: pi resolves auth before the authored stream is reachable. */
function useStubAgentDir(): void {
	if (process.env.PI_CODING_AGENT_DIR) {
		return;
	}
	const dir = join(tmpdir(), "pi-ahp-authored-agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({
			"github-copilot": { type: "oauth", refresh: "stub", access: "stub", expires: Date.now() + 86_400_000 },
		}),
	);
	process.env.PI_CODING_AGENT_DIR = dir;
}

interface Outcome {
	readonly events: AgentSessionEvent[];
	readonly stopReason: string | undefined;
	readonly errorMessage: string | undefined;
}

async function runAuthored(name: string, turns: readonly AuthoredTurn[]): Promise<Outcome> {
	useStubAgentDir();
	const workspace = join(tmpdir(), `pi-ahp-authored-${name}`);
	rmSync(workspace, { recursive: true, force: true });
	mkdirSync(workspace, { recursive: true });
	try {
		const backend = await InProcessPiBackend.create({
			cwd: workspace,
			sessionManager: SessionManager.create(workspace, undefined, { id: `authored-${name}` }),
		});
		backend.session.setActiveToolsByName(backend.session.getAllTools().map((tool) => tool.name));
		authorTurns(backend.session, turns);

		const events: AgentSessionEvent[] = [];
		let settled = false;
		backend.subscribe((event) => {
			events.push(event);
			if (event.type === "agent_settled") {
				settled = true;
			}
		});

		await backend.prompt("go");
		const deadline = Date.now() + SETTLE_TIMEOUT_MS;
		while (!settled && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const last = backend.session.messages.at(-1) as { stopReason?: string; errorMessage?: string } | undefined;
		backend.dispose();
		assert.ok(settled, `${name}: never settled`);
		return { events, stopReason: last?.stopReason, errorMessage: last?.errorMessage };
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

const types = (outcome: Outcome): string[] => outcome.events.map((event) => event.type);

describe("outcomes a recording cannot produce", () => {
	it("reports a content filter as a failed turn", async () => {
		// Providers do not agree on a vocabulary for refusing: OpenAI sends
		// `content_filter`, Google nine different safety and recitation reasons.
		// pi flattens all of them to `error`, so the distinction a client could
		// draw survives only in the message text.
		const outcome = await runAuthored("content-filter", [
			{
				text: "partial answer",
				stopReason: "error",
				errorMessage: "Provider finish_reason: content_filter",
			},
		]);
		assert.equal(outcome.stopReason, "error");
		assert.equal(outcome.errorMessage, "Provider finish_reason: content_filter");
		assert.ok(types(outcome).includes("agent_settled"));
	});

	it("reports a reply cut at the token ceiling", async () => {
		// `length` is neither a failure nor a clean finish, and pi passes it
		// through as its own stop reason rather than folding it into either.
		const outcome = await runAuthored("length", [{ text: "a truncated reply", stopReason: "length" }]);
		assert.equal(outcome.stopReason, "length");
		assert.equal(outcome.errorMessage, undefined);
	});

	it("retries a transient provider error and settles on the retry", async () => {
		// Whether pi retries is decided by matching the message text, so the
		// wording is what puts this turn on the retry path instead of the
		// content-filter one above.
		const outcome = await runAuthored("retryable", [
			{ stopReason: "error", errorMessage: "503 service unavailable" },
			{ text: "recovered" },
		]);
		const emitted = types(outcome);
		assert.ok(emitted.includes("auto_retry_start"), "expected pi to start a retry");
		assert.ok(emitted.includes("auto_retry_end"), "expected pi to finish the retry");
		assert.equal(outcome.stopReason, "stop", "the retry's reply should be the turn's outcome");
	});

	it("does not retry an error the provider will keep returning", async () => {
		const outcome = await runAuthored("non-retryable", [
			{ stopReason: "error", errorMessage: "Provider finish_reason: content_filter" },
		]);
		assert.ok(!types(outcome).includes("auto_retry_start"), "a content filter should not be retried");
	});
});
