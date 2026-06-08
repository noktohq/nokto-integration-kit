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

### `docs/api-integration-principles.md`

Design guidelines for external API integrations: timeouts, retries, rate limiting, webhook verification, error handling, logging, and Shopify-specific rules.

