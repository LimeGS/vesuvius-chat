import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, vi } from "vitest";
import { answerChat, readServerConfig } from "../lib/chat-server";
import { createRequestLog } from "../lib/logging";

// Real SDK + wire protocol; only the long SDK timers are shortened at their boundary.
async function withPendingResult(method: string, callback: (url: string, accepted: Promise<void>) => Promise<void>) {
  let accepted!: () => void;
  const pending = new Promise<void>(resolve => { accepted = resolve; });
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.method === method) { response.writeHead(202).end(); accepted(); return; }
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    const reply = rpc.method === "server/discover"
      ? { error: { code: -32601, message: "Method not found" } }
      : { result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...reply }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await callback(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, pending); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const config = (url: string) => readServerConfig({ OPENROUTER_API_KEY: "test-only", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: url, MCP_RAG_TOOL: "search_discord" });
const question = [{ role: "user" as const, content: "ink detection" }];

test.each(["initialize", "server/discover"])("cancellation interrupts a pending %s result, not just the HTTP fetch", async method => {
  const originalTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => originalTimeout(callback, Number(delay) >= 1_000 ? 250 : delay, ...args)) as typeof setTimeout);
  await withPendingResult(method, async (url, accepted) => {
    const controller = new AbortController();
    const cause = new DOMException("cancelled", "AbortError");
    const result = answerChat(question, config(url), controller.signal);
    const outcome = result.then(() => "resolved", error => error === cause ? "cancelled" : "other error");
    await accepted;
    // Let the HTTP 202 finish: the pending SDK response wait is what must abort.
    await new Promise<void>(resolve => originalTimeout(resolve, 10));
    controller.abort(cause);
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([outcome, new Promise(resolve => { guard = originalTimeout(() => resolve("still pending"), 80); })])).toBe("cancelled");
    } finally { clearTimeout(guard); await outcome; }
  });
});

test("an actual SDK tools/list timeout becomes 504/rag_timeout with a safe event", async () => {
  const originalTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => originalTimeout(callback, Number(delay) >= 1_000 ? 100 : delay, ...args)) as typeof setTimeout);
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  await withPendingResult("tools/list", async url => {
    await expect(answerChat(question, config(url), new AbortController().signal, createRequestLog("chat"))).rejects.toMatchObject({ status: 504, code: "rag_timeout", cause: { code: "REQUEST_TIMEOUT" } });
    expect(errorLog.mock.calls[0][0]).toMatchObject({ event: "dependency.failed", dependency: "rag", code: "rag_timeout", upstreamStatus: 202 });
  });
});

test("aborting pending primary MCP discovery never probes the backup or model", async () => {
  const originalFetch = globalThis.fetch;
  const backup = "http://127.0.0.1:9/mcp";
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => originalFetch(input, init));
  await withPendingResult("initialize", async (primary, accepted) => {
    const controller = new AbortController();
    const cause = new DOMException("PRIVATE_CANCEL", "AbortError");
    const settings = readServerConfig({ OPENROUTER_API_KEY: "test-only", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: backup, MCP_RAG_PRIMARY_URL: primary, MCP_RAG_TOOL: "search_discord" });
    const outcome = answerChat(question, settings, controller.signal).catch(error => error);
    await accepted;
    controller.abort(cause);
    expect(await outcome).toBe(cause);
    expect(fetch.mock.calls.some(call => String(call[0]).startsWith(backup) || String(call[0]).includes("openrouter.ai"))).toBe(false);
  });
});
