import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createDefaultPiSessionStorage } from "../src/pi/session-storage.ts";

it("keeps the default catalogue and Pi session writer on the same isolated profile", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-ahp-default-storage-agent-"));
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-default-storage-cwd-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	});

	const storage = createDefaultPiSessionStorage();
	const sessionId = randomUUID();
	const manager = storage.createSessionManager(workspace, sessionId);
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("hello"));

	const file = manager.getSessionFile();
	assert.ok(file);
	assert.equal(await storage.catalogue.findSessionFile(sessionId), file);
	assert.equal(relative(join(agentDir, "sessions"), file).startsWith(".."), false);
});
