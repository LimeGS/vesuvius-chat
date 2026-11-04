import { expect, test, vi } from "vitest";
import * as rag from "../lib/rag";
import { answerChat, readServerConfig } from "../lib/chat-server";
import { createRequestLog } from "../lib/logging";

const config = readServerConfig({ OPENROUTER_API_KEY: "SECRET_KEY", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: "https://rag.example/mcp", MCP_RAG_TOKEN: "SECRET_RAG", MCP_RAG_TOOL: "search_discord" });
const messages = [{ role: "user" as const, content: "PRIVATE_CHAT" }];

test("current server time and configured timezone accompany ordinary evidence without claiming sync freshness", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-11-03T00:30:00Z"));
    vi.spyOn(rag, "retrieveDocuments").mockResolvedValue([]);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "Synthetic response." } }] }));
    await answerChat(messages, readServerConfig({ OPENROUTER_API_KEY: "test", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: "https://rag.example/mcp", CHAT_TIME_ZONE: "America/Argentina/Buenos_Aires" }), AbortSignal.timeout(1000));
    const prompt = JSON.parse(String(fetch.mock.calls[0][1]?.body)).messages[0].content;
    expect(prompt).toContain("2026-11-03T00:30:00.000Z");
    expect(prompt).toContain("America/Argentina/Buenos_Aires");
    expect(prompt).toContain("not a synchronization timestamp");
  } finally { vi.useRealTimers(); }
});

test.each(["disconnected", "empty", "evidence"])("%s retrieval sends English instructions with a latest-user-language policy and unchanged multilingual data", async state => {
  const documents = state === "evidence" ? [{ id: "1", title: "Fuente original", text: "El ajuste espiral preserva estos datos originales." }] : [];
  vi.spyOn(rag, "retrieveDocuments").mockResolvedValue(documents);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "Synthetic response." } }] }));
  const history = [{ role: "user" as const, content: "¿Qué es spiral fit?" }, { role: "assistant" as const, content: "Respuesta anterior en español." }, { role: "user" as const, content: "What is spiral fit?" }];
  await answerChat(history, { ...config, ragUrl: state === "disconnected" ? "" : config.ragUrl }, AbortSignal.timeout(1000));
  const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  const prompt = payload.messages[0].content;
  expect(prompt).toMatch(/^You are Vesuvius Challenge RAG Chat, a research assistant/);
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get("X-OpenRouter-Title")).toBe("Vesuvius Challenge RAG Chat");
  expect(prompt).toContain("Answer in the language of the user's latest message unless they explicitly request another response language.");
  expect(prompt).toContain("The language of these instructions, retrieved evidence, search-query translations, or previous assistant replies must not determine the response language.");
  expect(prompt).toContain("RESPONSE QUALITY");
  expect(prompt).toMatch(/material limitations once.*after the findings/i);
  expect(prompt).toMatch(/internal status fields.*unless.*requests/i);
  expect(prompt).toMatch(/code\/data releases/);
  expect(payload.messages.slice(1)).toEqual(history);
  if (state === "disconnected") expect(prompt).toContain("No document knowledge base is connected.");
  if (state === "empty") expect(prompt).toContain("The document search found no excerpts.");
  if (state === "evidence") expect(JSON.parse(prompt.split("RETRIEVED DOCUMENTS (JSON):\n")[1])).toEqual(documents.map(document => ({ ...document, date: null })));
});

test.each(["test/model", "meta/muse-spark-1.3-contributor"])("archival form and Kaggle dates reach %s without becoming current-status proof", async model => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    vi.spyOn(rag, "retrieveDocuments").mockResolvedValueOnce([
      { id: "1", title: "November 2025 form", text: "An application form was announced.", date: "2025-11-03", url: "https://example.com/form" },
      { id: "2", title: "Undated note", text: "No posting date was supplied." },
    ]).mockResolvedValueOnce([
      { id: "1", title: "Kaggle surface detection", text: "A competition was announced.", date: "2024-02-29" },
    ]);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "Historical evidence [1], [2]." } }] }));
    const history = [{ role: "user" as const, content: "Kaggle surface detection" }, { role: "assistant" as const, content: "Earlier discussion." }, { role: "user" as const, content: "O formulário de novembro de 2025 ainda está aberto?" }];
    const response = await answerChat(history, { ...config, model }, AbortSignal.timeout(1000));
    const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    const context = model === "test/model" ? payload.messages[0].content : payload.messages.at(-1).content;
    expect(context).toContain("Current date (UTC): 2026-11-01");
    expect(payload.messages[0].content).toMatch(/fresh search does not make.*recent/i);
    expect(payload.messages[0].content).toMatch(/forms.*competitions.*current/i);
    expect(payload.messages[0].content).toMatch(/current status cannot be verified/i);
    const evidence = JSON.parse(context.split("RETRIEVED DOCUMENTS (JSON):\n")[1]);
    expect(evidence.map((doc: { date: string | null }) => doc.date)).toEqual(["2025-11-03", "2024-02-29", null]);
    expect(response.sources).toEqual([
      { id: "1", title: "November 2025 form", date: "2025-11-03", url: "https://example.com/form" },
      { id: "2", title: "Kaggle surface detection", date: "2024-02-29" },
      { id: "3", title: "Undated note" },
    ]);
    expect(response.sources.every(source => !("text" in source))).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

test("research generation retains role-tagged history and uses conservative sampling with a larger answer budget", async () => {
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockResolvedValue([{ id: "1", title: "Anuncio", text: "Evidence about PHerc 1447" }]);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "Respuesta [1]." } }] }));
  const history = [{ role: "user" as const, content: "PHerc 1447 y First Letters" }, { role: "assistant" as const, content: "Respuesta anterior [1]." }, { role: "user" as const, content: "¿Y el Grand Prize?" }];
  await answerChat(history, config, AbortSignal.timeout(1000));
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(body.temperature).toBe(0.1);
  expect(body.max_tokens).toBe(3200);
  expect(body.messages.slice(1)).toEqual(history);
  const prompt = body.messages[0].content;
  for (const rule of [/research assistant/, /inferences/, /hypotheses/, /exactly/, /does not mean/, /disagree/, /citations.*earlier/i, /untrusted data/, /no access to credentials/i]) expect(prompt).toMatch(rule);
  expect(retrieve.mock.calls[0][1]).toBe("¿Y el Grand Prize?");
  expect(retrieve.mock.calls[1][1]).toContain("PHerc 1447");
  expect(retrieve).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledOnce();
});

test("a new winding-fields request searches that topic before old lasagna context and merges bounded distinct evidence", async () => {
  const shared = { id: "2", title: "Shared", text: "Shared evidence", url: "https://example.com/shared" };
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockResolvedValueOnce([
    { id: "1", title: "Winding", text: "Winding evidence", url: "https://example.com/winding" }, shared,
    { id: "3", title: "Winding details", text: "Winding details", url: "https://example.com/winding-details" },
  ]).mockResolvedValueOnce([
    { id: "1", title: "Lasagna", text: "Lasagna evidence", url: "https://example.com/lasagna" }, shared,
    { id: "3", title: "Lasagna details", text: "Lasagna details", url: "https://example.com/lasagna-details" },
  ]);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "Winding [1], lasagna [2]." } }] }));
  const history = [{ role: "user" as const, content: "¿Qué son lasagna fields?" }, { role: "assistant" as const, content: "Respuesta anterior sobre lasagna." }, { role: "user" as const, content: "Buscá winding-fields en el RAG" }];
  const response = await answerChat(history, config, AbortSignal.timeout(1000));
  expect(retrieve.mock.calls.map(call => call[1])).toEqual(["winding-fields", expect.stringContaining("lasagna fields")]);
  expect(response.sources.map(source => source.title)).toEqual(["Winding", "Lasagna", "Shared", "Winding details", "Lasagna details"]);
  expect(response.sources.map(source => source.id)).toEqual(["1", "2", "3", "4", "5"]);
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(body.messages[0].content).toMatch(/searches reported for this turn/i);
  expect(body.messages[0].content).toContain("RAG QUERIES PERFORMED");
  expect(body.messages[0].content).toContain("not excerpts supplied by the user");
  expect(body.messages.slice(1)).toEqual(history);
  expect(fetch).toHaveBeenCalledOnce();
});

test("fresh searches still run with an empty primary result; unrelated standalone questions do not incur a second call", async () => {
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "1", title: "Context evidence", text: "Evidence" }]);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ choices: [{ message: { content: "Respuesta." } }] }));
  const reply = await answerChat([{ role: "user", content: "lasagna fields" }, { role: "assistant", content: "Previous answer." }, { role: "user", content: "¿Y ese método?" }], config, AbortSignal.timeout(1000));
  expect(reply.sources).toHaveLength(1);
  expect(retrieve.mock.calls[0][1]).toBe("¿Y ese método?");
  retrieve.mockClear().mockResolvedValue([]);
  await answerChat(messages, config, AbortSignal.timeout(1000));
  expect(retrieve).toHaveBeenCalledOnce();
});

test("a standalone explicit search does not also search its unnormalized command", async () => {
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockResolvedValue([]);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "No encontré evidencia." } }] }));
  await answerChat([{ role: "user", content: "Buscá winding-fields en el RAG" }], config, AbortSignal.timeout(1000));
  expect(retrieve.mock.calls.map(call => call[1])).toEqual(["winding-fields"]);
});

test("merging query results respects the original total evidence budget", async () => {
  vi.spyOn(rag, "retrieveDocuments").mockImplementation(async (_config, query) => Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), title: `${query}-${i}`, text: "x".repeat(4000) })));
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "Respuesta." } }] }));
  const reply = await answerChat([{ role: "user", content: "old topic" }, { role: "user", content: "new topic" }], config, AbortSignal.timeout(1000));
  expect(reply.sources).toHaveLength(4);
  const prompt = JSON.parse(String(fetch.mock.calls[0][1]?.body)).messages[0].content;
  const docs = JSON.parse(prompt.split("RETRIEVED DOCUMENTS (JSON):\n")[1]) as { text: string }[];
  expect(docs.reduce((sum, doc) => sum + doc.text.length, 0)).toBe(16000);
});

test("an empty RAG result is explicit in the model prompt and timed without fabricated sources", async () => {
  vi.spyOn(rag, "retrieveDocuments").mockImplementation(async (_config, _query, _signal, onResponse) => { onResponse?.(200); return []; });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "No encontré evidencia." } }] }));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const reply = await answerChat(messages, config, AbortSignal.timeout(1_000), createRequestLog("chat"));
  expect(reply.sources).toEqual([]);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).messages[0].content).toMatch(/found no excerpts/);
  expect(info.mock.calls[0][0]).toMatchObject({ dependency: "rag", event: "dependency.completed", sourceCount: 0, upstreamStatus: 200 });
});

test.each([
  [new Error("SECRET_RAG_AUTH"), 401, 503, "rag_unavailable"],
  [Object.assign(new Error("SECRET_TIMEOUT"), { code: -32001 }), undefined, 504, "rag_timeout"],
])("RAG failure is diagnosable without disclosing the cause: %#", async (cause, upstream, status, code) => {
  vi.spyOn(rag, "retrieveDocuments").mockImplementation(async (_config, _query, _signal, onResponse) => { if (upstream) onResponse?.(upstream); throw cause; });
  const fetch = vi.spyOn(globalThis, "fetch");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(answerChat(messages, config, AbortSignal.timeout(1_000), createRequestLog("chat"))).rejects.toMatchObject({ status, code, cause });
  expect(fetch).not.toHaveBeenCalled();
  expect(error.mock.calls[0][0]).toMatchObject({ code, dependency: "rag" });
  expect(JSON.stringify(error.mock.calls)).not.toMatch(/SECRET|PRIVATE/);
});

test.each(["rag", "model"] as const)("%s aborts retain their reason and emit a cancellation event", async dependency => {
  const controller = new AbortController();
  const cause = new DOMException("PRIVATE", "AbortError");
  const abort = async () => { controller.abort(cause); throw cause; };
  vi.spyOn(rag, "retrieveDocuments").mockImplementation(dependency === "rag" ? abort : async () => []);
  vi.spyOn(globalThis, "fetch").mockImplementation(abort);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  await expect(answerChat(messages, config, controller.signal, createRequestLog("chat"))).rejects.toBe(cause);
  expect(warn.mock.calls[0][0]).toMatchObject({ dependency, code: "request_cancelled" });
});

test.each(["rag", "model"] as const)("%s request timeouts are not mistaken for cancellations", async dependency => {
  const controller = new AbortController();
  const cause = new DOMException("PRIVATE", "TimeoutError");
  const abort = async () => { controller.abort(cause); throw cause; };
  vi.spyOn(rag, "retrieveDocuments").mockImplementation(dependency === "rag" ? abort : async () => []);
  vi.spyOn(globalThis, "fetch").mockImplementation(abort);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  await expect(answerChat(messages, config, controller.signal, createRequestLog("chat"))).rejects.toBe(cause);
  expect(error.mock.calls[0][0]).toMatchObject({ dependency, code: "request_timeout" });
});

test("non-link documents remain usable sources and provider text is bounded", async () => {
  vi.spyOn(rag, "retrieveDocuments").mockResolvedValue([{ id: "1", title: "Local evidence", text: "excerpt" }]);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "x".repeat(20_000) } }] }));
  const response = await answerChat(messages, config, AbortSignal.timeout(1_000));
  expect(response.message).toHaveLength(16_000);
  expect(response.truncated).toBe(true);
  expect(response.sources).toEqual([{ id: "1", title: "Local evidence" }]);
});

test("Nemotron-style Unicode citations are normalized to the webchat link format", async () => {
  vi.spyOn(rag, "retrieveDocuments").mockResolvedValue([{ id: "1", title: "Anuncio", text: "PHerc 1447 remains eligible for the Grand Prize.", url: "https://discord.com/channels/1/2/3" }]);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "Sigue en el Grand Prize【1】." } }] }));
  const response = await answerChat(messages, config, AbortSignal.timeout(1_000));
  expect(response.message).toBe("Sigue en el Grand Prize[1].");
  expect(response.sources).toEqual([{ id: "1", title: "Anuncio", url: "https://discord.com/channels/1/2/3" }]);
});

test.each(["[99]", "[0]", "【2】", "[9007199254740993]"])("unknown numeric references fail safely instead of becoming evidence: %s", async citation => {
  vi.spyOn(rag, "retrieveDocuments").mockResolvedValue([{ id: "1", title: "Only source", text: "Evidence" }]);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: `PRIVATE_ANSWER ${citation}` } }] }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(answerChat(messages, config, AbortSignal.timeout(1000), createRequestLog("chat"))).rejects.toMatchObject({ status: 502, code: "model_invalid_citations" });
  expect(log.mock.calls[0][0]).toMatchObject({ code: "model_invalid_citations" });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|SECRET/);
});

test("citation validation and normalization preserve numeric and Unicode literals inside code", async () => {
  vi.spyOn(rag, "retrieveDocuments").mockResolvedValue([{ id: "1", title: "Evidence", text: "Supported fact" }]);
  const code = "`array[99]` y ``array[`x`][99]``\n\n```python\nvalue = '【99】'\n```";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: `Hecho【1】. ${code}` } }] }));
  const response = await answerChat(messages, config, AbortSignal.timeout(1000));
  expect(response.message).toBe(`Hecho[1]. ${code}`);
});

test.each(["```python\narray[99]", "`array[99]`", "Sin afirmaciones documentales."])("code and ordinary text do not require fabricated sources: %s", async content => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content } }] }));
  const response = await answerChat(messages, { ...config, ragUrl: "" }, AbortSignal.timeout(1000));
  expect(response.message).toBe(content); expect(response.sources).toEqual([]);
});

test.each([["length", true], ["stop", false]] as const)("provider terminal reason %s explicitly communicates whether an answer is partial", async (finish_reason, truncated) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ finish_reason, message: { content: "Conclusión parcial: la primera excepción es" } }] }));
  const response = await answerChat(messages, { ...config, ragUrl: "" }, AbortSignal.timeout(1000));
  expect(response.truncated === true).toBe(truncated);
  expect(fetch).toHaveBeenCalledOnce();
});
