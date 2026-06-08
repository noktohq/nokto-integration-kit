# API Integration Principles

Design guidelines for external API integrations at Nokto.

---

## API style

- Use REST for external services that do not offer GraphQL.
- Use GraphQL with codegen and typed operations for Shopify and other GraphQL APIs.
- Choose one style per integration â€” do not mix REST and GraphQL against the same service.

---

## Ground rules

- All API calls that involve secrets or private data happen server-side.
- Every API call has an explicit timeout.
- Every API call has explicit error handling.
- All error codes from external APIs map to internal error codes.
- No unhandled promise rejections.
- No silent failures.
- Validate all external responses against the expected schema when they affect business logic.

---

## Security

- API keys and secrets live in environment variables only.
- No secrets in client bundles.
- No secrets in URL parameters.
- No secrets in logs.
- No secrets in commit history.
- Verify token expiry before calls where possible.
- Rotate tokens regularly where the provider supports it.
- Prefer short-lived tokens.

---

## Timeouts

- Always set an explicit timeout per call.
- Default: 10 seconds for synchronous calls.
- Default: 30 seconds for async or heavy operations.
- Catch timeout errors explicitly â€” distinguish from network errors and API errors.
- Log timeouts with provider name and endpoint.

---

## Retry

- Retry only when safe (idempotent calls).
- Do not retry POST without an idempotency key.
- Use exponential backoff: base 1 s, multiplier 2, max 3 attempts.
- Add jitter to avoid thundering herd.
- Do not retry 4xx errors â€” they are client errors, not transient.
- On 429: respect the `Retry-After` header.
- On 503: retry with backoff.
- Log every retry attempt with attempt number and reason.

---

## Rate limiting

- Always respect `X-RateLimit-*` headers.
- Respect `Retry-After` headers.
- Implement client-side rate limiting for services with low limits.
- Use a queue or throttle where burst calls are possible.
- Log rate-limit hits â€” they indicate a design problem.

---

## Webhooks

- Verify webhook signatures before processing.
- Use HMAC-SHA256 where supported.
- Reject webhooks without a valid signature with 401.
- Make webhook handlers idempotent â€” handle the same event ID multiple times without side effects.
- Block replay by checking event ID or timestamp; reject events older than 5 minutes.
- Log event ID, request ID, provider, status, and latency for all webhooks.
- Do not log payloads containing PII.
- Return 200 quickly â€” process asynchronously where possible.
- Do not return 500 for business logic errors â€” return 200 and log the failure.

---

## Error handling

- Every expected error has its own handler.
- Every unexpected error is caught at the boundary and mapped to an internal error code.
- Raw exceptions do not propagate to the client.
- Error responses have a stable structure.
- Error responses have a machine-readable error code.
- Error responses do not leak internal stack traces.
- Error responses do not leak API keys or tokens.
- Error responses include a request ID for tracing.

---

## Logging

- Log all external calls with: provider, endpoint, method, status code, latency, request ID.
- Do not log payloads that may contain PII.
- Do not log full request bodies by default.
- Do not log tokens or keys.
- Use structured JSON logging.
- Separate success and error metrics.
- Track p95 latency per external service.

---

## REST

- Use correct HTTP verbs: GET (read), POST (create), PUT (replace), PATCH (partial update), DELETE.
- Use correct HTTP status codes in your own APIs.
- Send `Content-Type: application/json` always.
- Send `Accept: application/json` when expecting JSON.
- Use query parameters for filtering and pagination.
- Use cursor-based pagination for large datasets.
- Validate input server-side.
- Validate responses against schema.

---

## GraphQL

- Use codegen for typed operations.
- Never send raw query strings without typing.
- Use fragments for repeated fields.
- Do not over-fetch â€” request only fields you use.
- Use variables â€” not string interpolation in queries.
- Validate schema against server periodically.
- Catch GraphQL errors in the `errors` field, not just `data`.
- Log operation name and variables (without PII) on failure.

---

## Shopify Admin API

- Admin API: server-side only.
- Storefront API: server-side when using secrets; client-side only with public tokens.
- Admin token is never exposed to the client.
- API version: `2026-01`.
- Handle `X-Shopify-Shop-Api-Call-Limit` header.
- Handle throttling with backoff.
- Verify Shopify webhooks with HMAC-SHA256 via `X-Shopify-Hmac-Sha256`.
- Make Shopify webhook handlers idempotent.

---

## Contract testing

- Provide contract tests when an external client consumes your API.
- Use Pact or OpenAPI-based contract tests.
- Run contract tests in CI.
- Contract test failures block CI.

---

## OpenAPI

- Provide an OpenAPI spec when delivering a public REST API.
- The spec is the machine-readable source of truth.
- Validate API responses against the spec in tests.
- Generate the spec from code where possible â€” do not maintain it by hand.

