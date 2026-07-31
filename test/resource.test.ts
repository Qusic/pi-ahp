/**
 * The `resource*` family, driven end-to-end by the official client.
 *
 * These matter for the cross-machine case: without them a remote client cannot
 * browse, open, or edit anything the agent touches.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/root-channel
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	ContentEncoding,
	ResourceType,
	ResourceWriteMode,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import { AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { installRootChannel } from "../src/channels/root.ts";
import { AhpHost } from "../src/core/host.ts";
import { ResourceService } from "../src/pi/resource-service.ts";
import { type RunningServer, serveWebSocket } from "../src/transport/websocket.ts";
import { checkSchema } from "./support/schema.ts";

const uri = (path: string): string => pathToFileURL(path).toString();

interface Fixture {
	client: AhpClient;
	server: RunningServer;
	workspace: string;
}

async function startFixture(roots?: readonly string[]): Promise<Fixture> {
	const workspace = mkdtempSync(join(tmpdir(), "pi-ahp-resource-"));
	const host = new AhpHost();
	installRootChannel(host, []);
	host.serve({ resources: new ResourceService(roots ? { roots } : {}) });

	const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	await client.initialize({ clientId: "resource-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	return { client, server, workspace };
}

describe("resource operations", () => {
	let fixture: Fixture;

	before(async () => {
		fixture = await startFixture();
		writeFileSync(join(fixture.workspace, "note.txt"), "ALPHA BETA GAMMA\n");
		mkdirSync(join(fixture.workspace, "nested"));
		writeFileSync(join(fixture.workspace, "nested", "inner.md"), "# Inner\n");
		writeFileSync(join(fixture.workspace, "blob.bin"), Buffer.from([0, 1, 2, 253, 254, 255]));
	});

	after(async () => {
		await fixture.client.shutdown();
		await fixture.server.close();
		rmSync(fixture.workspace, { recursive: true, force: true });
	});

	it("reads a text file as utf-8 with a content type", async () => {
		const result = await fixture.client.resourceRead({ uri: uri(join(fixture.workspace, "note.txt")) });

		assert.equal(result.encoding, ContentEncoding.Utf8);
		assert.equal(result.data, "ALPHA BETA GAMMA\n");
		assert.equal(result.contentType, "text/plain");
		assert.equal(checkSchema("commands", "ResourceReadResult", result), undefined);
	});

	it("falls back to base64 for content utf-8 cannot round-trip", async () => {
		const result = await fixture.client.resourceRead({ uri: uri(join(fixture.workspace, "blob.bin")) });

		assert.equal(result.encoding, ContentEncoding.Base64);
		assert.deepEqual([...Buffer.from(result.data, "base64")], [0, 1, 2, 253, 254, 255]);
	});

	it("honours an explicitly requested encoding", async () => {
		const result = await fixture.client.resourceRead({
			uri: uri(join(fixture.workspace, "note.txt")),
			encoding: ContentEncoding.Base64,
		});

		assert.equal(result.encoding, ContentEncoding.Base64);
		assert.equal(Buffer.from(result.data, "base64").toString("utf8"), "ALPHA BETA GAMMA\n");
	});

	it("lists a directory with directories first", async () => {
		const result = await fixture.client.resourceList({ uri: uri(fixture.workspace) });

		assert.equal(result.entries[0]?.type, "directory");
		assert.equal(result.entries[0]?.name, "nested");
		assert.ok(result.entries.some((entry) => entry.name === "note.txt" && entry.type === "file"));
		assert.equal(checkSchema("commands", "ResourceListResult", result), undefined);
	});

	it("resolves a file to its stats and a change token", async () => {
		const result = await fixture.client.resourceResolve({ uri: uri(join(fixture.workspace, "note.txt")) });

		assert.equal(result.type, ResourceType.File);
		assert.equal(result.size, 17);
		assert.ok(result.etag);
		assert.equal(checkSchema("commands", "ResourceResolveResult", result), undefined);
	});

	it("writes, then reads back what it wrote", async () => {
		const target = join(fixture.workspace, "written.txt");
		await fixture.client.resourceWrite({
			uri: uri(target),
			data: "hello",
			encoding: ContentEncoding.Utf8,
		});

		assert.equal(readFileSync(target, "utf8"), "hello");
	});

	it("creates missing parent directories on write", async () => {
		const target = join(fixture.workspace, "deep", "deeper", "file.txt");
		await fixture.client.resourceWrite({ uri: uri(target), data: "x", encoding: ContentEncoding.Utf8 });

		assert.equal(readFileSync(target, "utf8"), "x");
	});

	it("appends without clobbering", async () => {
		const target = join(fixture.workspace, "append.txt");
		await fixture.client.resourceWrite({ uri: uri(target), data: "one", encoding: ContentEncoding.Utf8 });
		await fixture.client.resourceWrite({
			uri: uri(target),
			data: "-two",
			encoding: ContentEncoding.Utf8,
			mode: ResourceWriteMode.Append,
		});

		assert.equal(readFileSync(target, "utf8"), "one-two");
	});

	it("refuses to overwrite when createOnly is set", async () => {
		const target = join(fixture.workspace, "once.txt");
		await fixture.client.resourceWrite({ uri: uri(target), data: "first", encoding: ContentEncoding.Utf8 });

		const error = await fixture.client
			.resourceWrite({ uri: uri(target), data: "second", encoding: ContentEncoding.Utf8, createOnly: true })
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32010);
		assert.equal(readFileSync(target, "utf8"), "first");
	});

	it("rejects a write mode it cannot honour rather than writing wrong bytes", async () => {
		const error = await fixture.client
			.resourceWrite({
				uri: uri(join(fixture.workspace, "insert.txt")),
				data: "x",
				encoding: ContentEncoding.Utf8,
				mode: ResourceWriteMode.Insert,
			})
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32602);
	});

	it("makes directories with mkdir -p semantics", async () => {
		const target = join(fixture.workspace, "a", "b", "c");
		await fixture.client.resourceMkdir({ uri: uri(target) });
		// Idempotent, like `mkdir -p`.
		await fixture.client.resourceMkdir({ uri: uri(target) });

		assert.ok(existsSync(target));
	});

	it("copies and moves files", async () => {
		const source = join(fixture.workspace, "copy-source.txt");
		writeFileSync(source, "payload");

		await fixture.client.resourceCopy({
			source: uri(source),
			destination: uri(join(fixture.workspace, "copied.txt")),
		});
		assert.equal(readFileSync(join(fixture.workspace, "copied.txt"), "utf8"), "payload");

		await fixture.client.resourceMove({
			source: uri(source),
			destination: uri(join(fixture.workspace, "moved.txt")),
		});
		assert.equal(existsSync(source), false);
		assert.equal(readFileSync(join(fixture.workspace, "moved.txt"), "utf8"), "payload");
	});

	it("fails a copy onto an existing destination when asked to", async () => {
		const source = join(fixture.workspace, "guard-source.txt");
		const destination = join(fixture.workspace, "guard-dest.txt");
		writeFileSync(source, "new");
		writeFileSync(destination, "existing");

		const error = await fixture.client
			.resourceCopy({ source: uri(source), destination: uri(destination), failIfExists: true })
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32010);
		assert.equal(readFileSync(destination, "utf8"), "existing");
	});

	it("deletes files, and directories only when recursion is requested", async () => {
		const doomed = join(fixture.workspace, "doomed");
		mkdirSync(doomed, { recursive: true });
		writeFileSync(join(doomed, "child.txt"), "x");

		const error = await fixture.client.resourceDelete({ uri: uri(doomed) }).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		assert.ok(error instanceof RpcError, "a non-recursive delete must not take the tree with it");
		// `PermissionDenied`, not the `ResourceExists` the other refusals here
		// use: a client that branches on the code has to be able to tell a
		// directory it may not remove from a file that is already there.
		assert.equal(error.code, -32009);
		assert.ok(existsSync(doomed));

		await fixture.client.resourceDelete({ uri: uri(doomed), recursive: true });
		assert.equal(existsSync(doomed), false);
	});

	it("reports a missing file as NotFound", async () => {
		const error = await fixture.client.resourceRead({ uri: uri(join(fixture.workspace, "absent.txt")) }).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32008);
	});

	it("rejects a non-file scheme", async () => {
		const error = await fixture.client.resourceRead({ uri: "https://example.com/x" }).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32602);
	});

	it("grants resourceRequest without tracking a ledger", async () => {
		// The host keeps no per-resource grants; a client that reached this
		// endpoint can already start a session and run commands.
		assert.deepEqual(await fixture.client.resourceRequest({ uri: uri(fixture.workspace), read: true }), {});
	});
});

describe("resource roots", () => {
	let fixture: Fixture;
	let outside: string;

	before(async () => {
		outside = mkdtempSync(join(tmpdir(), "pi-ahp-outside-"));
		writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
		fixture = await startFixture([mkdtempSync(join(tmpdir(), "pi-ahp-root-"))]);
	});

	after(async () => {
		await fixture.client.shutdown();
		await fixture.server.close();
		rmSync(outside, { recursive: true, force: true });
	});

	it("denies a path outside the configured roots", async () => {
		const error = await fixture.client.resourceRead({ uri: uri(join(outside, "secret.txt")) }).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		assert.ok(error instanceof RpcError);
		assert.equal(error.code, -32009);
	});
});

describe("resource roots — symlink escape", () => {
	it("resolves symlinks before checking the allowlist", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-symroot-"));
		const outside = mkdtempSync(join(tmpdir(), "pi-ahp-symout-"));
		try {
			writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
			symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));

			const host = new AhpHost();
			installRootChannel(host, []);
			host.serve({ resources: new ResourceService({ roots: [root] }) });
			const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
			const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
			client.connect();
			await client.initialize({ clientId: "symlink-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

			try {
				const error = await client.resourceRead({ uri: uri(join(root, "link.txt")) }).then(
					() => undefined,
					(reason: unknown) => reason,
				);
				assert.ok(error instanceof RpcError, "a symlink out of the root must not be readable");
				assert.equal(error.code, -32009);
			} finally {
				await client.shutdown();
				await server.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
