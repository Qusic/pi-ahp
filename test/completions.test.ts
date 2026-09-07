/**
 * Inline completions for a message being composed.
 *
 * The protocol makes `CompletionItem.attachment` required, which decides what
 * this feature is: an attachment picker. `@`-mentions fit; pi's slash commands
 * do not, because they attach nothing.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/chat-channel
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	CompletionItemKind,
	type CompletionsResult,
	JsonRpcErrorCodes,
	MessageAttachmentKind,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { AhpHost } from "../src/core/host.ts";
import { CompletionService, findMention, MENTION_TRIGGER } from "../src/pi/completions.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { checkSchema } from "./support/schema.ts";

const CHAT = "ahp-chat:/completions";

describe("mention parsing", () => {
	it("finds a mention the cursor sits in", () => {
		const found = findMention("look at @foo", 12);
		assert.deepEqual(found, { start: 8, end: 12, query: "foo" });
	});

	it("finds a bare mention at the start of the text", () => {
		assert.equal(findMention("@src", 4)?.query, "src");
	});

	it("ignores an `@` that is not preceded by whitespace", () => {
		// Otherwise every email address and decorator opens the picker.
		assert.equal(findMention("mail me at a@b.com", 18), undefined);
	});

	it("ignores a cursor that is past the end of the mention", () => {
		assert.equal(findMention("@foo bar", 8), undefined);
	});

	it("returns the empty query for a lone trigger", () => {
		assert.equal(findMention("@", 1)?.query, "");
	});
});

describe("completions", () => {
	let workspace: string;
	let service: CompletionService;

	before(() => {
		workspace = mkdtempSync(join(tmpdir(), "pi-ahp-completions-"));
		writeFileSync(join(workspace, "readme.md"), "x");
		writeFileSync(join(workspace, "report.txt"), "x");
		writeFileSync(join(workspace, "other.js"), "x");
		writeFileSync(join(workspace, ".hidden"), "x");
		mkdirSync(join(workspace, "src", "lib"), { recursive: true });
		writeFileSync(join(workspace, "src", "index.ts"), "x");
		writeFileSync(join(workspace, "src", "lib", "deep.ts"), "x");
		mkdirSync(join(workspace, "node_modules"));
		writeFileSync(join(workspace, "node_modules", "reactive.js"), "x");
		mkdirSync(join(workspace, "dist"));
		writeFileSync(join(workspace, "dist", "generated.js"), "x");
		mkdirSync(join(workspace, "build"));
		writeFileSync(join(workspace, "build", "artifact.js"), "x");

		service = new CompletionService({ workingDirectoryFor: () => workspace });
	});

	after(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	const complete = (text: string, offset = text.length): Promise<CompletionsResult> =>
		service.complete({ kind: CompletionItemKind.UserMessage, channel: CHAT, text, offset });

	it("offers files matching the typed prefix", async () => {
		const { items } = await complete("look at @re");

		const inserted = items.map((item) => item.insertText);
		assert.deepEqual(inserted.sort(), ["@readme.md", "@report.txt"]);
	});

	it("attaches the resource each item refers to", async () => {
		const { items } = await complete("@readme");
		const item = items[0];

		assert.ok(item);
		assert.equal(item.attachment.type, MessageAttachmentKind.Resource);
		assert.equal(item.attachment.label, "readme.md");
		assert.match((item.attachment as { uri: string }).uri, /readme\.md$/);
		assert.equal(checkSchema("commands", "CompletionItem", item), undefined);
	});

	it("marks the range the client should replace", async () => {
		const { items } = await complete("look at @re");

		// The span covers the `@` through the cursor, so accepting replaces the
		// half-typed mention rather than appending to it.
		assert.equal(items[0]?.rangeStart, 8);
		assert.equal(items[0]?.rangeEnd, 11);
	});

	it("returns nested files instead of directory navigation items", async () => {
		const { items } = await complete("@sr");

		assert.deepEqual(
			items.map((item) => item.insertText),
			["@src/index.ts", "@src/lib/deep.ts"],
		);
		assert.ok(items.every((item) => item.attachment.displayKind === "document"));
	});

	it("matches a typed relative-path prefix", async () => {
		const { items } = await complete("@src/in");

		assert.deepEqual(
			items.map((item) => item.insertText),
			["@src/index.ts"],
		);
	});

	it("matches a nested file by basename", async () => {
		const { items } = await complete("@deep");

		assert.deepEqual(
			items.map((item) => item.insertText),
			["@src/lib/deep.ts"],
		);
	});

	it("keeps the temporary directory skip list narrow", async () => {
		const inserted = (await complete("@")).items.map((item) => item.insertText);

		assert.equal(
			inserted.some((item) => item.includes("node_modules")),
			false,
		);
		assert.equal(
			inserted.some((item) => item.includes(".hidden")),
			false,
		);
		assert.ok(inserted.includes("@dist/generated.js"));
		assert.ok(inserted.includes("@build/artifact.js"));
	});

	it("does not interpret a query as path traversal", async () => {
		const { items } = await complete("@../../etc/pass");
		assert.deepEqual(items, []);
	});

	it("returns nothing for a completion kind it does not implement", async () => {
		const result = await service.complete({
			kind: "futureKind" as CompletionItemKind,
			channel: CHAT,
			text: "@not",
			offset: 4,
		});
		assert.deepEqual(result.items, []);
	});

	it("returns nothing when the cursor is not in a mention", async () => {
		assert.deepEqual((await complete("plain text")).items, []);
	});

	it("returns nothing for a chat it has no directory for", async () => {
		const orphan = new CompletionService({ workingDirectoryFor: () => undefined });
		const result = await orphan.complete({
			kind: CompletionItemKind.UserMessage,
			channel: CHAT,
			text: "@re",
			offset: 3,
		});

		assert.deepEqual(result.items, []);
	});

	it("caps how many items it returns", async () => {
		const crowded = mkdtempSync(join(tmpdir(), "pi-ahp-crowded-"));
		try {
			for (let i = 0; i < 40; i++) {
				writeFileSync(join(crowded, `file-${i}.txt`), "x");
			}
			const capped = new CompletionService({ workingDirectoryFor: () => crowded, maxItems: 5 });
			const result = await capped.complete({
				kind: CompletionItemKind.UserMessage,
				channel: CHAT,
				text: "@file",
				offset: 5,
			});

			assert.equal(result.items.length, 5);
		} finally {
			rmSync(crowded, { recursive: true, force: true });
		}
	});
});

describe("completions over the wire", () => {
	let server: RunningServer;
	let client: AhpClient;
	let workspace: string;

	before(async () => {
		workspace = mkdtempSync(join(tmpdir(), "pi-ahp-completions-wire-"));
		writeFileSync(join(workspace, "notes.md"), "x");

		const host = new AhpHost({ completionTriggerCharacters: [MENTION_TRIGGER] });
		installRootChannel(host, []);
		host.serve({
			completions: new CompletionService({
				workingDirectoryFor: (channel) => (channel === CHAT ? workspace : undefined),
			}),
		});

		server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
		client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
	});

	after(async () => {
		await client.shutdown();
		await server.close();
		rmSync(workspace, { recursive: true, force: true });
	});

	it("advertises only the trigger it can answer", async () => {
		const result = await client.initialize({
			clientId: "completions-client",
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
		});

		// `/` is deliberately absent: pi's slash commands attach nothing, and
		// every completion item must carry an attachment.
		assert.deepEqual(result.completionTriggerCharacters, ["@"]);
		assert.equal(checkSchema("commands", "InitializeResult", result), undefined);
	});

	it("serves a schema-conforming result", async () => {
		const result = await client.request("completions", {
			kind: CompletionItemKind.UserMessage,
			channel: CHAT,
			text: "see @not",
			offset: 8,
		} as never);

		assert.equal(result.items.length, 1);
		assert.equal(result.items[0]?.insertText, "@notes.md");
		assert.equal(checkSchema("commands", "CompletionsResult", result), undefined);
	});

	it("rejects non-chat completion targets", async () => {
		const params = { kind: CompletionItemKind.UserMessage, text: "@not", offset: 4 };
		for (const channel of [undefined, "ahp-session:/completions"]) {
			await assert.rejects(
				client.request("completions", { ...params, ...(channel ? { channel } : {}) } as never),
				(error: unknown) => error instanceof RpcError && error.code === JsonRpcErrorCodes.InvalidParams,
			);
		}
	});

	it("maps provider-alias completion targets onto the default chat", async () => {
		const vscode = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		vscode.connect();
		await vscode.request("initialize", {
			channel: "ahp-root://",
			clientId: "vscode-completions-client",
			clientInfo: { name: "vscode-editor-window" },
			protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
		} as never);
		try {
			const params = { kind: CompletionItemKind.UserMessage, text: "@not", offset: 4 };
			for (const result of await Promise.all([
				vscode.request("completions", { ...params, channel: "pi:/completions" } as never),
				client.request("completions", { ...params, channel: "pi:/completions" } as never),
			])) {
				assert.deepEqual(
					result.items.map((item) => item.insertText),
					["@notes.md"],
				);
			}
		} finally {
			await vscode.shutdown();
		}
	});
});

describe("completions without a handler", () => {
	it("answers with an empty list rather than MethodNotFound", async () => {
		// The client debounces keystrokes into this call; an error per keypress
		// would be worse than nothing to show.
		const host = new AhpHost();
		installRootChannel(host, []);
		const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
		const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
		client.connect();
		await client.initialize({ clientId: "bare-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

		try {
			const result = await client.request("completions", {
				kind: CompletionItemKind.UserMessage,
				channel: CHAT,
				text: "@x",
				offset: 2,
			} as never);
			assert.deepEqual(result.items, []);
		} finally {
			await client.shutdown();
			await server.close();
		}
	});
});
