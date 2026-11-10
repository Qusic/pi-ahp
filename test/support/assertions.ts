import assert from "node:assert/strict";
import { type ErrorInfo, JsonRpcErrorCodes, ResponsePartKind, type Turn } from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";

/** Narrows an optional value while reporting the missing value directly. */
export function must<T>(value: T | undefined | null, what = "value"): T {
	if (value === undefined || value === null) {
		assert.fail(`expected ${what} to be present`);
	}
	return value;
}

/** Returns the durable final error part of an errored turn. */
export function turnError(turn: Turn | undefined): ErrorInfo | undefined {
	const part = turn?.responseParts.at(-1);
	return part?.kind === ResponsePartKind.Error ? part.error : undefined;
}

/** Requires a JSON-RPC request to fail with the specified protocol code. */
export async function expectRpcError(
	request: Promise<unknown>,
	code: number,
	context = `expected RPC error ${code}`,
): Promise<RpcError> {
	const error = await request.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	assert.ok(error instanceof RpcError, `${context}: expected RpcError, received ${String(error)}`);
	assert.equal(error.code, code, context);
	return error;
}

/** Requires the host to refuse VS Code's `disposeSession` and keep the session. */
export async function expectVscodeDisposalRefusal(request: Promise<unknown>): Promise<void> {
	const error = await expectRpcError(request, JsonRpcErrorCodes.InvalidRequest);
	assert.match(error.message, /Deleting sessions from VS Code is temporarily disabled\b.*\bthis session was kept\.$/u);
}
