// MCP proxy for the Shopify Catalog API.
// Handles token refresh automatically — consumers just send JSON-RPC 2.0 over stdio.
//
// Required env vars:
//   SHOPIFY_CLIENT_ID     — OAuth client ID
//   SHOPIFY_CLIENT_SECRET — OAuth client secret
//
// Usage:
//   node src/mcp_shopify_catalog.mjs

import { createInterface } from "readline";
import { pathToFileURL } from "node:url";

export const TOKEN_URL = "https://api.shopify.com/auth/access_token";
export const MCP_URL = "https://discover.shopifyapps.com/global/mcp";

const TOKEN_TIMEOUT_MS = 10_000;
const MCP_TIMEOUT_MS = 30_000;
const REFRESH_MARGIN_MS = 100_000;

/**
 * Build a proxy bound to one set of credentials.
 * `fetchImpl` and `now` are injectable so the behaviour can be tested offline.
 */
export function createProxy({
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (!clientId || !clientSecret) {
    throw new Error("SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set.");
  }

  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    // Re-use cached token until 100 s before expiry
    if (cachedToken && now() < tokenExpiresAt - REFRESH_MARGIN_MS) {
      return cachedToken;
    }

    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiresAt = now() + (data.expires_in ?? 3600) * 1000;
    return cachedToken;
  }

  async function forwardToShopify(rpcRequest) {
    const token = await getToken();

    const res = await fetchImpl(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(rpcRequest),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });

    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpcRequest.id ?? null,
        error: {
          code: -32603,
          message: `Shopify responded ${res.status}: ${await res.text()}`,
        },
      };
    }

    return res.json();
  }

  /**
   * Handle one stdio line. Returns the JSON-RPC response object, or null for
   * a blank line. Never throws: transport and upstream failures become
   * JSON-RPC errors so the consumer always gets an answer.
   */
  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
    }

    try {
      return await forwardToShopify(request);
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32603, message: String(err) },
      };
    }
  }

  return { getToken, forwardToShopify, handleLine };
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

  const rl = createInterface({ input: process.stdin });

  rl.on("line", async (line) => {
    const response = await proxy.handleLine(line);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
