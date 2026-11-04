import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeQuotaDatabase } from "../scripts/init-quota.mjs";

try {
  const directory = resolve(process.env.STATE_DIR || "/state");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const access = resolve(directory, "access.json");
  if (!existsSync(access)) writeFileSync(access, JSON.stringify({ INVITATION_CODES: JSON.stringify([randomBytes(32).toString("base64url")]), SESSION_SECRET: randomBytes(48).toString("base64url") }), { mode: 0o600, flag: "wx" });
  const credentials = JSON.parse(readFileSync(access, "utf8"));
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(credentials.SESSION_SECRET) || !Array.isArray(JSON.parse(credentials.INVITATION_CODES))) throw new Error();
  const database = resolve(directory, "quotas.sqlite");
  if (!existsSync(database)) initializeQuotaDatabase(database);
  for (const path of [directory, access, database]) {
    chmodSync(path, path === directory ? 0o700 : 0o600);
    if (process.getuid?.() === 0 && process.env.DOCKER_INIT_ONLY !== "1") chownSync(path, 1000, 1000);
  }
  Object.assign(process.env, credentials, { LIMITS_DB_PATH: database, MCP_RAG_URL: "http://127.0.0.1:8765/mcp", MCP_RAG_TOOL: "search_discord", MCP_RAG_RESEARCH: "1", HOSTNAME: "0.0.0.0", PORT: "3000" });
  if (!process.env.APP_ORIGIN || !process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL) throw new Error();
  if (process.env.DOCKER_INIT_ONLY !== "1") {
    if (process.getuid?.() === 0) { process.setgid(1000); process.setuid(1000); }
    await import(pathToFileURL(resolve(process.env.APP_SERVER || ".next/standalone/server.js")).href);
  }
} catch {
  console.error(JSON.stringify({ event: "app.start_failed", code: "configuration_unavailable" }));
  process.exitCode = 1;
}
