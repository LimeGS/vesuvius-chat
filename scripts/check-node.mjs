// Real compiled Node server + real SQLite; synthetic local MCP and intercepted model.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { initializeQuotaDatabase } from "./init-quota.mjs";

const directory = await mkdtemp(path.join(process.env.OPENCODE_TMPDIR || tmpdir(), "vesuvius-node-"));
const marker = `PRIVATE_CONTENT_${crypto.randomUUID()}`;
const invitation = "offline-invitation-" + "a".repeat(24);
const canonical = "https://chat.audit.invalid";
const queries = [];
const mcp = createServer(async (request, response) => {
  if (request.method === "DELETE") { response.writeHead(204).end(); return; }
  if (request.method !== "POST") { response.writeHead(405).end(); return; }
  let text = ""; for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  if (body.id === undefined) { response.writeHead(202).end(); return; }
  let reply;
  if (body.method === "server/discover") reply = { error: { code: -32601, message: "Not supported" } };
  else if (body.method === "initialize") reply = { result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } };
  else if (body.method === "tools/list") reply = { result: { tools: [{ name: "search_discord", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } }, { name: "run_shell", inputSchema: { type: "object" } }] } };
  else if (body.method === "tools/call") {
    assert.equal(body.params.name, "search_discord");
    assert.deepEqual(Object.keys(body.params.arguments), ["query"]);
    queries.push(body.params.arguments.query);
    reply = { result: { content: [], structuredContent: { result: `### 1. #synthetic\n- ★ [2025-11-03 10:00] ${marker} <https://discord.com/channels/1/2/3>` } } };
  } else throw new Error("Unexpected fixture method");
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...reply }));
});
await new Promise(resolve => mcp.listen(0, "127.0.0.1", resolve));
const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child, researchProcess, logs = "";
const env = {
  ...process.env, NODE_ENV: "production", CHAT_ENV: "production", APP_ORIGIN: canonical,
  HOSTNAME: "127.0.0.1", PORT: String(port), NEXT_TELEMETRY_DISABLED: "1",
  INVITATION_CODES: JSON.stringify([invitation]), SESSION_SECRET: "s".repeat(48),
  LIMITS_DB_PATH: path.join(directory, "quotas.sqlite"),
  OPENROUTER_API_KEY: "offline-dummy", OPENROUTER_MODEL: "offline/fixed-model",
  MCP_RAG_URL: `http://127.0.0.1:${mcp.address().port}/mcp`, MCP_RAG_PRIMARY_URL: "", MCP_RAG_TOOL: "search_discord", MCP_RAG_TOKEN: "",
  TEST_CONTENT_MARKER: marker,
};
async function start() {
  child = spawn("python3", ["deploy/run-service.py", process.execPath, "--import", fileURLToPath(new URL("./fixtures/model-provider.mjs", import.meta.url)), ".next/standalone/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Node server exited: ${child.exitCode}`);
    try { if ((await call("/api/status")).status === 401) return; } catch { /* wait for listener */ }
    await delay(200);
  }
  throw new Error("Node server startup timed out");
}
async function stop() { if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; } }
// Node 24 fetch ignores Host overrides; use HTTP to exercise the real proxy contract.
const call = (url, init = {}) => new Promise((resolve, reject) => {
  const outgoing = httpRequest(base + url, { method: init.method || "GET", headers: { Host: "chat.audit.invalid", "X-Forwarded-Proto": "https", "X-Real-IP": "192.0.2.1", ...init.headers } }, incoming => {
    const chunks = []; incoming.on("data", chunk => chunks.push(chunk)); incoming.on("error", reject);
    incoming.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
      resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
    });
  });
  outgoing.on("error", reject); outgoing.end(init.body);
});
const login = (code = invitation) => call("/api/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: canonical }, body: JSON.stringify({ code }) });
try {
  initializeQuotaDatabase(env.LIMITS_DB_PATH);
  await cp("public", ".next/standalone/public", { recursive: true });
  await cp(".next/static", ".next/standalone/.next/static", { recursive: true });
  await start();
  assert.equal((await call("/api/status")).status, 401);
  assert.equal((await call("/mcp")).status, 401, "Public MCP must require a bearer before protocol access");
  assert.equal((await call("/api/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.invalid" }, body: JSON.stringify({ code: invitation }) })).status, 403);
  assert.equal((await call("/", { headers: { Host: "evil.invalid" } })).status, 503);
  const home = await call("/"); assert.equal(home.status, 200);
  assert.equal(home.headers.get("cache-control"), "no-store");
  for (const [route, heading] of [["/terms", "Terms of Use"], ["/privacy", "Privacy Notice"]]) {
    const legal = await call(route); assert.equal(legal.status, 200, "Legal pages must be public before sign-in");
    assert.equal(legal.headers.get("cache-control"), "no-store");
    assert.ok(legal.headers.has("content-security-policy"));
    const text = await legal.text(); assert.ok(text.includes(heading));
    assert.ok(text.includes('href="/terms"') && text.includes('href="/privacy"'));
  }
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.match(home.headers.get("strict-transport-security"), /max-age=31536000/);
  const nonce = home.headers.get("content-security-policy").match(/'nonce-([^']+)'/)[1];
  const html = await home.text(); const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
  assert.ok(/<html[^>]*lang="en"/.test(html), "Production HTML must declare English");
  assert.ok(html.includes("Checking access…"), "Initial access screen must be in English");
  assert.ok(scripts.length > 0); assert.ok(scripts.every(([, attrs]) => attrs.includes(`nonce="${nonce}"`)), "All production scripts must carry the fresh nonce");
  const font = await call("/fonts/inter-latin.woff2"); assert.equal(font.status, 200); assert.equal(font.headers.get("x-content-type-options"), "nosniff");
  const entered = await login(); assert.equal(entered.status, 200);
  const cookie = entered.headers.get("set-cookie"); assert.match(cookie, /^__Host-vesuvius_session=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/i);
  const token = cookie.split(";")[0];
  const chat = content => call("/api/chat", { method: "POST", headers: { Cookie: token, Origin: canonical, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content }], model: "evil", MCP_RAG_URL: "https://evil.invalid", MCP_RAG_TOOL: "run_shell" }) });
  const status = await call("/api/status", { headers: { Cookie: token } }); assert.equal(status.status, 200);
  for (const payload of ["$(printf AUDIT); `printf AUDIT`", "'; DROP TABLE messages; --", "<img src=x onerror=alert(1)>", "../.env; ${OPENROUTER_API_KEY}", "ordinary question"]) {
    const response = await chat(`${marker} ${payload}`); assert.equal(response.status, 200, "Authenticated production chat must reach the configured local RAG/model only");
    const data = await response.json(); assert.equal(data.message, `${marker} [1]`);
    assert.equal(data.sources[0].date, "2025-11-03", "Posting date must survive real MCP retrieval, merging and HTTP serialization");
  }
  assert.equal(queries.length, 5);
  const denied = await chat(marker); assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get("retry-after")) > 0); assert.equal(queries.length, 5);
  await stop(); await start();
  assert.equal((await chat(marker)).status, 429, "Quota survives a real Node process restart");
  assert.equal(queries.length, 5);
  assert.equal((await call("/api/status", { headers: { Cookie: `${token}tampered` } })).status, 401);
  for (let i = 0; i < 4; i++) assert.equal((await login("wrong")).status, 401);
  assert.equal((await login()).status, 429);
  await stop();
  assert.ok(!logs.includes(marker), "No conversation/evidence/provider sentinel in application or framework logs");
  assert.ok(!logs.includes(invitation)); assert.ok(!logs.includes("offline-dummy"));
  for (const file of await readdir(directory)) assert.ok(!(await readFile(path.join(directory, file))).includes(Buffer.from(marker)), "No content in persistent quota state");

  // Real Python MCP/schema/SQL -> compiled route -> intercepted provider, no private corpus.
  const researchProbe = createServer();
  await new Promise(resolve => researchProbe.listen(0, "127.0.0.1", resolve));
  const researchPort = researchProbe.address().port; await new Promise(resolve => researchProbe.close(resolve));
  const researchRoot = path.join(directory, "research");
  const { mkdir } = await import("node:fs/promises"); await mkdir(researchRoot);
  researchProcess = spawn("python3", ["-B", "tests/fixtures/research-server.py", researchRoot, String(researchPort)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let researchLogs = "";
  researchProcess.stdout.on("data", chunk => { researchLogs += chunk; }); researchProcess.stderr.on("data", chunk => { researchLogs += chunk; });
  env.MCP_RAG_URL = `http://127.0.0.1:${researchPort}/mcp`; env.MCP_RAG_RESEARCH = "1";
  env.LIMITS_DB_PATH = path.join(directory, "research-quotas.sqlite"); initializeQuotaDatabase(env.LIMITS_DB_PATH);
  for (let i = 0; i < 100; i++) {
    if (researchProcess.exitCode !== null) throw new Error("Synthetic Python research MCP exited");
    try { await fetch(env.MCP_RAG_URL, { method: "OPTIONS" }); break; } catch { await delay(100); }
  }
  await start();
  const dated = await chat("2026-11-02 do you have something of that date?");
  assert.equal(dated.status, 200, "Date regression must reach real structured Python MCP, not legacy similarity search");
  const datedBody = await dated.json();
  assert.equal(datedBody.research.reviewed, 83); assert.equal(datedBody.research.complete, true);
  assert.equal(datedBody.research.absenceVerified, false); assert.equal(datedBody.sources.length, 5);
  assert.ok(datedBody.sources.every(source => source.date === "2026-11-02" && source.timestamp?.startsWith("2026-11-02T")));
  const filtered = await chat("List messages on 2026-11-02 in #announcements by @alice");
  assert.equal(filtered.status, 200); assert.equal((await filtered.json()).research.reviewed, 83);
  const empty = await chat("List messages on 2026-11-01");
  assert.equal(empty.status, 200); assert.equal((await empty.json()).research.absenceVerified, true);
  const outside = await chat("List messages on 2027-01-01");
  assert.equal(outside.status, 200); assert.equal((await outside.json()).research.state, "outside_coverage");
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const agent = new Client({ name: "native-gateway-test", version: "1" }, { versionNegotiation: { mode: "auto", probe: { timeoutMs: 1000, maxRetries: 0 } } });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    authProvider: { token: async () => invitation },
    fetch: async (input, init = {}) => call(new URL(String(input)).pathname, { ...init, headers: Object.fromEntries(new Headers(init.headers)) }),
  });
  try {
    await agent.connect(transport);
    const listed = await agent.listTools();
    assert.ok(listed.tools.some(tool => tool.name === "list_messages"));
    assert.ok(!listed.tools.some(tool => /shell|sync|embed/.test(tool.name)));
    let cursor, enumerated = 0;
    do {
      const result = await agent.callTool({ name: "list_messages", arguments: { since: "2026-11-02T00:00:00Z", until: "2026-11-03T00:00:00Z", ...(cursor ? { cursor } : {}) } });
      assert.ok(!result.isError, "Compiled public gateway must preserve private Python tool schemas and cursor scope");
      enumerated += result.structuredContent.messages.length;
      cursor = result.structuredContent.nextCursor;
    } while (cursor);
    assert.equal(enumerated, 83);
    assert.equal((await agent.callTool({ name: "run_shell", arguments: {} })).isError, true);
  } finally { await agent.close(); }
  const ended = once(researchProcess, "exit"); researchProcess.kill("SIGTERM"); await ended;
  assert.equal((await chat("List messages on 2026-11-02")).status, 503, "Service failure is not zero hits");
  await stop();
  assert.ok(!logs.includes(marker) && !logs.includes(invitation) && !researchLogs.includes(marker), "No content or invitation in either service's logs");
  console.log(JSON.stringify({ ok: true, runtime: "compiled Next/Node", tests: "authentication, CSRF, proxy trust, nonce CSP, static headers, injection boundaries, real SQLite restart quotas, content-free logs/state, real Python MCP temporal regression, filters, coverage/empty/failure distinction", network: "synthetic local MCP; model intercepted; no external model requests", temporalMessagesEnumerated: datedBody.research.reviewed, queries: queries.length, scriptsWithNonce: scripts.length }, null, 2));
} finally {
  await stop();
  if (researchProcess && researchProcess.exitCode === null && researchProcess.signalCode === null) { const ended = once(researchProcess, "exit"); researchProcess.kill("SIGTERM"); await ended; }
  await new Promise(resolve => mcp.close(resolve)); await rm(directory, { recursive: true, force: true });
}
