import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { retrieveDocuments } from "../lib/rag";

let local: ReturnType<typeof parseEnv> = {};
try { local = parseEnv(await readFile(".env.local", "utf8")); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const config = { ...local, ...process.env };
config.MCP_RAG_URL ||= "http://127.0.0.1:8765/mcp";
const started = Date.now();
const documents = await retrieveDocuments({ url: config.MCP_RAG_URL, token: config.MCP_RAG_TOKEN, tool: config.MCP_RAG_TOOL || "search_discord" }, process.argv.slice(2).join(" ") || "ink detection scroll 1447", AbortSignal.timeout(180_000));
assert.ok(documents.length, "The smoke-test query must return at least one source.");
assert.ok(documents.length <= 5);
assert.ok(documents.reduce((total, doc) => total + doc.text.length, 0) <= 16_000);
assert.ok(documents.every(doc => doc.text.length <= 4_000 && doc.title));
console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - started, sources: documents.map(({ id, title, url }) => ({ id, title, url })) }, null, 2));
