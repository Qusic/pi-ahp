import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { InProcessPiBackend } from "../src/pi/in-process-backend.ts";
import { ONE_PIXEL_PNG } from "./support/images.ts";
import { createReplayEnvironment } from "./support/replay.ts";

it("passes and persists images while honouring preflight cancellation", async () => {
	const environment = createReplayEnvironment();
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-image-session-"));
	const manager = SessionManager.create(workspace, join(environment.agentDir, "sessions", "image-session"), {
		id: "image-session",
	});
	let backend: InProcessPiBackend | undefined;
	let contextMessages: Message[] = [];

	try {
		backend = await InProcessPiBackend.create({ cwd: workspace, sessionManager: manager });
		const faux = createFauxCore({});
		faux.setResponses([
			(context) => {
				contextMessages = structuredClone(context.messages);
				return fauxAssistantMessage("I can see the image.");
			},
		]);
		backend.session.agent.streamFunction = faux.stream as never;

		await backend.prompt("Describe this image", [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }]);

		const received = contextMessages.findLast((message) => message.role === "user");
		assert.ok(received && Array.isArray(received.content));
		assert.equal(received.content.length, 2);
		assert.deepEqual(received.content[0], { type: "text", text: "Describe this image" });
		const receivedImage = received.content[1];
		assert.equal(receivedImage?.type, "image");
		if (receivedImage?.type === "image") {
			assert.equal(receivedImage.mimeType, "image/png");
			assert.deepEqual(
				Buffer.from(receivedImage.data, "base64").subarray(0, 8),
				Buffer.from("89504e470d0a1a0a", "hex"),
			);
		}

		const stored = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
		const storedMessage = stored?.type === "message" && stored.message.role === "user" ? stored.message : undefined;
		assert.deepEqual(storedMessage?.content, received.content);

		const cancelled = new AbortController();
		cancelled.abort();
		await backend.prompt(
			"Do not send this",
			[{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }],
			cancelled.signal,
		);
		assert.equal(faux.state.callCount, 1, "cancelled image preflight started another model request");
		assert.equal(
			manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length,
			1,
		);
	} finally {
		backend?.dispose();
		environment.close();
		rmSync(workspace, { recursive: true, force: true });
	}
});
