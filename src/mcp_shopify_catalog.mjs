// MCP proxy for the Shopify Catalog API.
// Handles token refresh automatically — consumers just send JSON-RPC 2.0 over stdio.
//
// Required env vars:
//   SHOPIFY_CLIENT_ID     — OAuth client ID
//   SHOPIFY_CLIENT_SECRET — OAuth client secret
//
// Usage:
//   node src/mcp_shopify_catalog.mjs
//
// Protocol: one JSON-RPC 2.0 message per line, one HTTP POST upstream per
// message. Batches (JSON arrays) are rejected; MCP removed JSON-RPC batching
// in protocol version 2025-06-18. Notifications are forwarded but never
// answered. Responses sent by the client are ignored.

import { pathToFileURL } from "node:url";

export const TOKEN_URL = "https://api.shopify.com/auth/access_token";
export const MCP_URL = "https://discover.shopifyapps.com/global/mcp";

const TOKEN_TIMEOUT_MS = 10_000;
const MCP_TIMEOUT_MS = 30_000;
const REFRESH_MARGIN_MS = 100_000;

/** Largest accepted stdin message (one line), in bytes. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Largest accepted upstream response body, in bytes. */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

/**
 * An error whose message is safe to return to the client: it never contains
 * tokens, credentials, headers or raw upstream bodies.
 */
class ProxyError extends Error {}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(id) {
  // MCP request ids are strings or numbers; null is not allowed.
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

/**
 * Classify one parsed message.
 * Returns { kind: "request" | "notification" | "response" | "invalid", id }.
 */
function classifyMessage(message) {
  if (!isPlainObject(message)) return { kind: "invalid", id: null };

  const hasId = Object.hasOwn(message, "id");
  const id = hasId && isValidId(message.id) ? message.id : null;

  if (
    !Object.hasOwn(message, "method") &&
    hasId &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
  ) {
    return { kind: "response", id };
  }
  if (message.jsonrpc !== "2.0") return { kind: "invalid", id };
  if (typeof message.method !== "string" || message.method === "") return { kind: "invalid", id };
  if (Object.hasOwn(message, "params") && (message.params === null || typeof message.params !== "object")) {
    return { kind: "invalid", id };
  }
  if (!hasId) return { kind: "notification", id: null };
  if (id === null) return { kind: "invalid", id: null };
  return { kind: "request", id };
}

function isTimeout(err) {
  return err?.name === "TimeoutError" || err?.name === "AbortError";
}

/** Read a response body as text, refusing more than `maxBytes`. */
async function readBodyText(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ProxyError("Upstream response too large");
  }
  if (!res.body) return "";

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ProxyError("Upstream response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function discardBody(res) {
  await res.body?.cancel().catch(() => {});
}

function defaultLog(message) {
  process.stderr.write(`[mcp-shopify-catalog] ${message}\n`);
}

/**
 * Build a proxy bound to one set of credentials.
 * `fetchImpl`, `now` and `log` are injectable so the behaviour can be tested
 * offline. Log lines never contain tokens, credentials or upstream bodies.
 */
export function createProxy({
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = defaultLog,
  tokenTimeoutMs = TOKEN_TIMEOUT_MS,
  mcpTimeoutMs = MCP_TIMEOUT_MS,
  maxMessageBytes = MAX_MESSAGE_BYTES,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (!clientId || !clientSecret) {
    throw new Error("SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set.");
  }

  let cachedToken = null;
  let tokenExpiresAt = 0;
  let pendingRefresh = null;

  async function fetchToken() {
    let res;
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "client_credentials",
        }),
        signal: AbortSignal.timeout(tokenTimeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) {
        log(`token request to ${TOKEN_URL} timed out after ${tokenTimeoutMs} ms`);
        throw new ProxyError("Token fetch timed out");
      }
      log(`token request to ${TOKEN_URL} failed: ${err?.name ?? "Error"}`);
      throw new ProxyError("Token fetch failed");
    }

    if (!res.ok) {
      await discardBody(res);
      log(`token request to ${TOKEN_URL} returned HTTP ${res.status}`);
      throw new ProxyError(`Token fetch failed: ${res.status}`);
    }

    let data;
    try {
      data = JSON.parse(await readBodyText(res, MAX_TOKEN_RESPONSE_BYTES));
    } catch (err) {
      if (isTimeout(err)) throw new ProxyError("Token fetch timed out");
      log(`token response from ${TOKEN_URL} was not valid JSON`);
      throw new ProxyError("Token response was invalid");
    }
    if (!isPlainObject(data) || typeof data.access_token !== "string" || !data.access_token) {
      log(`token response from ${TOKEN_URL} had no access_token`);
      throw new ProxyError("Token response was invalid");
    }

    const expiresIn = Number(data.expires_in ?? 3600);
    cachedToken = data.access_token;
    // An unusable expires_in means: use the token now, but do not cache it.
    tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : 0;
    return cachedToken;
  }

  async function getToken() {
    // Re-use cached token until 100 s before expiry
    if (cachedToken && now() < tokenExpiresAt - REFRESH_MARGIN_MS) {
      return cachedToken;
    }
    // Concurrent callers share one refresh. It is cleared when it settles, so
    // a failed refresh is retried by the next call instead of sticking.
    if (!pendingRefresh) {
      pendingRefresh = fetchToken().finally(() => {
        pendingRefresh = null;
      });
    }
    return pendingRefresh;
  }

  /**
   * POST one JSON-RPC message upstream. Returns the upstream JSON-RPC
   * response, a JSON-RPC error for upstream HTTP errors, or null when the
   * upstream sends no body (e.g. 202 for a notification). Throws a
   * ProxyError (safe message) for token, transport and parse failures.
   * The call is never retried: its side effects upstream are unknown.
   */
  async function forwardToShopify(rpcRequest) {
    const requestId = isPlainObject(rpcRequest) && isValidId(rpcRequest.id) ? rpcRequest.id : null;
    const token = await getToken();

    let res;
    try {
      res = await fetchImpl(MCP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(rpcRequest),
        signal: AbortSignal.timeout(mcpTimeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) {
        log(`request to ${MCP_URL} timed out after ${mcpTimeoutMs} ms`);
        throw new ProxyError("Upstream request timed out");
      }
      log(`request to ${MCP_URL} failed: ${err?.name ?? "Error"}`);
      throw new ProxyError("Upstream request failed");
    }

    if (!res.ok) {
      await discardBody(res);
      if (res.status === 401 && cachedToken === token) {
        // Token revoked or expired early: fetch a new one on the next call.
        cachedToken = null;
        tokenExpiresAt = 0;
      }
      log(`request to ${MCP_URL} returned HTTP ${res.status}`);
      return rpcError(requestId, INTERNAL_ERROR, `Shopify responded ${res.status}`);
    }

    let text;
    try {
      text = await readBodyText(res, maxResponseBytes);
    } catch (err) {
      if (err instanceof ProxyError) {
        log(`response from ${MCP_URL} exceeded ${maxResponseBytes} bytes`);
        throw err;
      }
      if (isTimeout(err)) {
        log(`response from ${MCP_URL} timed out after ${mcpTimeoutMs} ms`);
        throw new ProxyError("Upstream request timed out");
      }
      log(`reading response from ${MCP_URL} failed: ${err?.name ?? "Error"}`);
      throw new ProxyError("Upstream request failed");
    }
    if (text.trim() === "") return null;

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      log(`response from ${MCP_URL} was not valid JSON (HTTP ${res.status})`);
      throw new ProxyError("Invalid response from upstream");
    }
    return body;
  }

  function isMatchingResponse(body, id) {
    return (
      isPlainObject(body) &&
      body.jsonrpc === "2.0" &&
      body.id === id &&
      (Object.hasOwn(body, "result") || isPlainObject(body.error))
    );
  }

  /**
   * Handle one stdio line. Returns the JSON-RPC response object, or null when
   * nothing must be written (blank line, notification, client response).
   * Never throws: invalid input and upstream failures become JSON-RPC errors
   * with normalized messages.
   */
  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    if (Buffer.byteLength(trimmed, "utf8") > maxMessageBytes) {
      log(`rejected message larger than ${maxMessageBytes} bytes`);
      return rpcError(null, INVALID_REQUEST, "Invalid Request");
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return rpcError(null, PARSE_ERROR, "Parse error");
    }

    if (Array.isArray(message)) {
      log("rejected JSON-RPC batch: batches are not supported");
      return rpcError(null, INVALID_REQUEST, "Invalid Request");
    }

    const { kind, id } = classifyMessage(message);

    if (kind === "invalid") {
      log("rejected invalid JSON-RPC message");
      return rpcError(id, INVALID_REQUEST, "Invalid Request");
    }

    if (kind === "response") {
      log("ignored JSON-RPC response from client: no request is pending upstream");
      return null;
    }

    if (kind === "notification") {
      try {
        await forwardToShopify(message);
      } catch (err) {
        const reason = err instanceof ProxyError ? err.message : "Upstream request failed";
        log(`notification was not delivered: ${reason}`);
      }
      return null;
    }

    try {
      const response = await forwardToShopify(message);
      if (!isMatchingResponse(response, id)) {
        if (response !== null) log(`response from ${MCP_URL} did not match request id`);
        else log(`response from ${MCP_URL} had no body for a request`);
        return rpcError(id, INTERNAL_ERROR, "Invalid response from upstream");
      }
      return response;
    } catch (err) {
      const safe = err instanceof ProxyError ? err.message : "Upstream request failed";
      if (!(err instanceof ProxyError)) log(`unexpected proxy error: ${err?.name ?? "Error"}`);
      return rpcError(id, INTERNAL_ERROR, safe);
    }
  }

  return { getToken, forwardToShopify, handleLine };
}

/**
 * Split a stream of text chunks into lines without buffering a line beyond
 * `maxLineBytes`. Oversized lines are dropped and reported via `onOversize`.
 */
export function createLineSplitter({ maxLineBytes, onLine, onOversize }) {
  let buffer = "";
  let bufferBytes = 0;
  let dropping = false;

  function emit(line) {
    if (dropping) {
      dropping = false;
      onOversize();
      return;
    }
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  function append(text) {
    if (dropping) return;
    bufferBytes += Buffer.byteLength(text, "utf8");
    if (bufferBytes > maxLineBytes) {
      buffer = "";
      bufferBytes = 0;
      dropping = true;
      return;
    }
    buffer += text;
  }

  return {
    push(chunk) {
      let start = 0;
      let newline;
      while ((newline = chunk.indexOf("\n", start)) !== -1) {
        append(chunk.slice(start, newline));
        const line = buffer;
        buffer = "";
        bufferBytes = 0;
        emit(line);
        start = newline + 1;
      }
      append(chunk.slice(start));
    },
    end() {
      if (dropping || buffer !== "") {
        const line = buffer;
        buffer = "";
        bufferBytes = 0;
        emit(line);
      }
    },
  };
}

export function main(env = process.env) {
  let proxy;
  try {
    proxy = createProxy({
      clientId: env.SHOPIFY_CLIENT_ID,
      clientSecret: env.SHOPIFY_CLIENT_SECRET,
    });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  const write = (response) => {
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  };

  const splitter = createLineSplitter({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine: (line) => {
      proxy.handleLine(line).then(write, (err) => {
        defaultLog(`unexpected proxy error: ${err?.name ?? "Error"}`);
      });
    },
    onOversize: () => {
      defaultLog(`rejected message larger than ${MAX_MESSAGE_BYTES} bytes`);
      write(rpcError(null, INVALID_REQUEST, "Invalid Request"));
    },
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => splitter.push(chunk));
  process.stdin.on("end", () => splitter.end());
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
