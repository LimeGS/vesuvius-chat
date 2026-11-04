// Public read-only gateway. Invitation credentials never reach the private backend.
import { Server, WebStandardStreamableHTTPServerTransport, type Tool, type CallToolResult } from "@modelcontextprotocol/server";
import { Ajv } from "@modelcontextprotocol/server/validators/ajv";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireMcpToken } from "./auth";
import { ChatError, readJsonRequest, readServerConfig } from "./chat-server";
import { reserveLimit } from "./limits";
import { ragEndpoint, withRagClient } from "./rag";

const names = new Set(["search_discord", "corpus_status", "corpus_info", "search_messages", "list_messages", "get_message", "get_thread"]);
const toolError = (): CallToolResult => ({ isError: true, content: [{ type: "text", text: "Retrieval unavailable or invalid arguments. Start a fresh search if the snapshot or cursor changed." }] });

export async function handleMcp(request: Request, bindings: Record<string, unknown>): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  let release: (() => Promise<void>) | undefined;
  let server: Server | undefined;
  const timeout = AbortSignal.timeout(180_000);
  try {
    await requireMcpToken(request, bindings);
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...Object.fromEntries(headers), Allow: "POST" } });
    const signal = AbortSignal.any([request.signal, timeout]);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ChatError(415, "Expected JSON.");
    const body = await readJsonRequest(request, signal) as Record<string, any>;
    signal.throwIfAborted();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChatError(400, "Expected one MCP request.");
    const config = readServerConfig(bindings);
    if (!config.ragUrl) throw new ChatError(503, "Retrieval is not configured.");
    const urls = [ragEndpoint(config.ragUrl).href, ...(config.ragPrimaryUrl ? [ragEndpoint(config.ragPrimaryUrl).href] : [])];
    let backend = urls.length - 1, pinned = false;
    const secret = String(bindings.SESSION_SECRET);
    const signature = (payload: string, index: number) => createHmac("sha256", secret).update(`${urls[index]}:${payload}`).digest("base64url");
    const args = body.params?.arguments;
    if (body.method === "tools/call" && names.has(body.params?.name)) {
      if (args?.cursor != null) {
        try {
          if (typeof args.cursor !== "string" || args.cursor.length > 4096) throw new Error();
          const [payload, mac, extra] = args.cursor.split(".");
          const data = JSON.parse(Buffer.from(payload, "base64url").toString());
          if (extra || !Number.isInteger(data.backend) || !urls[data.backend] || data.tool !== body.params.name || typeof data.cursor !== "string") throw new Error();
          const actual = Buffer.from(mac || ""), expected = Buffer.from(signature(payload, data.backend));
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
          backend = data.backend; pinned = true; args.cursor = data.cursor;
        } catch { return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: toolError() }, { headers }); }
      }
      release = await reserveLimit(request, bindings, "mcp");
    }
    async function upstream<T>(work: Parameters<typeof withRagClient<T>>[2]): Promise<T> {
      const attempt = (index: number, bounded: boolean) => withRagClient({ url: urls[index], tool: config.ragTool, token: config.ragToken }, bounded ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : signal, work);
      try { return await attempt(backend, backend === 1 && !pinned); }
      catch {
        if (pinned || backend === 0 || signal.aborted) throw new Error("Retrieval unavailable");
        backend = 0; return attempt(0, false);
      }
    }
    const catalog = async () => upstream(async client => {
      const result = await client.listTools({}, { signal, timeout: 10_000 });
      return result.tools.filter(tool => names.has(tool.name) && tool.annotations?.destructiveHint !== true).map(tool => ({ ...tool, annotations: { ...tool.annotations, readOnlyHint: true, destructiveHint: false } }));
    });
    server = new Server({ name: "vesuvius-discord-rag", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: "Read-only Discord research. Search results are samples, not proof of absence. Preserve date/author/channel scope and original citations." });
    server.onerror = () => {};
    server.setRequestHandler("tools/list", async () => {
      try { return { tools: await catalog() as Tool[] }; }
      catch { throw new Error("Retrieval unavailable"); }
    });
    server.setRequestHandler("tools/call", async input => {
      if (!names.has(input.params.name)) return toolError();
      try {
        const tool = (await catalog()).find(t => t.name === input.params.name);
        if (!tool || !new Ajv({ strict: false }).compile(tool.inputSchema)(input.params.arguments || {})) return toolError();
        // Once discovery succeeds, never replay a dispatched tool on another backend.
        pinned = true;
        const result = await upstream(client => client.callTool({ name: input.params.name, arguments: input.params.arguments }, { signal, timeout: 180_000, maxTotalTimeout: 180_000 }));
        if (result.isError) return toolError();
        const data = result.structuredContent;
        if (data && typeof data === "object" && "nextCursor" in data && typeof data.nextCursor === "string") {
          const payload = Buffer.from(JSON.stringify({ backend, tool: input.params.name, cursor: data.nextCursor })).toString("base64url");
          const wrapped = { ...data, nextCursor: `${payload}.${signature(payload, backend)}` };
          return { structuredContent: wrapped, content: [{ type: "text", text: JSON.stringify(wrapped) }] };
        }
        return result;
      } catch { return toolError(); }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65_536 });
    await server.connect(transport);
    const result = await transport.handleRequest(request, { parsedBody: body });
    const text = await result.text();
    if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new Error("Result too large");
    for (const [key, value] of result.headers) headers.set(key, value);
    return new Response(text || null, { status: result.status, headers });
  } catch (error) {
    const status = request.signal.aborted ? 499 : timeout.aborted ? 504 : error instanceof SyntaxError ? 400 : error instanceof ChatError ? error.status : 503;
    if (status === 401) headers.set("WWW-Authenticate", 'Bearer realm="vesuvius-mcp"');
    if (error instanceof ChatError && error.retryAfter) headers.set("Retry-After", String(error.retryAfter));
    return Response.json({ error: status === 401 ? "A valid invitation bearer token is required." : "MCP request unavailable or invalid." }, { status, headers });
  } finally { await server?.close().catch(() => {}); await release?.().catch(() => {}); }
}
