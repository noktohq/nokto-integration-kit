import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MAX_MESSAGE_BYTES } from "../src/mcp_shopify_catalog.mjs";

const entry = fileURLToPath(new URL("../src/mcp_shopify_catalog.mjs", import.meta.url));
const stub = new URL("./fixtures/fake-fetch.mjs", import.meta.url).href;

function runProxy(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", stub, entry], {
      env: { PATH: process.env.PATH, SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "secret-value" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("stdio: invalid, oversized and valid messages are answered without crashing", async () => {
  const input = [
    "null",
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    "x".repeat(MAX_MESSAGE_BYTES + 10),
    "{bad",
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search" } }),
  ].join("\r\n");

  const { code, stdout, stderr } = await runProxy(input);
  assert.equal(code, 0, stderr);

  const responses = stdout.trim().split("\n").map((l) => JSON.parse(l));
  const sortKey = (r) => `${r.id}:${r.error?.code ?? ""}`;
  responses.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  assert.deepEqual(responses, [
    { jsonrpc: "2.0", id: 1, result: { method: "tools/list" } },
    { jsonrpc: "2.0", id: 3, result: { method: "tools/call" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
  ]);
  assert.ok(!stderr.includes("secret-value") && !stderr.includes("stub-token"));
});
