/**
 * Loopback HTTP listener for the OpenAI-compatible proxy.
 *
 * OpenCode loads this plugin under two runtimes: Bun (the `opencode` CLI) and
 * Node (OpenCode Desktop runs the server inside Electron's main process, where
 * the `Bun` global does not exist). Both runtimes serve the same web-standard
 * fetch handler.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export type FetchHandler = (req: Request) => Promise<Response>;

export interface HttpListener {
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * Bind `hostname:port` (port 0 picks a free port).
 * `idleTimeoutSeconds` = 0 disables the idle-socket timer.
 */
export async function listen(
  hostname: string,
  port: number,
  idleTimeoutSeconds: number,
  handler: FetchHandler,
): Promise<HttpListener> {
  if (typeof Bun !== "undefined") {
    return listenWithBun(hostname, port, idleTimeoutSeconds, handler);
  }
  return listenWithNode(hostname, port, idleTimeoutSeconds, handler);
}

function listenWithBun(
  hostname: string,
  port: number,
  idleTimeoutSeconds: number,
  handler: FetchHandler,
): HttpListener {
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: idleTimeoutSeconds,
    fetch: (req) => handler(req),
  });
  const boundPort = server.port;
  if (!boundPort) {
    server.stop(true);
    throw new Error("Failed to bind Claude proxy to a port");
  }
  return {
    port: boundPort,
    stop: async () => {
      server.stop(true);
    },
  };
}

async function listenWithNode(
  hostname: string,
  port: number,
  idleTimeoutSeconds: number,
  handler: FetchHandler,
): Promise<HttpListener> {
  const server = createServer((incoming, outgoing) => {
    void serveNodeRequest(incoming, outgoing, hostname, handler);
  });
  // Socket inactivity timer, the Node counterpart of Bun's `idleTimeout`.
  server.timeout = idleTimeoutSeconds * 1000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind Claude proxy to a port");
  }
  return {
    port: address.port,
    stop: () =>
      new Promise<void>((resolve) => {
        // Matches Bun's `stop(true)`: drop open streams instead of waiting.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function serveNodeRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  hostname: string,
  handler: FetchHandler,
): Promise<void> {
  const clientGone = new AbortController();
  outgoing.on("close", () => clientGone.abort());

  let response: Response;
  try {
    const request = await toWebRequest(incoming, hostname, clientGone.signal);
    response = await handler(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ error: { message, type: "server_error" } }));
    return;
  }

  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));
  outgoing.flushHeaders();
  if (!response.body) {
    outgoing.end();
    return;
  }

  const reader = response.body.getReader();
  // Bun cancels the response stream when the client disconnects; the proxy's
  // SSE streams rely on that cancel to stop their heartbeat and Claude turn.
  clientGone.signal.addEventListener("abort", () => {
    void reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      outgoing.write(value);
    }
    outgoing.end();
  } catch {
    outgoing.destroy();
  }
}

async function toWebRequest(
  incoming: IncomingMessage,
  hostname: string,
  signal: AbortSignal,
): Promise<Request> {
  const url = `http://${incoming.headers.host ?? hostname}${incoming.url ?? "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    signal,
    body: hasBody ? await readBody(incoming) : undefined,
  });
}

async function readBody(
  incoming: IncomingMessage,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  // Copy into an ArrayBuffer-backed view; `BodyInit` rejects Buffer's
  // `ArrayBufferLike` backing store.
  return new Uint8Array(Buffer.concat(chunks));
}
