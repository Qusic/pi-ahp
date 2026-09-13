/** Exhaustive contract for the AHP 0.9 command surface this product exposes. */

import { after, before, describe, it } from "node:test";
import { type CommandMap, JsonRpcErrorCodes, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { ROOT_CHANNEL } from "../src/core/channels.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";
import { expectRpcError } from "./support/assertions.ts";

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
				client.request(method as UnsupportedMethod, params),
				JsonRpcErrorCodes.MethodNotFound,
				method,
			);
		}
	});

	it("requires the root routing channel on every connection-level command", async () => {
		const wrongChannel = "ahp-session:/wrong-channel";
		for (const method of ROOT_METHODS.filter((candidate) => candidate !== "initialize" && candidate !== "reconnect")) {
			await expectRpcError(client.request(method, { channel: wrongChannel }), JsonRpcErrorCodes.InvalidParams, method);
		}

		const initializing = await harness.connect();
		await expectRpcError(
			initializing.request("initialize", {
				channel: wrongChannel,
				clientId: nextClientId(),
				protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
			} as never),
			JsonRpcErrorCodes.InvalidParams,
			"initialize",
		);

		const reconnecting = await harness.connect();
		await expectRpcError(
			reconnecting.request("reconnect", {
				channel: wrongChannel,
				clientId: nextClientId(),
				lastSeenServerSeq: 0,
				subscriptions: [],
			} as never),
			JsonRpcErrorCodes.InvalidParams,
			"reconnect",
		);
	});
});
