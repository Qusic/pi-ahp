/**
 * A connected client: its transport, subscriptions, and reverse-RPC state.
 *
 * `clientId` is chosen by the client at `initialize` and reused on `reconnect`,
 * so a connection object outlives a single socket.
 */

import type { URI } from "@microsoft/agent-host-protocol";
import type { JsonRpcMessage } from "../protocol/jsonrpc.ts";

/** A bidirectional, ordered, reliable message stream carrying one JSON-RPC message per frame. */
export interface Transport {
	send(message: JsonRpcMessage): void;
	close(): void;
	onMessage(handler: (message: unknown) => void): void;
	onClose(handler: () => void): void;
}

export interface ClientInfo {
	readonly name: string;
	readonly version?: string;
	readonly title?: string;
}

export class ClientConnection {
	/** Assigned at `initialize` / `reconnect`; empty until the handshake completes. */
	clientId: string;
	readonly subscriptions = new Set<URI>();

	transport: Transport;
	clientInfo: ClientInfo | undefined;
	locale: string | undefined;
	protocolVersion: string | undefined;
	/** Set once `initialize` succeeds. `ping` is answered before this flips. */
	initialized = false;
	lastSeenServerSeq = 0;

	constructor(clientId: string, transport: Transport) {
		this.clientId = clientId;
		this.transport = transport;
	}

	send(message: JsonRpcMessage): void {
		this.transport.send(message);
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
