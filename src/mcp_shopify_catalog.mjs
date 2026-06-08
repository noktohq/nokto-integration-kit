// MCP proxy for the Shopify Catalog API.
// Handles token refresh automatically â€” consumers just send JSON-RPC 2.0 over stdio.
//
// Required env vars:
//   SHOPIFY_CLIENT_ID     â€” OAuth client ID
//   SHOPIFY_CLIENT_SECRET â€” OAuth client secret
//
// Usage:
//   node src/mcp_shopify_catalog.mjs

import { createInterface } from "readline";

const TOKEN_URL = "https://api.shopify.com/auth/access_token";
const MCP_URL = "https://discover.shopifyapps.com/global/mcp";

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  process.stderr.write(
    "Error: SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set.\n"
  );
  process.exit(1);
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  // Re-use cached token until 100 s before expiry
  if (cachedToken && Date.now() < tokenExpiresAt - 100_000) {
    return cachedToken;
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
}

async function forwardToShopify(rpcRequest) {
  const token = await getToken();

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(rpcRequest),
    signal: AbortSignal.timeout(30_000),
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

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }) + "\n"
    );
    return;
  }

  try {
    const response = await forwardToShopify(request);
    process.stdout.write(JSON.stringify(response) + "\n");
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32603, message: String(err) },
      }) + "\n"
    );
  }
});

