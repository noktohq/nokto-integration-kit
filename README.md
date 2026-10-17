# nokto-integration-kit

Integration utilities and patterns used across Nokto's external API connections.

## Contents

### `src/mcp_shopify_catalog.mjs`

MCP (Model Context Protocol) proxy for the Shopify Catalog API. Handles OAuth token refresh automatically. Accepts JSON-RPC 2.0 over stdin and forwards to Shopify's MCP endpoint.

**Setup:**

```bash
export SHOPIFY_CLIENT_ID=your_client_id
export SHOPIFY_CLIENT_SECRET=your_client_secret
node src/mcp_shopify_catalog.mjs
```

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shopify-catalog": {
      "command": "node",
      "args": ["/path/to/nokto-integration-kit/src/mcp_shopify_catalog.mjs"],
      "env": {
        "SHOPIFY_CLIENT_ID": "your_client_id",
        "SHOPIFY_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

**Protocol handling:**

One JSON-RPC 2.0 message per line on stdin, one HTTP POST per message upstream. The proxy does not negotiate an MCP protocol version; `initialize` is forwarded as-is.

| Input | Result |
|---|---|
| Blank line | ignored |
| Not JSON | `-32700 Parse error`, `id: null` |
| `null`, number, string, boolean | `-32600 Invalid Request`, `id: null` |
| Batch (JSON array, also `[]`) | `-32600 Invalid Request`, `id: null`. Batching was removed from MCP in protocol version 2025-06-18 and is not supported. |
| Object without `jsonrpc: "2.0"`, without a non-empty string `method`, with non-object/array `params`, or with an `id` that is not a string or number | `-32600 Invalid Request` with the request `id` when it is a string or number, otherwise `id: null` (JSON-RPC 2.0 §5) |
| Line larger than 1 MiB | `-32600 Invalid Request`, `id: null`; the line is not buffered beyond the limit |
| Valid notification (no `id`) | forwarded; never answered, failures are logged to stderr |
| Response from the client (`id` + `result`/`error`, no `method`) | ignored and logged; there is no pending upstream request |
| Valid request | forwarded; the upstream JSON-RPC response is returned if it is an object with the same `id` and a `result` or `error` |

Upstream and token failures are answered with `-32603` and a normalized message that never contains tokens, credentials, headers or upstream bodies: `Token fetch failed: <status>`, `Token fetch timed out`, `Token response was invalid`, `Shopify responded <status>`, `Upstream request timed out`, `Upstream request failed`, `Upstream response too large`, `Invalid response from upstream`. Details (status, endpoint, error class) go to stderr without secrets.

**Limits and tokens:**

- Timeouts: 10 s for the token request, 30 s for each forwarded request (including reading the body).
- Size limits: 1 MiB per stdin message, 10 MiB per upstream response, 64 KiB per token response.
- The access token is cached until 100 s before expiry. Concurrent callers share one in-flight token request; a failed refresh is not cached, so the next call tries again. A `401` from the MCP endpoint drops the cached token.
- Forwarded calls are never retried, because their upstream side effects are unknown.

All limits and timeouts can be overridden in `createProxy({ ... })` (`tokenTimeoutMs`, `mcpTimeoutMs`, `maxMessageBytes`, `maxResponseBytes`), together with the injectable `fetchImpl`, `now` and `log`.

**Tests:**

```bash
npm test
```

50 `node:test` cases cover token acquisition, caching, shared refresh and recovery, timeouts, bearer forwarding, JSON-RPC envelope validation, notifications, normalized upstream errors, size limits, the stdin line splitter, and an end-to-end stdio run of the entry point. `fetch` is injected (or stubbed with `node --import` for the stdio run), so the suite runs offline with no credentials.

### `docs/api-integration-principles.md`

Design guidelines for external API integrations: timeouts, retries, rate limiting, webhook verification, error handling, logging, and Shopify-specific rules.

