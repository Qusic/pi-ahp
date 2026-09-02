/** One transport connection and its per-socket subscriptions. */

import type { URI } from "@microsoft/agent-host-protocol";
import type { JsonRpcMessage } from "../protocol/jsonrpc.ts";
import { ClientWorkarounds } from "./client-workarounds.ts";

/** A bidirectional, ordered, reliable message stream carrying one JSON-RPC message per frame. */
export interface Transport {
	send(message: JsonRpcMessage): void;
	close(): void;
	onMessage(handler: (message: unknown) => void): void;
	onClose(handler: () => void): void;
}

export class ClientConnection {
	/** Assigned at `initialize` / `reconnect`; empty until the handshake completes. */
	clientId = "";
	readonly subscriptions = new Set<URI>();
	readonly transport: Transport;
	readonly workarounds = new ClientWorkarounds();

	constructor(transport: Transport) {
		this.transport = transport;
	}

	send(message: JsonRpcMessage): void {
		this.transport.send(this.workarounds.applyToMessage(message));
	}

	subscribe(channel: URI): void {
		this.subscriptions.add(channel);
	}

	unsubscribe(channel: URI): void {
		this.subscriptions.delete(channel);
	}

	isSubscribed(channel: URI): boolean {
		return this.subscriptions.has(channel);
	}
}
