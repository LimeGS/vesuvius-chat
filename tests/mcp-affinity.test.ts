import { createServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { handleMcp } from "../lib/mcp-server";
import { initializeQuotaDatabase } from "../scripts/init-quota.mjs";

const servers: HttpServer[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function backend() {
  const state = { failed: false, requests: 0, calls: 0, snapshot: 1 };
  const server = createServer(async (req, res) => {
    state.requests++;
    if (state.failed) { res.writeHead(503).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let text = ""; for await (const part of req) text += part;
    const body = JSON.parse(text);
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    let response;
    if (body.method === "initialize") response = { result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } } };
    else if (body.method === "tools/list") response = { result: { tools: [{ name: "list_messages", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", properties: { since: { type: "string" }, cursor: { type: "string" } }, additionalProperties: false } }] } };
    else if (body.method === "tools/call") {
      state.calls++;
      const args = body.params.arguments;
      const binding = `${state.snapshot}:${args.since}`;
      const error = args.cursor && args.cursor !== binding;
      response = { result: error ? { isError: true, content: [{ type: "text", text: "Cursor changed" }] } : { structuredContent: { messages: [], nextCursor: args.cursor ? null : binding }, content: [] } };
    } else response = { error: { code: -32601, message: "Unsupported" } };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...response }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { state, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` };
}
function settings(url: string) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-affinity-")); directories.push(directory);
  const database = join(directory, "quotas.sqlite"); initializeQuotaDatabase(database);
  return { INVITATION_CODES: JSON.stringify(["a".repeat(32)]), SESSION_SECRET: "s".repeat(48), MCP_RAG_URL: url, LIMITS_DB_PATH: database };
}
function packet(env: Record<string, unknown>, method: string, params: unknown, token = "a".repeat(32)) {
  return handleMcp(new Request("http://127.0.0.1/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env);
}

test("real HTTP primary cursors never fall back and changed filters or snapshot fail closed", async () => {
  const primary = await backend(), backup = await backend();
  const env = { ...settings(backup.url), MCP_RAG_PRIMARY_URL: primary.url };
  const params = { name: "list_messages", arguments: { since: "2026-11-02" } };
  const first = await (await packet(env, "tools/call", params)).json();
  const cursor = first.result.structuredContent.nextCursor;
  expect(typeof cursor).toBe("string"); expect(primary.state.calls).toBe(1);
  primary.state.failed = true;
  const next = await (await packet(env, "tools/call", { ...params, arguments: { ...params.arguments, cursor } })).json();
  expect(next.result.isError).toBe(true); expect(backup.state.requests).toBe(0);
  primary.state.failed = false;
  const changed = await (await packet(env, "tools/call", { ...params, arguments: { since: "2026-11-01", cursor } })).json();
  expect(changed.result.isError).toBe(true);
  primary.state.snapshot++;
  const replaced = await (await packet(env, "tools/call", { ...params, arguments: { ...params.arguments, cursor } })).json();
  expect(replaced.result.isError).toBe(true); expect(backup.state.requests).toBe(0);
});

test("revocation and protocol or invalid-token floods never reach a backend or alter persisted quotas", async () => {
  const upstream = await backend(), env = settings(upstream.url);
  const read = () => { const db = new DatabaseSync(env.LIMITS_DB_PATH); try { return db.prepare("select state from quotas where id=1").get()?.state; } finally { db.close(); } };
  const before = read();
  for (let i = 0; i < 12; i++) {
    expect((await packet(env, "tools/list", {}, "wrong")).status).toBe(401);
    expect((await packet(env, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).status).toBe(200);
  }
  expect((await packet({ ...env, INVITATION_CODES: JSON.stringify(["b".repeat(32)]) }, "tools/list", {})).status).toBe(401);
  expect(upstream.state.requests).toBe(0); expect(read()).toBe(before);
});
