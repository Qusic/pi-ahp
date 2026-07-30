/**
 * WebSocket transport.
 *
 * AHP does not mandate a transport — anything reliable, ordered, bidirectional,
 * and message-framed works. WebSocket is the conventional choice and what the
 * reference host uses: one JSON-RPC message per text frame.
 *
 * Access control to the endpoint itself is a transport concern, handled here
 * during the HTTP upgrade rather than inside the protocol.
 *
 * @see https://microsoft.github.io/agent-host-protocol/specification/transport
 */

import { createServer, type Server as HttpServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import type { Transport } from "../core/connection.ts";
import type { AhpHost } from "../core/host.ts";
import type { JsonRpcMessage } from "../protocol/jsonrpc.ts";

export interface WebSocketTransportOptions {
	readonly host?: string;
	readonly port?: number;
	/** Required as `?token=` on the upgrade request when set. */
	readonly token?: string;
	readonly log?: (message: string) => void;
}

class WebSocketClientTransport implements Transport {
	readonly #socket: WebSocket;
	readonly #log: ((message: string) => void) | undefined;

	constructor(socket: WebSocket, log?: (message: string) => void) {
		this.#socket = socket;
		this.#log = log;
	}

	send(message: JsonRpcMessage): void {
		if (this.#socket.readyState === this.#socket.OPEN) {
			this.#socket.send(JSON.stringify(message));
		}
	}

	close(): void {
		this.#socket.close();
	}

	onMessage(handler: (message: unknown) => void): void {
		this.#socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
			const text = Array.isArray(data)
				? Buffer.concat(data).toString("utf8")
				: Buffer.from(data as Buffer).toString("utf8");
			try {
				handler(JSON.parse(text));
			} catch (error) {
				// A frame we cannot parse has no `id`, so there is nobody to answer.
				this.#log?.(`Dropping unparseable frame: ${String(error)}`);
			}
		});
	}

	onClose(handler: () => void): void {
		this.#socket.on("close", handler);
	}
}

export interface RunningServer {
	readonly host: string;
	readonly port: number;
	close(): Promise<void>;
}

/** Starts a WebSocket server and wires each connection into the host. */
export async function serveWebSocket(
	ahpHost: AhpHost,
	options: WebSocketTransportOptions = {},
): Promise<RunningServer> {
	const bindHost = options.host ?? "127.0.0.1";
	// Port 0 asks the OS for a free port; the caller reads the real one back.
	const bindPort = options.port ?? 0;

	const httpServer: HttpServer = createServer((_request, response) => {
		response.writeHead(426, { "Content-Type": "text/plain" });
		response.end("Upgrade required");
	});

	const wss = new WebSocketServer({ noServer: true });

	httpServer.on("upgrade", (request, socket, head) => {
		if (options.token) {
			const url = new URL(request.url ?? "/", "http://localhost");
			// `tkn` is VS Code's connection-token parameter, which its agent-host
			// client sends and does not let you rename; `token` is what the spec's
			// own examples use. Accepting both is the difference between VS Code
			// connecting and getting a 401 it cannot explain.
			const presented = url.searchParams.get("token") ?? url.searchParams.get("tkn");
			if (presented !== options.token) {
				options.log?.("Rejecting upgrade: bad token");
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit("connection", ws, request);
		});
	});

	wss.on("connection", (socket: WebSocket) => {
		ahpHost.accept(new WebSocketClientTransport(socket, options.log));
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(bindPort, bindHost, () => {
			httpServer.removeListener("error", reject);
			resolve();
		});
	});

	const address = httpServer.address();
	if (address === null || typeof address === "string") {
		throw new Error("Failed to determine the bound address");
	}

	return {
		host: bindHost,
		port: address.port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const client of wss.clients) {
					client.terminate();
				}
				wss.close(() => {
					httpServer.close(() => resolve());
				});
			}),
	};
}
