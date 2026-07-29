/**
 * JSON-RPC 2.0 wire helpers.
 *
 * AHP is transport-agnostic JSON-RPC 2.0. Every command's and every
 * notification's `params` carries a top-level `channel: URI`, so a receiver can
 * dispatch any message by inspecting `(method, params.channel)` without
 * per-method deserialisation.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/overview
 */

import type { URI } from "@microsoft/agent-host-protocol";

/** A JSON-RPC request: has both `method` and `id`. */
export interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: number;
	readonly method: string;
	readonly params?: unknown;
}

/** A JSON-RPC notification: has `method` but no `id`. */
export interface JsonRpcNotification {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcSuccessResponse {
	readonly jsonrpc: "2.0";
	readonly id: number;
	readonly result: unknown;
}

export interface JsonRpcErrorResponse {
	readonly jsonrpc: "2.0";
	readonly id: number;
	readonly error: {
		readonly code: number;
		readonly message: string;
		readonly data?: unknown;
	};
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
	return isObject(message) && typeof message.method === "string" && typeof message.id === "number";
}

export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
	return isObject(message) && typeof message.method === "string" && message.id === undefined;
}

export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
	return isObject(message) && typeof message.id === "number" && ("result" in message || "error" in message);
}

/**
 * Reads the universal routing key off a message's params.
 *
 * Returns `undefined` when the params are missing or carry no `channel`, which
 * the caller surfaces as `InvalidParams` — the field is required on every
 * command and notification in the protocol.
 */
export function readChannel(params: unknown): URI | undefined {
	if (!isObject(params)) {
		return undefined;
	}
	const channel = params.channel;
	return typeof channel === "string" ? channel : undefined;
}

export function successResponse(id: number, result: unknown): JsonRpcSuccessResponse {
	return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: number, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: data === undefined ? { code, message } : { code, message, data },
	};
}

export function notification(method: string, params: unknown): JsonRpcNotification {
	return { jsonrpc: "2.0", method, params };
}
