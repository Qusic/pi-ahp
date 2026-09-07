/** Exhaustive contract for the AHP 0.9 command surface this product exposes. */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type CommandMap, JsonRpcErrorCodes, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { type AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";
import { ROOT_CHANNEL } from "../src/core/channels.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";

type Route = "root" | "dynamic" | "session" | "chat" | "terminal" | "changeset" | "automations";
type CommandPolicy = { readonly support: "implemented" | "unsupported"; readonly route: Route };

const implemented = <R extends Route>(route: R) => ({ support: "implemented" as const, route });
const unsupported = <R extends Route>(route: R) => ({ support: "unsupported" as const, route });

/** Compile-time exhaustiveness makes an AHP upgrade require an explicit decision. */
const COMMAND_POLICY = {
	initialize: implemented("root"),
	ping: implemented("root"),
	reconnect: implemented("root"),
	subscribe: implemented("dynamic"),
	createSession: implemented("session"),
	disposeSession: implemented("session"),
	createChat: unsupported("session"),
	disposeChat: unsupported("chat"),
	createTerminal: implemented("terminal"),
	disposeTerminal: implemented("terminal"),
	createResourceWatch: implemented("root"),
	listSessions: implemented("root"),
	resourceRead: implemented("root"),
	resourceWrite: implemented("root"),
	resourceList: implemented("root"),
	resourceCopy: implemented("root"),
	resourceDelete: implemented("root"),
	resourceMove: implemented("root"),
	resourceResolve: implemented("root"),
	resourceMkdir: implemented("root"),
	resourceRequest: implemented("root"),
	fetchTurns: implemented("chat"),
	authenticate: unsupported("root"),
	resolveSessionConfig: implemented("root"),
	sessionConfigCompletions: implemented("root"),
	completions: implemented("chat"),
	invokeChangesetOperation: unsupported("changeset"),
	listAutomationTriggerDefinitions: unsupported("root"),
	runAutomation: unsupported("automations"),
	fetchAutomationRuns: unsupported("automations"),
} satisfies Record<keyof CommandMap, CommandPolicy>;

type UnsupportedMethod = {
	[M in keyof CommandMap]: (typeof COMMAND_POLICY)[M]["support"] extends "unsupported" ? M : never;
}[keyof CommandMap];

const UNSUPPORTED_REQUESTS: { [M in UnsupportedMethod]: CommandMap[M]["params"] } = {
	createChat: { channel: "ahp-session:/session", chat: "ahp-chat:/chat" },
	disposeChat: { channel: "ahp-chat:/chat" },
	authenticate: { channel: ROOT_CHANNEL, resource: "https://example.com", token: "opaque" },
	invokeChangesetOperation: { channel: "ahp-changeset:/changes", operationId: "apply" },
	listAutomationTriggerDefinitions: { channel: ROOT_CHANNEL },
	runAutomation: { channel: "ahp-automations://", automation: "ahp-automation:/job", requestId: "request" },
	fetchAutomationRuns: { channel: "ahp-automations://", automation: "ahp-automation:/job" },
};

const ROOT_METHODS = Object.entries(COMMAND_POLICY)
	.filter(([, policy]) => policy.route === "root")
	.map(([method]) => method as keyof CommandMap);

async function expectRpcError(promise: Promise<unknown>, code: number, context: string): Promise<RpcError> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	assert.ok(error instanceof RpcError, context);
	assert.equal(error.code, code, context);
	return error;
}

describe("AHP command surface", () => {
	let harness: Harness;
	let client: AhpClient;

	before(async () => {
		harness = await startHarness();
		client = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	});

	after(async () => {
		await harness.dispose();
	});

	it("returns MethodNotFound for every deliberately unsupported command", async () => {
		for (const [method, params] of Object.entries(UNSUPPORTED_REQUESTS)) {
			await expectRpcError(
				client.request(method as UnsupportedMethod, params as never),
				JsonRpcErrorCodes.MethodNotFound,
				method,
			);
		}
	});

	it("requires the root routing channel on every connection-level command", async () => {
		for (const method of ROOT_METHODS) {
			await expectRpcError(
				client.request(method, { channel: "ahp-session:/wrong-channel" } as never),
				JsonRpcErrorCodes.InvalidParams,
				method,
			);
		}
	});
});
