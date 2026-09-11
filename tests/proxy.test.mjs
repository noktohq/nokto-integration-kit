import { test } from "node:test";
import assert from "node:assert/strict";
import { createProxy, TOKEN_URL, MCP_URL } from "../src/mcp_shopify_catalog.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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

const creds = { clientId: "id", clientSecret: "secret" };

test("refuses to start without credentials", () => {
  assert.throws(() => createProxy({}), /SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set/);
  assert.throws(() => createProxy({ clientId: "id" }), /must be set/);
});

test("token is fetched with client credentials and cached until near expiry", async () => {
  let clock = 1_000_000;
  const { fetchImpl, calls } = fakeFetch([
    () => jsonResponse({ access_token: "tok-1", expires_in: 3600 }),
    () => jsonResponse({ access_token: "tok-2", expires_in: 3600 }),
  ]);
  const proxy = createProxy({ ...creds, fetchImpl, now: () => clock });

  assert.equal(await proxy.getToken(), "tok-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKEN_URL);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    client_id: "id",
    client_secret: "secret",
    grant_type: "client_credentials",
  });
  assert.ok(calls[0].init.signal instanceof AbortSignal, "token request carries a timeout signal");

  // 3400 s later: still inside the 100 s margin → cached
  clock += 3400 * 1000;
  assert.equal(await proxy.getToken(), "tok-1");
  assert.equal(calls.length, 1);

  // 3501 s after issue: past the margin → refreshed
  clock += 101 * 1000;
  assert.equal(await proxy.getToken(), "tok-2");
  assert.equal(calls.length, 2);
});

test("token fetch failure throws and nothing is cached", async () => {
  const { fetchImpl, calls } = fakeFetch([
    () => new Response("bad client", { status: 401 }),
    () => jsonResponse({ access_token: "tok-ok" }),
  ]);
  const proxy = createProxy({ ...creds, fetchImpl });

  await assert.rejects(proxy.getToken(), /Token fetch failed: 401 bad client/);
  assert.equal(await proxy.getToken(), "tok-ok");
  assert.equal(calls.length, 2);
});

test("requests are forwarded with a bearer token and the upstream body is returned", async () => {
  const { fetchImpl, calls } = fakeFetch([
    () => jsonResponse({ access_token: "tok-1", expires_in: 3600 }),
    () => jsonResponse({ jsonrpc: "2.0", id: 7, result: { tools: [] } }),
  ]);
  const proxy = createProxy({ ...creds, fetchImpl });

  const request = { jsonrpc: "2.0", id: 7, method: "tools/list" };
  const response = await proxy.forwardToShopify(request);

  assert.deepEqual(response, { jsonrpc: "2.0", id: 7, result: { tools: [] } });
  assert.equal(calls[1].url, MCP_URL);
  assert.equal(calls[1].init.headers.Authorization, "Bearer tok-1");
  assert.deepEqual(JSON.parse(calls[1].init.body), request);
  assert.ok(calls[1].init.signal instanceof AbortSignal, "MCP request carries a timeout signal");
});

test("upstream HTTP errors become JSON-RPC errors that keep the request id", async () => {
  const { fetchImpl } = fakeFetch([
    () => jsonResponse({ access_token: "tok-1" }),
    () => new Response("upstream down", { status: 503 }),
  ]);
  const proxy = createProxy({ ...creds, fetchImpl });

  const response = await proxy.forwardToShopify({ jsonrpc: "2.0", id: "abc", method: "x" });
  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: "abc",
    error: { code: -32603, message: "Shopify responded 503: upstream down" },
  });
});

test("handleLine: blank lines are ignored and malformed JSON is a parse error", async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const proxy = createProxy({ ...creds, fetchImpl });

  assert.equal(await proxy.handleLine("   "), null);
  assert.deepEqual(await proxy.handleLine("{not json"), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });
  assert.equal(calls.length, 0, "nothing is sent upstream");
});

test("handleLine: transport failures never throw; they answer as JSON-RPC errors", async () => {
  const { fetchImpl } = fakeFetch([
    () => {
      throw new Error("The operation was aborted due to timeout");
    },
  ]);
  const proxy = createProxy({ ...creds, fetchImpl });

  const response = await proxy.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "x" }));
  assert.equal(response.id, 3);
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /aborted due to timeout/);
});
