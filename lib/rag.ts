// Server-only: never import into a client component.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ChatSource } from "./chat-types";
import { boundedResponse } from "./http";

export type RagConfig = { url: string; token?: string; tool: string };
export type RetrievedDocument = ChatSource & { text: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function ragEndpoint(value: string, allowLocal = true): URL {
  const endpoint = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if ((endpoint.protocol !== "https:" && !(allowLocal && loopback && endpoint.protocol === "http:")) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("Invalid retrieval endpoint");
  }
  return endpoint;
}

/** Application contract, not an MCP-wide convention; see README. */
export function parseDocuments(value: unknown): RetrievedDocument[] {
  if (!object(value) || !Array.isArray(value.documents)) throw new Error("Invalid retrieval result");
  const documents: RetrievedDocument[] = [];
  let remaining = 16_000;
  for (const item of value.documents) {
    if (documents.length >= 5 || remaining <= 0) break;
    if (!object(item) || typeof item.text !== "string" || typeof item.title !== "string") continue;
    const text = item.text.trim().slice(0, Math.min(4_000, remaining));
    const title = item.title.trim().slice(0, 180);
    if (!text || !title) continue;
    const date = sourceDate(item.date);
    documents.push({ id: String(documents.length + 1), title, text, url: safeUrl(item.url), ...(date ? { date } : {}) });
    remaining -= text.length;
  }
  if (value.documents.length && !documents.length) throw new Error("Invalid retrieval result");
  return documents;
}

function parseDiscordDocuments(text: string): RetrievedDocument[] {
  if (/^(?:_consulta en ingles: [^\n]*_\s*)?\((?:sin resultados|no results)\)$/.test(text.trim())) return [];
  // shortcut: this adapter follows rag.py's numbered Markdown format; use structured documents if that server changes it.
  const hits: Array<{ title: string; text: string; url: string; date?: string }> = [];
  const surrounding: typeof hits = [];
  for (const section of text.split(/^### \d+\. /m).slice(1)) {
    const newline = section.indexOf("\n");
    const title = section.slice(0, newline).trim();
    const body = section.slice(newline + 1).trim();
    const links = [...body.matchAll(/^(- (?:★ )?[^\n]*) <(https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+)>\s*$/gm)];
    const match = links.find(link => link[1].startsWith("- ★ ")) ?? links[0];
    if (newline < 0 || !title || !match) throw new Error("Invalid Discord retrieval result");
    const header = body.slice(0, body.search(/^- /m)).trim().slice(0, 1000);
    for (const link of links) {
      const message = link[1].replace(/^- (?:★ )?/, "");
      const date = message.match(/^\[(\d{4}-\d{2}-\d{2})(?: \d{2}:\d{2})?\]/)?.[1];
      const excerpt = `${header ? `Conversation context (not citable or proof of authorship):\n${header}\n` : ""}Citable message:\n${message}`;
      (link === match ? hits : surrounding).push({ title, text: excerpt, url: link[2], ...(date ? { date } : {}) });
    }
  }
  const seen = new Set<string>();
  const documents = [...hits, ...surrounding].filter(document => {
    if (seen.has(document.url)) return false;
    seen.add(document.url); return true;
  });
  if (!documents.length) throw new Error("Invalid Discord retrieval result");
  return parseDocuments({ documents });
}

export async function withRagClient<T>(config: RagConfig, signal: AbortSignal, work: (client: Client) => Promise<T>, onResponse?: (status: number) => void): Promise<T> {
  const endpoint = ragEndpoint(config.url);
  const client = new Client(
    { name: "vesuvius-challenge-genius", version: "1.0.0" },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: 10_000, maxRetries: 0 } }, listMaxPages: 4 },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    ...(config.token ? { authProvider: { token: async () => config.token! } } : {}),
    fetch: async (input, init) => {
      const response = await fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        redirect: "manual",
      });
      onResponse?.(response.status);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("Retrieval redirect refused");
      }
      return boundedResponse(response, 2 * 1024 * 1024);
    },
  });
  // Discovery can wait after HTTP 202, before the protocol client owns the transport.
  const cancelConnection = () => { void transport.close().catch(() => {}); };
  signal.addEventListener("abort", cancelConnection, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect(transport, { timeout: 10_000, maxTotalTimeout: 10_000, signal });
    return await work(client);
  } finally {
    signal.removeEventListener("abort", cancelConnection);
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

export async function retrieveDocuments(config: RagConfig, query: string, signal: AbortSignal, onResponse?: (status: number) => void): Promise<RetrievedDocument[]> {
  return withRagClient(config, signal, async client => {
    const catalog = await client.listTools({}, { timeout: 10_000, signal });
    const tool = catalog.tools.find((candidate) => candidate.name === config.tool);
    if (!tool || tool.annotations?.destructiveHint === true) throw new Error("Retrieval tool unavailable");
    // Exactly one configured retrieval tool; the model cannot select tools.
    const result = await client.callTool(
      { name: config.tool, arguments: { query } },
      { timeout: 180_000, maxTotalTimeout: 180_000, signal },
    );
    if (result.isError) throw new Error("Retrieval failed");
    if (config.tool === "search_discord") {
      const structured = result.structuredContent;
      const text = object(structured) && typeof structured.result === "string"
        ? structured.result
        : result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      return parseDiscordDocuments(text);
    }
    return parseDocuments(result.structuredContent);
  }, onResponse);
}
