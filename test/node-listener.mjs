/**
 * Node-runtime tests for the proxy listener. OpenCode Desktop loads the plugin
 * inside Electron's main process (Node, no `Bun` global); the Bun smoke suite
 * cannot cover that path. Runs against the built `dist/`.
 */
import assert from "node:assert/strict";

assert.equal(typeof globalThis.Bun, "undefined", "must run under Node");

const { listen } = await import("../dist/http-listener.js");
const { startProxy, stopProxy, getProxyPort } = await import("../dist/proxy.js");

// Proxy binds under Node and serves its model list.
const port = await startProxy();
assert.ok(port > 0, "proxy bound a port");
assert.equal(getProxyPort(), port);
const models = await fetch(`http://127.0.0.1:${port}/v1/models`);
assert.equal(models.status, 200);
const list = await models.json();
assert.equal(list.object, "list");
assert.ok(list.data.length > 0, "model list is not empty");

// A malformed completion request reaches the handler and fails loudly.
const bad = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{not json",
});
assert.equal(bad.status, 500);
await stopProxy();
assert.equal(getProxyPort(), null);

// Request body, headers, and a streamed response survive the adapter;
// a client disconnect cancels the response stream.
let cancelled = false;
const listener = await listen("127.0.0.1", 0, 0, async (req) => {
  if (req.method === "POST") {
    const body = await req.json();
    return Response.json({ echo: body.value, header: req.headers.get("x-test") });
  }
  let timer;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      timer = setInterval(
        () => controller.enqueue(new TextEncoder().encode(": ping\n\n")),
        20,
      );
    },
    cancel() {
      cancelled = true;
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
});

const echo = await fetch(`http://127.0.0.1:${listener.port}/echo`, {
  method: "POST",
  headers: { "x-test": "yes", "content-type": "application/json" },
  body: JSON.stringify({ value: 42 }),
});
assert.deepEqual(await echo.json(), { echo: 42, header: "yes" });

const abort = new AbortController();
const sse = await fetch(`http://127.0.0.1:${listener.port}/sse`, {
  signal: abort.signal,
});
assert.equal(sse.headers.get("content-type"), "text/event-stream");
const reader = sse.body.getReader();
const first = new TextDecoder().decode((await reader.read()).value);
assert.match(first, /data: first/);
abort.abort();
await reader.read().catch(() => undefined);
for (let i = 0; i < 50 && !cancelled; i++) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.ok(cancelled, "client disconnect cancels the response stream");

await listener.stop();
console.log("ok — node listener tests passed");
