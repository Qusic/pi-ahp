/**
 * The `resource*` family, driven end-to-end by the official client.
 *
 * These matter for the cross-machine case: without them a remote client cannot
 * browse, open, or edit anything the agent touches.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/root-channel
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

async function expectRpcError(request: Promise<unknown>, code: number, message?: string): Promise<void> {
	await assert.rejects(request, (error: unknown) => error instanceof RpcError && error.code === code, message);
}

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
		writeFileSync(join(fixture.workspace, "data.json"), "{}\n");
		writeFileSync(join(fixture.workspace, "source.swift"), "struct Example {}\n");
		writeFileSync(join(fixture.workspace, "invalid.txt"), Buffer.from([0xff, 0xfe]));
		mkdirSync(join(fixture.workspace, "nested"));
		writeFileSync(join(fixture.workspace, "nested", "inner.md"), "# Inner\n");
		symlinkSync(join(fixture.workspace, "nested"), join(fixture.workspace, "nested-link"), "dir");
		writeFileSync(join(fixture.workspace, "blob.bin"), Buffer.from([0, 1, 2]));
		writeFileSync(join(fixture.workspace, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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

	it("detects valid UTF-8 independently of the extension and reports known MIME types", async () => {
		const source = await fixture.client.resourceRead({ uri: uri(join(fixture.workspace, "source.swift")) });
		assert.equal(source.encoding, ContentEncoding.Utf8);
		assert.equal(source.data, "struct Example {}\n");
		assert.equal(source.contentType, "text/plain");

		const json = await fixture.client.resourceRead({ uri: uri(join(fixture.workspace, "data.json")) });
		assert.equal(json.encoding, ContentEncoding.Utf8);
		assert.equal(json.contentType, "application/json");

		const image = await fixture.client.resourceRead({ uri: uri(join(fixture.workspace, "image.png")) });
		assert.equal(image.encoding, ContentEncoding.Base64);
		assert.equal(image.contentType, "image/png");
	});

	it("falls back to base64 when content is not valid UTF-8", async () => {
		const binary = await fixture.client.resourceRead({ uri: uri(join(fixture.workspace, "blob.bin")) });
		assert.equal(binary.encoding, ContentEncoding.Base64);
		assert.deepEqual([...Buffer.from(binary.data, "base64")], [0, 1, 2]);

		const misleadingExtension = await fixture.client.resourceRead({
			uri: uri(join(fixture.workspace, "invalid.txt")),
			encoding: ContentEncoding.Utf8,
		});
		assert.equal(misleadingExtension.encoding, ContentEncoding.Base64);
		assert.deepEqual([...Buffer.from(misleadingExtension.data, "base64")], [0xff, 0xfe]);
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
		assert.ok(result.entries.some((entry) => entry.name === "nested-link" && entry.type === "directory"));
		assert.equal(checkSchema("commands", "ResourceListResult", result), undefined);
	});

	it("resolves files and symlinks with canonical metadata", async () => {
		const result = await fixture.client.resourceResolve({ uri: uri(join(fixture.workspace, "note.txt")) });
		assert.equal(result.type, ResourceType.File);
		assert.equal(result.size, 17);
		assert.equal(result.contentType, "text/plain");
		assert.ok(result.etag);
		assert.equal(checkSchema("commands", "ResourceResolveResult", result), undefined);

		const image = await fixture.client.resourceResolve({ uri: uri(join(fixture.workspace, "image.png")) });
		assert.equal(image.contentType, "image/png");

		const linkUri = uri(join(fixture.workspace, "nested-link"));
		const link = await fixture.client.resourceResolve({ uri: linkUri, followSymlinks: false });
		assert.equal(link.type, ResourceType.Symlink);
		assert.equal(link.uri, linkUri);
		const target = await fixture.client.resourceResolve({ uri: linkUri });
		assert.equal(target.type, ResourceType.Directory);
		assert.equal(target.uri, uri(realpathSync(join(fixture.workspace, "nested"))));
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

	it("reports a missing parent directory instead of creating it implicitly", async () => {
		const target = join(fixture.workspace, "missing", "file.txt");
		await expectRpcError(
			fixture.client.resourceWrite({ uri: uri(target), data: "x", encoding: ContentEncoding.Utf8 }),
			-32008,
		);
		assert.equal(existsSync(target), false);
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

		await expectRpcError(
			fixture.client.resourceWrite({
				uri: uri(target),
				data: "second",
				encoding: ContentEncoding.Utf8,
				createOnly: true,
			}),
			-32010,
		);
		assert.equal(readFileSync(target, "utf8"), "first");

		const raced = join(fixture.workspace, "create-race.txt");
		const attempts = await Promise.allSettled(
			["one", "two"].map((data) =>
				fixture.client.resourceWrite({
					uri: uri(raced),
					data,
					encoding: ContentEncoding.Utf8,
					createOnly: true,
				}),
			),
		);
		assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
		const rejected = attempts.find((result) => result.status === "rejected");
		assert.ok(rejected?.status === "rejected" && rejected.reason instanceof RpcError);
		assert.equal(rejected.reason.code, -32010);
		assert.ok(["one", "two"].includes(readFileSync(raced, "utf8")));
	});

	it("applies byte positions for truncate, append, and insert", async () => {
		const truncate = join(fixture.workspace, "truncate-position.txt");
		writeFileSync(truncate, "abcdef");
		await fixture.client.resourceWrite({
			uri: uri(truncate),
			data: "XY",
			encoding: ContentEncoding.Utf8,
			mode: ResourceWriteMode.Truncate,
			position: 3,
		});
		assert.equal(readFileSync(truncate, "utf8"), "abcXY");

		const append = join(fixture.workspace, "append-position.txt");
		writeFileSync(append, "abcdef");
		await fixture.client.resourceWrite({
			uri: uri(append),
			data: "XY",
			encoding: ContentEncoding.Utf8,
			mode: ResourceWriteMode.Append,
			position: 2,
		});
		assert.equal(readFileSync(append, "utf8"), "abcdXYef");

		const insert = join(fixture.workspace, "insert-position.txt");
		writeFileSync(insert, "éZ");
		await fixture.client.resourceWrite({
			uri: uri(insert),
			data: "!",
			encoding: ContentEncoding.Utf8,
			mode: ResourceWriteMode.Insert,
			position: 2,
		});
		assert.equal(readFileSync(insert, "utf8"), "é!Z");
	});

	it("rejects invalid write modes and positions", async () => {
		for (const params of [
			{ mode: "overwrite" as ResourceWriteMode },
			{ mode: ResourceWriteMode.Insert, position: -1 },
			{ mode: ResourceWriteMode.Insert, position: 1.5 },
		]) {
			await expectRpcError(
				fixture.client.resourceWrite({
					uri: uri(join(fixture.workspace, "invalid-write.txt")),
					data: "x",
					encoding: ContentEncoding.Utf8,
					...params,
				}),
				-32602,
			);
		}
	});

	it("enforces ifMatch and serializes competing conditional writes", async () => {
		const missing = join(fixture.workspace, "conditional-missing.txt");
		await expectRpcError(
			fixture.client.resourceWrite({
				uri: uri(missing),
				data: "new",
				encoding: ContentEncoding.Utf8,
				ifMatch: "stale",
			}),
			-32011,
		);
		assert.equal(existsSync(missing), false);

		const target = join(fixture.workspace, "conditional.txt");
		writeFileSync(target, "original");
		const initial = await fixture.client.resourceResolve({ uri: uri(target) });
		assert.ok(initial.etag);

		await fixture.client.resourceWrite({
			uri: uri(target),
			data: "first update",
			encoding: ContentEncoding.Utf8,
			ifMatch: initial.etag,
		});
		assert.equal(readFileSync(target, "utf8"), "first update");

		await expectRpcError(
			fixture.client.resourceWrite({
				uri: uri(target),
				data: "stale update",
				encoding: ContentEncoding.Utf8,
				ifMatch: initial.etag,
			}),
			-32011,
		);
		assert.equal(readFileSync(target, "utf8"), "first update");

		const current = await fixture.client.resourceResolve({ uri: uri(target) });
		assert.ok(current.etag);
		const competing = await Promise.allSettled([
			fixture.client.resourceWrite({
				uri: uri(target),
				data: "winner one",
				encoding: ContentEncoding.Utf8,
				ifMatch: current.etag,
			}),
			fixture.client.resourceWrite({
				uri: uri(target),
				data: "winner number two",
				encoding: ContentEncoding.Utf8,
				ifMatch: current.etag,
			}),
		]);
		assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
		const rejection = competing.find((result) => result.status === "rejected");
		assert.ok(rejection?.status === "rejected" && rejection.reason instanceof RpcError);
		assert.equal(rejection.reason.code, -32011);
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

		await expectRpcError(
			fixture.client.resourceCopy({ source: uri(source), destination: uri(destination), failIfExists: true }),
			-32010,
		);
		assert.equal(readFileSync(destination, "utf8"), "existing");
	});

	it("deletes files, and directories only when recursion is requested", async () => {
		const doomed = join(fixture.workspace, "doomed");
		mkdirSync(doomed, { recursive: true });
		writeFileSync(join(doomed, "child.txt"), "x");

		// `PermissionDenied`, not the `ResourceExists` the other refusals here
		// use: a client that branches on the code has to be able to tell a
		// directory it may not remove from a file that is already there.
		await expectRpcError(
			fixture.client.resourceDelete({ uri: uri(doomed) }),
			-32009,
			"a non-recursive delete must not take the tree with it",
		);
		assert.ok(existsSync(doomed));

		await fixture.client.resourceDelete({ uri: uri(doomed), recursive: true });
		assert.equal(existsSync(doomed), false);
	});

	it("reports a missing file as NotFound", async () => {
		await expectRpcError(fixture.client.resourceRead({ uri: uri(join(fixture.workspace, "absent.txt")) }), -32008);
	});

	it("rejects a non-file scheme", async () => {
		await expectRpcError(fixture.client.resourceRead({ uri: "https://example.com/x" }), -32602);
	});

	it("grants resourceRequest without tracking a ledger", async () => {
		// The host keeps no per-resource grants; a client that reached this
		// endpoint can already start a session and run commands.
		assert.deepEqual(await fixture.client.resourceRequest({ uri: uri(fixture.workspace), read: true }), {});
	});
});

describe("resource roots", () => {
	let fixture: Fixture;
	let root: string;
	let outside: string;

	before(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-ahp-root-"));
		writeFileSync(join(root, "inside.txt"), "INSIDE\n");
		outside = mkdtempSync(join(tmpdir(), "pi-ahp-outside-"));
		writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
		fixture = await startFixture([root]);
	});

	after(async () => {
		await fixture.client.shutdown();
		await fixture.server.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("allows paths inside a configured root after canonicalization", async () => {
		const result = await fixture.client.resourceRead({ uri: uri(join(root, "inside.txt")) });
		assert.equal(result.data, "INSIDE\n");
	});

	it("denies a path outside the configured roots", async () => {
		await expectRpcError(fixture.client.resourceRead({ uri: uri(join(outside, "secret.txt")) }), -32009);
	});
});

describe("resource roots — symlink escape", () => {
	it("resolves symlinks before checking the allowlist", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-symroot-"));
		const outside = mkdtempSync(join(tmpdir(), "pi-ahp-symout-"));
		try {
			const danglingTarget = join(outside, "created-through-link.txt");
			writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
			mkdirSync(join(outside, "secret-directory"));
			symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
			symlinkSync(join(outside, "secret-directory"), join(root, "directory-link"), "dir");
			symlinkSync(danglingTarget, join(root, "dangling-link.txt"));

			const host = new AhpHost();
			installRootChannel(host, []);
			host.serve({ resources: new ResourceService({ roots: [root] }) });
			const server = await serveWebSocket(host, { host: "127.0.0.1", port: 0 });
			const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
			client.connect();
			await client.initialize({ clientId: "symlink-client", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });

			try {
				const listed = await client.resourceList({ uri: uri(root) });
				assert.ok(listed.entries.some((entry) => entry.name === "directory-link" && entry.type === "file"));

				await expectRpcError(
					client.resourceRead({ uri: uri(join(root, "link.txt")) }),
					-32009,
					"a symlink out of the root must not be readable",
				);
				await expectRpcError(
					client.resourceWrite({
						uri: uri(join(root, "dangling-link.txt")),
						data: "escaped",
						encoding: ContentEncoding.Utf8,
					}),
					-32009,
					"a dangling symlink must not create a file outside the root",
				);
				assert.equal(existsSync(danglingTarget), false);
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
