import { afterEach, expect, test, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { handleMcp } from "../lib/mcp-server";

const tools = ["corpus_info", "list_messages", "get_thread", "shell"].map(name => ({ name, inputSchema: { type: "object" as const, properties: {}, additionalProperties: false } }));
const upstream = { listTools: async () => ({ tools }), callTool: async () => ({ content: [], structuredContent: { messages: [], nextCursor: "private-cursor" } }) };
vi.mock("../lib/rag", async original => ({ ...await original<typeof import("../lib/rag")>(), withRagClient: async (_: unknown, _signal: unknown, work: (client: unknown) => unknown) => work(upstream) }));
vi.mock("../lib/limits", () => ({ reserveLimit: async () => async () => {} }));
const env = { INVITATION_CODES: JSON.stringify(["a".repeat(32)]), SESSION_SECRET: "s".repeat(48), MCP_RAG_URL: "http://127.0.0.1:8765/mcp" };
afterEach(() => vi.restoreAllMocks());

test("real MCP client negotiates, sees only safe tools and receives an authenticated opaque cursor", async () => {
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: "auto", probe: { timeoutMs: 1000, maxRetries: 0 } } });
  const transport = new StreamableHTTPClientTransport(new URL("https://chat.example/mcp"), {
    authProvider: { token: async () => "a".repeat(32) },
    fetch: async (input, init) => handleMcp(new Request(input, init), env),
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(["corpus_info", "list_messages", "get_thread"]);
    const result = await client.callTool({ name: "list_messages", arguments: {} });
    const cursor = (result.structuredContent as Record<string, unknown>)?.nextCursor;
    expect(typeof cursor).toBe("string"); expect(cursor).not.toBe("private-cursor");
    expect(result.content).not.toEqual([]);
    const bad = await client.callTool({ name: "shell", arguments: {} });
    expect(bad.isError).toBe(true);
    const tampered = await client.callTool({ name: "list_messages", arguments: { cursor: `${cursor}x` } });
    expect(tampered.isError).toBe(true);
  } finally { await client.close(); }
});

test("MCP denies anonymous requests and caps streaming bodies before parsing", async () => {
  expect((await handleMcp(new Request("https://chat.example/mcp"), env)).status).toBe(401);
  const large = new Request("https://chat.example/mcp", { method: "POST", headers: { Authorization: `Bearer ${"a".repeat(32)}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "x".repeat(65537) });
  expect((await handleMcp(large, env)).status).toBe(413);
});

test.each(["client cancellation", "deadline"])("MCP cancels a stalled body on %s", async kind => {
  const abort = new AbortController();
  if (kind === "deadline") vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
  let cancelled = false, bodyController: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; controller.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; } });
  const request = new Request("https://chat.example/mcp", { method: "POST", body, duplex: "half", signal: kind === "client cancellation" ? abort.signal : undefined, headers: { Authorization: `Bearer ${"a".repeat(32)}`, "Content-Type": "application/json" } } as RequestInit);
  const pending = handleMcp(request, env);
  await new Promise(resolve => setTimeout(resolve, 10)); abort.abort();
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(cancelled).toBe(true);
    expect((await pending).status).toBe(kind === "client cancellation" ? 499 : 504);
  } finally { if (!cancelled) { bodyController!.close(); await pending; } }
});
