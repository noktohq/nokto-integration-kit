// Preloaded with `node --import` by tests/stdio.test.mjs: replaces the global
// fetch so the stdio entry point runs offline.
const TOKEN_URL = "https://api.shopify.com/auth/access_token";

globalThis.fetch = async (url, init) => {
  if (url === TOKEN_URL) {
    return Response.json({ access_token: "stub-token", expires_in: 3600 });
  }
  const message = JSON.parse(init.body);
  if (!Object.hasOwn(message, "id")) return new Response(null, { status: 202 });
  return Response.json({ jsonrpc: "2.0", id: message.id, result: { method: message.method } });
};
