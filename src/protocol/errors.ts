/**
 * Protocol-level errors.
 *
 * Handlers throw {@link ProtocolError}; the router turns it into a JSON-RPC
 * error response. Anything else becomes `InternalError` (-32603).
 */

import { AhpErrorCodes, JsonRpcErrorCodes } from "@microsoft/agent-host-protocol";

export class ProtocolError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "ProtocolError";
		this.code = code;
		this.data = data;
	}

	static invalidParams(message: string, data?: unknown): ProtocolError {
		return new ProtocolError(JsonRpcErrorCodes.InvalidParams, message, data);
	}

	static methodNotFound(method: string): ProtocolError {
		return new ProtocolError(JsonRpcErrorCodes.MethodNotFound, `Unknown method: ${method}`);
	}

	static sessionNotFound(channel: string): ProtocolError {
		return new ProtocolError(AhpErrorCodes.SessionNotFound, `Session not found: ${channel}`);
	}

	static sessionAlreadyExists(channel: string): ProtocolError {
		return new ProtocolError(AhpErrorCodes.SessionAlreadyExists, `Session already exists: ${channel}`);
	}

	static providerNotFound(provider: string): ProtocolError {
		return new ProtocolError(AhpErrorCodes.ProviderNotFound, `No agent for provider: ${provider}`);
	}

	static notFound(uri: string): ProtocolError {
		return new ProtocolError(AhpErrorCodes.NotFound, `Not found: ${uri}`);
	}
}
