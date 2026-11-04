import { afterEach, expect, test, vi } from "vitest";
import { answerChat, readServerConfig } from "../lib/chat-server";

const info = { version: 1, snapshot: "synthetic-v1", backend: "cpu", coverageStart: "2023-03-12T00:00:00Z", coverageEnd: "2026-11-03T12:30:00Z", updatedAt: "2026-11-03T12:45:00Z", latestMessageAt: "2026-11-03T12:29:59Z", messageCount: 100, capabilities: { structured: true } };
const message = (id = "10", timestamp = "2026-11-02T12:00:00Z") => ({ messageId: id, timestamp, channelId: "2", channel: "announcements", authorId: "3", author: "researcher", threadId: null, text: `Synthetic evidence ${id}`, url: `https://discord.com/channels/1/2/${id}` });
const config = (extra = {}) => readServerConfig({ OPENROUTER_API_KEY: "SYNTHETIC_KEY", OPENROUTER_MODEL: "meta/muse-spark-1.3-contributor", MCP_RAG_URL: "http://127.0.0.1:8765/mcp", MCP_RAG_TOOL: "search_discord", ...extra });
const question = (text = "2026-11-02 do you have something of that date?") => [{ role: "user" as const, content: text }];
type Call = { name: string; arguments: Record<string, unknown> };
function fixture(options: { status?: unknown; tools?: string[]; page?: (call: Call) => unknown; model?: (index: number) => unknown } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-03T13:00:00Z"));
  const calls: Call[] = [], models: Record<string, any>[] = [];
  const names = options.tools ?? ["corpus_info", "search_messages", "list_messages", "get_message", "get_thread", "run_shell"];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://openrouter.ai/")) {
      models.push(body);
      return Response.json(options.model?.(models.length) ?? { choices: [{ finish_reason: "stop", message: { content: "Evidence from the requested interval [1]." } }], usage: { completion_tokens: 30 } });
    }
    let result: unknown;
    if (body.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Not supported" } });
    if (body.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } };
    else if (body.method === "tools/list") result = { tools: names.map(name => {
      const filters = { since: { type: "string" }, until: { type: "string" }, channel: { type: "string" }, author: { type: "string" } };
      const properties = name === "corpus_info" ? {} : name === "search_messages" ? { ...filters, query: { type: "string" }, limit: { type: "integer" } }
        : name === "list_messages" ? { ...filters, cursor: { type: "string" }, limit: { type: "integer" } }
        : name === "get_thread" ? { ...filters, message_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer" } }
        : { ...filters, message_id: { type: "string" } };
      return { name, inputSchema: { type: "object", properties, required: name === "search_messages" ? ["query"] : ["get_message", "get_thread"].includes(name) ? ["message_id"] : [] }, annotations: { readOnlyHint: name !== "run_shell", destructiveHint: name === "run_shell" } };
    }) };
    else if (body.method === "tools/call") {
      calls.push(body.params);
      const structuredContent = body.params.name === "corpus_info" ? (options.status ?? info)
        : options.page?.(body.params) ?? { version: 1, snapshot: info.snapshot, messages: [message()], nextCursor: null, exhaustive: body.params.name !== "search_messages" };
      result = { content: [], structuredContent };
    } else if (body.id === undefined) return new Response(null, { status: 202 });
    else throw new Error("Unexpected synthetic request");
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  return { calls, models };
}
afterEach(() => { vi.useRealTimers(); });

test.each([
  ["What changed in ink detection?", "The contributor released a new ink map [1].\n\nThese are highlights from the available excerpts, not a complete ranking."],
  ["¿Qué cambió en la detección de tinta?", "El autor publicó un nuevo mapa de tinta [1].\n\nSon hallazgos de los fragmentos disponibles, no una revisión exhaustiva."],
])("partial research keeps the answer and its language without adding a second warning: %s", async (questionText, answer) => {
  const { models } = fixture({ model: () => ({ choices: [{ finish_reason: "stop", message: { content: answer } }], usage: { completion_tokens: 60 } }) });
  const reply = await answerChat(question(questionText), config({ MCP_RAG_RESEARCH: "1" }), AbortSignal.timeout(5000));
  expect(reply.message).toBe(answer);
  expect(reply.research).toMatchObject({ complete: false, absenceVerified: false, state: "partial", reviewed: 1 });
  expect(reply.sources.map(source => source.id)).toEqual(["1"]);
  expect(models).toHaveLength(1);
});

test("research distinguishes server-validated status from untrusted source content", async () => {
  const { models } = fixture({ model: index => index === 1
    ? { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "open-source", type: "function", function: { name: "get_message", arguments: '{"message_id":"10"}' } }] } }], usage: { completion_tokens: 30 } }
    : { choices: [{ finish_reason: "stop", message: { content: "Finding [1]." } }], usage: { completion_tokens: 30 } },
  });
  await answerChat(question("What supports this ink finding?"), config({ MCP_RAG_RESEARCH: "1" }), AbortSignal.timeout(5000));
  const userContext = models[0].messages.at(-1).content;
  const metadata = userContext.split("SERVER-VALIDATED RESEARCH STATUS (JSON):\n")[1]?.split("\nCURRENT RESEARCH EVIDENCE (JSON):\n")[0];
  expect(metadata).toBeDefined();
  expect(JSON.parse(metadata)).toMatchObject({ scope: { timeZone: "UTC" }, research: { absenceVerified: false } });
  expect(models[0].messages[0].content).toMatch(/source content.*untrusted/i);
  expect(models[0].messages[0].content).toMatch(/server.*cannot.*widen/i);
});

test("a simple greeting does not search the corpus or display research warnings and citations", async () => {
  const { calls, models } = fixture({ model: () => ({ choices: [{ finish_reason: "stop", message: { content: "Hi! What would you like to explore?" } }], usage: { completion_tokens: 20 } }) });
  const reply = await answerChat(question("Hi"), config({ MCP_RAG_RESEARCH: "1" }), AbortSignal.timeout(5000));
  expect(reply.message).toBe("Hi! What would you like to explore?");
  expect(reply.sources).toEqual([]);
  expect(reply.research).toBeUndefined();
  expect(calls).toHaveLength(0);
  expect(models).toHaveLength(1);
  expect(models[0].messages[0].content).not.toContain("searches the RAG afresh on every turn");
  expect(models[0].messages.at(-1).content).toContain("No document search was needed or performed");
});

test("daily highlights enumerate only today's messages before generation", async () => {
  const { calls } = fixture({
    page: () => ({ version: 1, snapshot: info.snapshot, messages: [message("10", "2026-11-03T12:00:00Z")], nextCursor: null, exhaustive: true }),
  });
  const reply = await answerChat(question("What are the best posts of the day?"), config({ MCP_RAG_RESEARCH: "1" }), AbortSignal.timeout(5000));
  expect(calls.map(call => call.name)).toEqual(["corpus_info", "list_messages"]);
  expect(calls[1].arguments).toMatchObject({ since: "2026-11-03T00:00:00.000Z", until: "2026-11-04T00:00:00.000Z" });
  expect(reply.sources.map(source => source.date)).toEqual(["2026-11-03"]);
});

test("final synthesis fits the input budget without replaying superseded tool transcripts", async () => {
  let nextId = 1000;
  const { models } = fixture({
    page: call => ({ version: 1, snapshot: info.snapshot, messages: Array.from({ length: Number(call.arguments.limit ?? 10) }, () => ({ ...message(String(nextId++)), text: "é".repeat(400) })), nextCursor: null, exhaustive: false }),
    model: index => index < 3
      ? { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: `refine-${index}`, type: "function", function: { name: "search_messages", arguments: '{"query":"ink","limit":20}' } }] } }], usage: { completion_tokens: 30 } }
      : { choices: [{ finish_reason: "stop", message: { content: "A useful synthesis from current evidence [1]." } }], usage: { completion_tokens: 40 } },
  });
  const reply = await answerChat(question("Which ink findings matter?"), config({ MCP_RAG_RESEARCH: "1" }), AbortSignal.timeout(5000));
  expect(reply.message).toContain("A useful synthesis");
  expect(reply.research?.modelCalls).toBe(3);
  expect(reply.research?.state).not.toBe("budget_exhausted");
  expect(models[2].messages.some((message: { role: string }) => message.role === "tool")).toBe(false);
  expect(models.reduce((bytes, payload) => bytes + new TextEncoder().encode(JSON.stringify({ messages: payload.messages, ...(payload.tools ? { tools: payload.tools } : {}) })).byteLength + 256, 0)).toBeLessThanOrEqual(65536);
});

test("Nov 2 regression sends an exact half-open interval, never five semantically similar dates", async () => {
  const { calls, models } = fixture();
  const reply = await answerChat(question(), config(), AbortSignal.timeout(5000));
  expect(calls.map(call => call.name)).toEqual(["corpus_info", "list_messages"]);
  expect(calls[1].arguments).toMatchObject({ since: "2026-11-02T00:00:00.000Z", until: "2026-11-03T00:00:00.000Z" });
  expect(calls[1].arguments).not.toHaveProperty("query");
  expect(reply.sources[0].date).toBe("2026-11-02");
  expect(reply.research).toMatchObject({ backend: "cpu", timeZone: "UTC", timezoneFallback: true, reviewed: 1, absenceVerified: false });
  expect(models).toHaveLength(1);
  expect(models[0].model).toBe("meta/muse-spark-1.3-contributor");
  expect(models[0].prompt_cache_key).toBe("vesuvius-rag-genius-muse-cache-v1");
  expect(models[0].provider).toEqual({ data_collection: "allow", zdr: false });
});

test("configured timezone and exact author/channel filters survive chat to MCP", async () => {
  const { calls } = fixture();
  await answerChat(question("List messages on 2026-11-02 in #announcements by @researcher"), config({ CHAT_TIME_ZONE: "America/Argentina/Buenos_Aires" }), AbortSignal.timeout(5000));
  expect(calls[1].arguments).toMatchObject({ since: "2026-11-02T03:00:00.000Z", until: "2026-11-03T03:00:00.000Z", channel: "announcements", author: "researcher" });
});

test("empty fully enumerated covered interval is distinguished from sampled absence, without generation", async () => {
  const { models } = fixture({ page: () => ({ version: 1, snapshot: info.snapshot, messages: [], nextCursor: null, exhaustive: true }) });
  const reply = await answerChat(question(), config(), AbortSignal.timeout(5000));
  expect(reply.research).toMatchObject({ complete: true, absenceVerified: true, reviewed: 0 });
  expect(reply.message).toMatch(/indexed|snapshot/i);
  expect(models).toHaveLength(0);
});

test("a date outside coverage is not an empty-result claim or a provider call", async () => {
  const { calls, models } = fixture();
  const reply = await answerChat(question("List messages on 2027-01-01"), config(), AbortSignal.timeout(5000));
  expect(reply.research).toMatchObject({ state: "outside_coverage", absenceVerified: false });
  expect(calls.map(call => call.name)).toEqual(["corpus_info"]);
  expect(models).toHaveLength(0);
});

test("old snapshot timestamps are disclosed, not replaced with the current search time", async () => {
  fixture({ status: { ...info, updatedAt: "2026-10-01T00:00:00Z" }, page: () => ({ version: 1, snapshot: info.snapshot, messages: [], nextCursor: null, exhaustive: true }) });
  const reply = await answerChat(question(), config(), AbortSignal.timeout(5000));
  expect(reply.research).toMatchObject({ stale: true, absenceVerified: false, updatedAt: "2026-10-01T00:00:00Z" });
  expect(reply.message).toMatch(/partial|stale|cannot establish/i);
});

test("unsupported deployed query-only tools never silently substitute unfiltered retrieval", async () => {
  const { calls, models } = fixture({ tools: ["search_discord", "corpus_status"] });
  await expect(answerChat(question(), config(), AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 503, code: "rag_capability_unavailable" });
  expect(calls).toHaveLength(0); expect(models).toHaveLength(0);
});

test("a failed corpus service is not reported as an empty interval", async () => {
  const { models } = fixture({ status: { result: "PRIVATE_UPSTREAM_ERROR" } });
  await expect(answerChat(question(), config(), AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 503, code: "rag_unavailable" });
  expect(models).toHaveLength(0);
});

test("an invalid or ambiguous date asks for clarification before any upstream work", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const reply = await answerChat(question("List messages 03/04/2026"), config(), AbortSignal.timeout(5000));
  expect(reply.research).toMatchObject({ state: "clarification", absenceVerified: false });
  expect(fetch).not.toHaveBeenCalled();
});

test("bounded research opens a known message, refines a query, then answers using only allowed tools", async () => {
  const { calls, models } = fixture({ model: index => index < 3 ? {
    choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: `call-${index}`, type: "function", function: { name: index === 1 ? "get_message" : "search_messages", arguments: JSON.stringify(index === 1 ? { message_id: "10" } : { query: "refined ink evidence" }) } }] } }], usage: { completion_tokens: 50 },
  } : { choices: [{ finish_reason: "stop", message: { content: "Refined answer [1]." } }], usage: { completion_tokens: 40 } } });
  const reply = await answerChat(question("What supports the ink hypothesis?"), config({ MCP_RAG_RESEARCH: "1" }), AbortSignal.timeout(5000));
  expect(calls.map(call => call.name)).toEqual(["corpus_info", "search_messages", "get_message", "search_messages"]);
  expect(models).toHaveLength(3);
  expect(models[0].tools.map((tool: any) => tool.function.name)).toEqual(["search_messages", "list_messages", "get_message", "get_thread"]);
  expect(models[2]).not.toHaveProperty("tools");
  expect(models[2].messages[0].content).toMatch(/No further tools are available.*answer now/i);
  expect(models.map(payload => payload.max_tokens)).toEqual([3200, 3150, 3100]);
  expect(models.every(payload => payload.model === "meta/muse-spark-1.3-contributor")).toBe(true);
  expect(reply.message).toContain("Refined answer");
  expect(reply.research?.modelCalls).toBe(3);
});

test("model attempts to run a shell or widen a date filter do not dispatch such requests", async () => {
  const { calls } = fixture({ model: index => index === 1 ? {
    choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "bad", type: "function", function: { name: "run_shell", arguments: '{"command":"PRIVATE_SENTINEL"}' } }] } }], usage: { completion_tokens: 20 },
  } : { choices: [{ finish_reason: "stop", message: { content: "Bounded answer [1]." } }], usage: { completion_tokens: 20 } } });
  await answerChat(question(), config(), AbortSignal.timeout(5000));
  expect(calls.every(call => call.name !== "run_shell")).toBe(true);
});

test("a backend returning another date is a protocol failure, not accepted evidence", async () => {
  const { models } = fixture({ page: () => ({ version: 1, snapshot: info.snapshot, messages: [message("10", "2025-11-02T00:00:00Z")], nextCursor: null, exhaustive: true }) });
  await expect(answerChat(question(), config(), AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 503, code: "rag_unavailable" });
  expect(models).toHaveLength(0);
});

test("chronological enumeration stops at 100 results and visibly reports unreviewed pages", async () => {
  let page = 0;
  const { calls, models } = fixture({ page: () => { page++; return { version: 1, snapshot: info.snapshot, messages: Array.from({ length: 20 }, (_, index) => message(String(1000 + (page - 1) * 20 + index))), nextCursor: `next-${page}`, exhaustive: false }; } });
  const reply = await answerChat(question(), config(), AbortSignal.timeout(5000));
  expect(calls.length).toBeLessThanOrEqual(8);
  expect(reply.research).toMatchObject({ reviewed: 100, complete: false, absenceVerified: false, hasMore: true });
  expect(reply.research?.notice).toMatch(/partial|budget|more|sample/i);
  expect(reply.sources.length).toBeLessThanOrEqual(5);
  expect(models).toHaveLength(1);
});

test("aggregate generation budget stops research before another tool or model call", async () => {
  const { calls, models } = fixture({ model: () => ({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "last-token", type: "function", function: { name: "get_message", arguments: '{"message_id":"10"}' } }] } }], usage: { completion_tokens: 3200 } }) });
  const reply = await answerChat(question(), config(), AbortSignal.timeout(5000));
  expect(reply.research).toMatchObject({ state: "budget_exhausted", absenceVerified: false });
  expect(models).toHaveLength(1);
  expect(calls.map(call => call.name)).toEqual(["corpus_info", "list_messages"]);
});

test("a valid but large history cannot exceed the conservative research input-token budget", async () => {
  const { models } = fixture();
  const history = [{ role: "user" as const, content: "字".repeat(5000) }, { role: "assistant" as const, content: "字".repeat(15000) }, ...question()];
  const reply = await answerChat(history, config(), AbortSignal.timeout(5000));
  expect(models).toHaveLength(0);
  expect(reply.research).toMatchObject({ state: "budget_exhausted", absenceVerified: false, modelCalls: 0 });
});

test("repeated model tool requests remain inside both call and generation budgets", async () => {
  const { calls, models } = fixture({ model: index => ({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: Array.from({ length: 4 }, (_, i) => ({ id: `repeat-${index}-${i}`, type: "function", function: { name: "get_message", arguments: '{"message_id":"10"}' } })) } }], usage: { completion_tokens: 30 } }) });
  const reply = await answerChat(question(), config(), AbortSignal.timeout(5000));
  expect(calls.length).toBeLessThanOrEqual(8);
  expect(models).toHaveLength(3);
  expect(reply.research).toMatchObject({ state: "budget_exhausted", absenceVerified: false });
});

test.each([{}, { id: "bad", type: "function", function: { name: "get_message", arguments: "{}" } }])("malformed tool responses fail safely rather than becoming final evidence: %#", async invalid => {
  fixture({ model: () => ({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [invalid] } }], usage: { completion_tokens: 10 } }) });
  await expect(answerChat(question(), config(), AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 502, code: "model_invalid_response" });
});
