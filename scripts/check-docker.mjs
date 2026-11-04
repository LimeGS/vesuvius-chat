// Offline providers and synthetic corpus only. All created resources have a unique test project.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:https";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const root = process.cwd(), directory = await mkdtemp(path.join(process.env.OPENCODE_TMPDIR || tmpdir(), "vesuvius-docker-check-"));
const name = "vesuvius-check-" + crypto.randomUUID().slice(0, 8), marker = "SYNTHETIC_" + crypto.randomUUID();
const docker = args => execFileSync("docker", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let compose;
try {
  // Build from this checkout so verification never depends on unpublished images.
  docker(["build", "--platform", "linux/amd64", "-t", "vesuvius-public-app:check", "."]);
  docker(["build", "--platform", "linux/amd64", "-f", "docker/Dockerfile.rag", "-t", "vesuvius-public-rag:check", "."]);
  docker(["build", "--platform", "linux/amd64", "-f", "docker/Dockerfile.proxy", "-t", "vesuvius-public-proxy:check", "."]);
  // Exercise Docker's real ignore matcher, not a reimplementation of its patterns.
  const context = path.join(directory, "context"), exported = path.join(directory, "exported");
  for (const relative of ["rag/bundle/private.json", "deploy/state/ssh-key", "docker/.env", ".env.local", "node_modules/private", "app/public.ts", "rag/runtime.py", "docker/app-entrypoint.mjs", "package.json"]) {
    const file = path.join(context, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, relative);
  }
  await cp(".dockerignore", path.join(context, ".dockerignore"));
  await writeFile(path.join(context, "Dockerfile"), "FROM scratch\nCOPY . /\n");
  docker(["build", "--output", `type=local,dest=${exported}`, context]);
  for (const relative of ["app/public.ts", "rag/runtime.py", "docker/app-entrypoint.mjs", "package.json"]) assert.equal(await readFile(path.join(exported, relative), "utf8"), relative);
  for (const relative of ["rag/bundle/private.json", "deploy/state/ssh-key", "docker/.env", ".env.local", "node_modules/private"]) await assert.rejects(readFile(path.join(exported, relative)));

  const partialTls = path.join(directory, "partial-tls"); await mkdir(partialTls);
  await writeFile(path.join(partialTls, "tls.crt"), "KEEP_CUSTOM_CERTIFICATE");
  assert.throws(() => docker(["run", "--rm", "--platform", "linux/amd64", "-e", "APP_HOST=localhost:8443", "-v", `${partialTls}:/tls`, "--entrypoint", "/bin/sh", "vesuvius-public-proxy:check", "/docker-entrypoint.d/10-local-tls.sh"]), "A partial custom certificate must fail without overwriting it");
  assert.equal(await readFile(path.join(partialTls, "tls.crt"), "utf8"), "KEEP_CUSTOM_CERTIFICATE");

  const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const envFile = path.join(directory, ".env");
  await writeFile(envFile, `OPENROUTER_API_KEY=offline-dummy\nOPENROUTER_MODEL=offline/fixed-model\nDISCORD_TOKEN=offline-bot\nDISCORD_GUILD_ID=11\nDISCORD_CHANNEL_IDS=22\nAPP_HOST=localhost:${port}\nHTTPS_PORT=${port}\n`, { mode: 0o600 });
  const override = path.join(directory, "override.json");
  await writeFile(override, JSON.stringify({ services: {
    app: { image: "vesuvius-public-app:check", platform: "linux/amd64", environment: { NODE_OPTIONS: "--import /app/model-provider.mjs", TEST_CONTENT_MARKER: marker }, volumes: [{ type: "bind", source: path.join(root, "scripts/fixtures/model-provider.mjs"), target: "/app/model-provider.mjs", read_only: true }] },
    rag: { image: "vesuvius-public-rag:check", platform: "linux/amd64", command: ["python", "-B", "/app/tests/fixtures/research-server.py", "/tmp", "8765"], environment: { TEST_CONTENT_MARKER: marker }, volumes: [{ type: "bind", source: path.join(root, "tests/fixtures/research-server.py"), target: "/app/tests/fixtures/research-server.py", read_only: true }] },
    proxy: { image: "vesuvius-public-proxy:check", platform: "linux/amd64" },
  } }));
  compose = ["compose", "--project-name", name, "--project-directory", root, "--env-file", envFile, "-f", "compose.yaml", "-f", override];
  docker([...compose, "up", "-d", "--no-build", "app", "rag", "proxy"]);
  const call = (url, init = {}) => new Promise((resolve, reject) => {
    const req = request(`https://127.0.0.1:${port}${url}`, { rejectUnauthorized: false, method: init.method || "GET", headers: { Host: `localhost:${port}`, ...Object.fromEntries(new Headers(init.headers)) } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on("error", reject); req.end(init.body);
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await call("/api/status")).status === 401) break; } catch { /* readiness */ }
    if (i === 99) throw new Error("Container readiness failed");
    await delay(200);
  }
  assert.equal((await call("/mcp")).status, 401);
  const access = path.join(directory, "access.json"); docker([...compose, "cp", "app:/state/access.json", access]);
  const original = await readFile(access, "utf8"), token = JSON.parse(JSON.parse(original).INVITATION_CODES)[0];
  const agent = new Client({ name: "docker-contract", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`https://localhost:${port}/mcp`), { authProvider: { token: async () => token }, fetch: async (url, init) => call(new URL(String(url)).pathname, init) });
  try {
    await agent.connect(transport);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = (await agent.listTools()).tools.some(t => t.name === "list_messages"); } catch { /* The private Python fixture can start after Next. */ }
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, "Private Python MCP readiness");
    const result = await agent.callTool({ name: "list_messages", arguments: { since: "2026-11-02T00:00:00Z", until: "2026-11-03T00:00:00Z" } });
    assert.ok(!result.isError); assert.equal(result.structuredContent.messages.length, 20); assert.ok(result.structuredContent.nextCursor);
  } finally { await agent.close(); }
  const login = await call("/api/session", { method: "POST", headers: { Origin: `https://localhost:${port}`, "Content-Type": "application/json" }, body: JSON.stringify({ code: token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const chat = await call("/api/chat", { method: "POST", headers: { Cookie: cookie, Origin: `https://localhost:${port}`, "Content-Type": "application/json", "X-Real-IP": "spoofed" }, body: JSON.stringify({ messages: [{ role: "user", content: "List messages on 1900-01-01" }] }) });
  assert.equal(chat.status, 200); assert.equal((await chat.json()).research.modelCalls, 0);
  docker([...compose, "restart", "app"]);
  docker([...compose, "cp", "app:/state/access.json", access]); assert.equal(await readFile(access, "utf8"), original);
  const logs = docker([...compose, "logs", "--no-color", "app", "rag"]);
  assert.ok(!logs.includes(token) && !logs.includes(marker));
  console.log(JSON.stringify({ ok: true, dockerIgnorePrivacy: true, freshComposeHttps: true, invitationMcp: true, privatePythonRetrieval: true, noGenerationChat: true, restartCredentialsPreserved: true, contentFreeLogs: true }));
} finally {
  if (compose) docker([...compose, "down", "--volumes", "--remove-orphans"]);
  await rm(directory, { recursive: true, force: true });
}
