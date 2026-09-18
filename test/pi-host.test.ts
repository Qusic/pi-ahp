/** The production composition root wires its independently tested services together. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	CompletionItemKind,
	SessionLifecycle,
	type SessionState,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { createPiHost } from "../src/host/pi-host.ts";
import { PROJECT_TRUST_KEY } from "../src/pi/session-config.ts";
import { serveWebSocket } from "../src/transport/websocket.ts";
import { eventually } from "./support/async.ts";

it("wires product services through createPiHost", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-composition-"));
	writeFileSync(join(workspace, "notes.md"), "# Notes\n");
	const built = await createPiHost({
		serverInfo: { name: "pi-ahp", version: "composition-test" },
		workingDirectory: workspace,
		modelRuntime: { getAvailable: async () => [] },
		createBackend: () => ({
			subscribe: () => () => {},
			prompt: async () => {},
			steer: async () => {},
			abort: async () => {},
		}),
		deleteFile: () => ({ ok: true }),
	});
	const server = await serveWebSocket(built.host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();

	try {
		const initialized = await client.initialize({
			clientId: "composition-client",
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
			initialSubscriptions: [ROOT_CHANNEL],
		});
		assert.deepEqual(initialized.completionTriggerCharacters, ["@"]);

		const resource = await client.resourceRead({ uri: pathToFileURL(join(workspace, "notes.md")).toString() });
		assert.equal(resource.data, "# Notes\n");

		const config = await client.request("resolveSessionConfig", {
			channel: ROOT_CHANNEL,
			workingDirectory: pathToFileURL(workspace).toString(),
		});
		assert.ok(config.schema.properties[PROJECT_TRUST_KEY]);

		const id = randomUUID();
		const session = sessionUri(id);
		const chat = chatUri(id);
		await client.request("createSession", { channel: session });
		await client.subscribe(chat);
		await eventually(
			"the composed session backend to become ready",
			() => (built.host.store.get(session) as SessionState).lifecycle === SessionLifecycle.Ready,
		);

		const completions = await client.completions({
			kind: CompletionItemKind.UserMessage,
			channel: chat,
			text: "see @not",
			offset: 8,
		});
		assert.deepEqual(
			completions.items.map((item) => item.insertText),
			["@notes.md"],
		);
	} finally {
		await client.shutdown();
		await server.close();
		built.terminals.shutdown();
		await Promise.all([built.changesets.dispose(), built.watches.dispose()]);
		rmSync(workspace, { recursive: true, force: true });
	}
});
