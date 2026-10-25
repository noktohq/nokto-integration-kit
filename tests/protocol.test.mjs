import { test } from "node:test";
import assert from "node:assert/strict";
import { createProxy, createLineSplitter, MCP_URL, TOKEN_URL } from "../src/mcp_shopify_catalog.mjs";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A fetch double that records calls and answers from a queue of handlers. */
function fakeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected fetch to ${url}`);
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function makeProxy(handlers, options = {}) {
  const { fetchImpl, calls } = fakeFetch(handlers);
  const logs = [];
  const proxy = createProxy({
    clientId: "id",
    clientSecret: "client-secret-value",
    fetchImpl,
    log: (message) => logs.push(message),
    ...options,
  });
  return { proxy, calls, logs };
}

const token = () => jsonResponse({ access_token: "tok-SECRET", expires_in: 3600 });
const invalidRequest = (id = null) => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32600, message: "Invalid Request" },
});

// ── Envelope validation before .id / forwarding ─────────────────────────────

test("handleLine('null') answers Invalid Request instead of throwing", async () => {
  const { proxy, calls } = makeProxy([]);
  assert.deepEqual(await proxy.handleLine("null"), invalidRequest());
  assert.equal(calls.length, 0, "nothing is sent upstream");
});

for (const line of ["42", '"text"', "true", "[]", '[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]']) {
  test(`non-object or batch message ${line} is Invalid Request with id null`, async () => {
    const { proxy, calls } = makeProxy([]);
    const response = await proxy.handleLine(line);
    assert.equal(response.id, null);
    assert.equal(response.error.code, -32600);
    assert.equal(calls.length, 0);
  });
}

for (const [name, message, expectedId] of [
  ["missing jsonrpc", { id: 5, method: "tools/list" }, 5],
  ["wrong jsonrpc version", { jsonrpc: "1.0", id: "a", method: "tools/list" }, "a"],
  ["missing method", { jsonrpc: "2.0", id: 6 }, 6],
  ["non-string method", { jsonrpc: "2.0", id: 7, method: 42 }, 7],
  ["empty method", { jsonrpc: "2.0", id: 8, method: "" }, 8],
  ["scalar params", { jsonrpc: "2.0", id: 9, method: "tools/call", params: "x" }, 9],
  ["null params", { jsonrpc: "2.0", id: 10, method: "tools/call", params: null }, 10],
  ["object id", { jsonrpc: "2.0", id: { a: 1 }, method: "tools/list" }, null],
  ["null id", { jsonrpc: "2.0", id: null, method: "tools/list" }, null],
  ["boolean id", { jsonrpc: "2.0", id: true, method: "tools/list" }, null],
  ["invalid notification", { jsonrpc: "2.0", method: 1, params: "bar" }, null],
  ["empty object", {}, null],
]) {
  test(`invalid request (${name}) is answered with -32600 and is not forwarded`, async () => {
    const { proxy, calls } = makeProxy([]);
    const response = await proxy.handleLine(JSON.stringify(message));
    assert.deepEqual(response, invalidRequest(expectedId));
    assert.equal(calls.length, 0);
  });
}

test("valid notifications are forwarded and never answered", async () => {
  const { proxy, calls } = makeProxy([token, () => new Response(null, { status: 202 })]);
  const response = await proxy.handleLine(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  assert.equal(response, null);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, MCP_URL);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
});

test("a failing notification is logged, not answered", async () => {
  const { proxy, logs } = makeProxy([token, () => new Response("down tok-SECRET", { status: 503 })]);
  const response = await proxy.handleLine(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }),
  );
  assert.equal(response, null);
  assert.ok(logs.some((l) => l.includes("503")));
  assert.ok(logs.every((l) => !l.includes("tok-SECRET")));
});

test("JSON-RPC responses from the client are ignored, not forwarded", async () => {
  const { proxy, calls, logs } = makeProxy([]);
  assert.equal(await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })), null);
  assert.equal(
    await proxy.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "x" } }),
    ),
    null,
  );
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 2);
});

test("oversized lines are rejected before parsing or forwarding", async () => {
  const { proxy, calls } = makeProxy([], { maxMessageBytes: 64 });
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { q: "x".repeat(100) } });
  assert.deepEqual(await proxy.handleLine(line), invalidRequest());
  assert.equal(calls.length, 0);
});

test("valid requests are forwarded unchanged", async () => {
  const { proxy, calls } = makeProxy([
    token,
    () => jsonResponse({ jsonrpc: "2.0", id: "req-1", result: { ok: true } }),
  ]);
  const request = { jsonrpc: "2.0", id: "req-1", method: "tools/call", params: { name: "search" } };
  assert.deepEqual(await proxy.handleLine(JSON.stringify(request)), {
    jsonrpc: "2.0",
    id: "req-1",
    result: { ok: true },
  });
  assert.deepEqual(JSON.parse(calls[1].init.body), request);
});

// ── Shared token refresh ─────────────────────────────────────────────────────

test("three concurrent getToken calls share one token request", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { proxy, calls } = makeProxy([
    async () => {
      await gate;
      return jsonResponse({ access_token: "tok-1", expires_in: 3600 });
    },
  ]);
  const pending = [proxy.getToken(), proxy.getToken(), proxy.getToken()];
  release();
  assert.deepEqual(await Promise.all(pending), ["tok-1", "tok-1", "tok-1"]);
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1);
});

test("concurrent requests share one token request", async () => {
  const { proxy, calls } = makeProxy([
    token,
    () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),
    () => jsonResponse({ jsonrpc: "2.0", id: 2, result: {} }),
    () => jsonResponse({ jsonrpc: "2.0", id: 3, result: {} }),
  ]);
  const lines = [1, 2, 3].map((id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }));
  const responses = await Promise.all(lines.map((l) => proxy.handleLine(l)));
  assert.deepEqual(
    responses.map((r) => r.id),
    [1, 2, 3],
  );
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1);
});

test("a failed shared refresh rejects all waiters and the next call tries again", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { proxy, calls } = makeProxy([
    async () => {
      await gate;
      return new Response("bad client", { status: 401 });
    },
    () => jsonResponse({ access_token: "tok-2", expires_in: 3600 }),
  ]);
  const pending = [proxy.getToken(), proxy.getToken(), proxy.getToken()];
  release();
  const results = await Promise.allSettled(pending);
  assert.ok(results.every((r) => r.status === "rejected"));
  assert.equal(calls.length, 1);

  assert.equal(await proxy.getToken(), "tok-2");
  assert.equal(calls.length, 2);
});

test("a token response without access_token is an error, not 'Bearer undefined'", async () => {
  const { proxy, calls } = makeProxy([() => jsonResponse({ expires_in: 3600 })]);
  const response = await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  assert.equal(response.id, 1);
  assert.equal(response.error.code, -32603);
  assert.equal(calls.length, 1, "nothing is forwarded without a token");
});

test("a numeric-string expires_in is still cached", async () => {
  const { proxy, calls } = makeProxy([() => jsonResponse({ access_token: "tok-s", expires_in: "3600" })]);
  assert.equal(await proxy.getToken(), "tok-s");
  assert.equal(await proxy.getToken(), "tok-s");
  assert.equal(calls.length, 1);
});

test("an unusable expires_in is used once but not cached", async () => {
  const { proxy, calls } = makeProxy([
    () => jsonResponse({ access_token: "tok-a", expires_in: "soon" }),
    () => jsonResponse({ access_token: "tok-b", expires_in: 3600 }),
  ]);
  assert.equal(await proxy.getToken(), "tok-a");
  assert.equal(await proxy.getToken(), "tok-b");
  assert.equal(calls.length, 2);
});

test("a 401 from the MCP endpoint drops the cached token without retrying the call", async () => {
  const { proxy, calls } = makeProxy([
    token,
    () => new Response("expired", { status: 401 }),
    () => jsonResponse({ access_token: "tok-new", expires_in: 3600 }),
    () => jsonResponse({ jsonrpc: "2.0", id: 2, result: {} }),
  ]);
  const first = await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  assert.equal(first.error.code, -32603);
  assert.equal(calls.length, 2, "the forwarded call is not retried");

  await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assert.equal(calls[2].url, TOKEN_URL);
  assert.equal(calls[3].init.headers.Authorization, "Bearer tok-new");
});

// ── Normalized errors and limits ─────────────────────────────────────────────

test("errors never expose tokens, secrets or raw upstream bodies", async () => {
  const { proxy, logs } = makeProxy([
    () => new Response("invalid client-secret-value detail", { status: 401 }),
    token,
    () => new Response("upstream says tok-SECRET", { status: 503 }),
  ]);
  const request = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });

  const tokenFailure = await proxy.handleLine(request(1));
  assert.deepEqual(tokenFailure, {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Token fetch failed: 401" },
  });

  const upstreamFailure = await proxy.handleLine(request(2));
  assert.deepEqual(upstreamFailure, {
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32603, message: "Shopify responded 503" },
  });

  const everything = JSON.stringify([tokenFailure, upstreamFailure, logs]);
  for (const secret of ["client-secret-value", "tok-SECRET", "detail", "upstream says"]) {
    assert.ok(!everything.includes(secret), `${secret} leaked`);
  }
});

test("an upstream timeout is reported as a timeout", async () => {
  const { proxy, logs } = makeProxy(
    [
      token,
      (url, init) =>
        new Promise((_, reject) => {
          // AbortSignal.timeout uses an unref'd timer; keep the loop alive like stdin does.
          const keepAlive = setTimeout(() => reject(new Error("timeout signal never fired")), 5000);
          init.signal.addEventListener("abort", () => {
            clearTimeout(keepAlive);
            reject(init.signal.reason);
          });
        }),
    ],
    { mcpTimeoutMs: 20 },
  );
  const response = await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }));
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 4,
    error: { code: -32603, message: "Upstream request timed out" },
  });
  assert.ok(logs.some((l) => l.includes("timed out") && l.includes(MCP_URL)));
});

test("a non-JSON upstream body becomes a normalized error with the request id", async () => {
  const { proxy } = makeProxy([token, () => new Response("<html>gateway</html>", { status: 200 })]);
  const response = await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }));
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32603, message: "Invalid response from upstream" },
  });
});

for (const [name, body] of [
  ["null", null],
  ["array", [{ jsonrpc: "2.0", id: 6, result: {} }]],
  ["mismatched id", { jsonrpc: "2.0", id: 999, result: {} }],
  ["no result or error", { jsonrpc: "2.0", id: 6 }],
]) {
  test(`an upstream JSON-RPC response with ${name} is rejected`, async () => {
    const { proxy } = makeProxy([token, () => jsonResponse(body)]);
    const response = await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }));
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32603, message: "Invalid response from upstream" },
    });
  });
}

test("an oversized upstream response is rejected", async () => {
  const big = { jsonrpc: "2.0", id: 7, result: { blob: "x".repeat(2000) } };
  const { proxy } = makeProxy([token, () => jsonResponse(big)], { maxResponseBytes: 1000 });
  const response = await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }));
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32603, message: "Upstream response too large" },
  });
});

test("an oversized streamed upstream response without content-length is rejected", async () => {
  const chunk = new TextEncoder().encode("x".repeat(600));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const { proxy } = makeProxy([token, () => new Response(stream, { status: 200 })], {
    maxResponseBytes: 1000,
  });
  const response = await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }));
  assert.equal(response.error.message, "Upstream response too large");
});

test("upstream HTTP errors are not retried", async () => {
  const { proxy, calls } = makeProxy([token, () => new Response("busy", { status: 503 })]);
  await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call" }));
  assert.equal(calls.filter((c) => c.url === MCP_URL).length, 1);
});

// ── stdin line splitting with a size limit ───────────────────────────────────

test("line splitter handles chunk boundaries, CRLF and a final line without newline", () => {
  const lines = [];
  const splitter = createLineSplitter({ maxLineBytes: 100, onLine: (l) => lines.push(l), onOversize: () => {} });
  splitter.push('{"a":');
  splitter.push('1}\r\n{"b":2}\n\n');
  splitter.push('{"c":3}');
  splitter.end();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', "", '{"c":3}']);
});

test("line splitter drops oversized lines without buffering them and recovers", () => {
  const lines = [];
  let oversize = 0;
  const splitter = createLineSplitter({
    maxLineBytes: 10,
    onLine: (l) => lines.push(l),
    onOversize: () => oversize++,
  });
  splitter.push("x".repeat(8));
  splitter.push("y".repeat(8));
  splitter.push("z".repeat(1000));
  splitter.push("\nok\n");
  splitter.push("æøå".repeat(4) + "\n");
  splitter.end();
  assert.deepEqual(lines, ["ok"]);
  assert.equal(oversize, 2);
});
