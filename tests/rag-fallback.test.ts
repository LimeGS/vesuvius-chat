import { beforeEach, expect, test, vi } from "vitest";
import { answerChat, chatStatus, readServerConfig } from "../lib/chat-server";
import * as rag from "../lib/rag";
import { createRequestLog } from "../lib/logging";

const primary = "http://127.0.0.1:18765/mcp", backup = "http://127.0.0.1:8765/mcp";
const config = () => readServerConfig({ OPENROUTER_API_KEY: "SECRET_KEY", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: backup, MCP_RAG_PRIMARY_URL: primary, MCP_RAG_TOOL: "search_discord" });
const messages = [{ role: "user" as const, content: "PRIVATE_QUESTION" }];
const gpu = [{ id: "1", title: "GPU source", text: "PRIVATE_GPU_EVIDENCE", url: "https://discord.com/channels/1/2/3" }];
const cpu = [{ id: "1", title: "CPU source", text: "PRIVATE_CPU_EVIDENCE", url: "https://discord.com/channels/1/2/4" }];
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ choices: [{ message: { content: "Synthetic answer." } }] }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("healthy GPU evidence reaches generation without querying the CPU backup", async () => {
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockImplementation(async settings => settings.url === primary ? gpu : cpu);
  const response = await answerChat(messages, config(), new AbortController().signal);
  expect(response.sources).toEqual([{ id: "1", title: "GPU source", url: "https://discord.com/channels/1/2/3" }]);
  expect(retrieve.mock.calls.map(call => call[0].url)).toEqual([primary]);
  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).messages[0].content).toContain("PRIVATE_GPU_EVIDENCE");
});

test("a valid empty GPU result remains empty instead of being replaced by CPU evidence", async () => {
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockImplementation(async settings => settings.url === primary ? [] : cpu);
  const response = await answerChat(messages, config(), new AbortController().signal);
  expect(response.sources).toEqual([]);
  expect(retrieve.mock.calls.map(call => call[0].url)).toEqual([primary]);
});

test.each([new Error("PRIVATE_TRANSPORT"), new DOMException("PRIVATE_TIMEOUT", "TimeoutError"), new Error("Invalid retrieval result")])("primary failure falls back once, without replaying generation or logging content: %#", async cause => {
  const signal = new AbortController().signal;
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockImplementation(async (settings, _query, _signal, onResponse) => {
    if (settings.url === primary) { onResponse?.(503); throw cause; }
    onResponse?.(200); return cpu;
  });
  const response = await answerChat(messages, config(), signal, createRequestLog("chat"));
  expect(response.sources[0].title).toBe("CPU source");
  expect(retrieve.mock.calls.map(call => call[0].url)).toEqual([primary, backup]);
  expect(retrieve.mock.calls[1][2]).toBe(signal);
  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(vi.mocked(console.warn).mock.calls[0][0]).toMatchObject({ event: "dependency.failed", dependency: "rag", code: "rag_primary_unavailable" });
  expect(vi.mocked(console.info).mock.calls[0][0]).toMatchObject({ dependency: "rag", upstreamStatus: 200 });
  expect(JSON.stringify([...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.info).mock.calls])).not.toMatch(/PRIVATE|SECRET|127\.0\.0\.1|stack/);
});

test("a hanging GPU is abandoned at 15 seconds while the shared budget remains available for CPU", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  try {
    const parent = new AbortController();
    const retrieve = vi.spyOn(rag, "retrieveDocuments").mockImplementation((settings, _query, signal) => settings.url === primary
      ? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
      : Promise.resolve(cpu));
    const pending = answerChat(messages, config(), parent.signal);
    expect(retrieve.mock.calls[0][0].url).toBe(primary);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(retrieve).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).sources[0].title).toBe("CPU source");
    expect(parent.signal.aborted).toBe(false);
    expect(retrieve.mock.calls.map(call => call[0].url)).toEqual([primary, backup]);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

test.each(["AbortError", "TimeoutError"])("caller %s aborts primary without starting backup or generation", async name => {
  const controller = new AbortController();
  const cause = new DOMException("PRIVATE_CAUSE", name);
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockImplementation((_settings, _query, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  const outcome = answerChat(messages, config(), controller.signal).catch(error => error);
  controller.abort(cause);
  expect(await outcome).toBe(cause);
  expect(retrieve.mock.calls.map(call => call[0].url)).toEqual([primary]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("a caller abort coinciding with primary failure never dispatches CPU work", async () => {
  const controller = new AbortController();
  const cause = new DOMException("PRIVATE_CANCEL", "AbortError");
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockImplementation(async () => { controller.abort(cause); throw new Error("PRIVATE_PRIMARY"); });
  await expect(answerChat(messages, config(), controller.signal)).rejects.toBe(cause);
  expect(retrieve.mock.calls.map(call => call[0].url)).toEqual([primary]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("both backends failing returns the existing safe retrieval error without generation", async () => {
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockRejectedValue(new Error("PRIVATE_BACKEND_FAILURE"));
  await expect(answerChat(messages, config(), new AbortController().signal, createRequestLog("chat"))).rejects.toMatchObject({ status: 503, code: "rag_unavailable" });
  expect(retrieve.mock.calls.map(call => call[0].url)).toEqual([primary, backup]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("PRIVATE");
});

test("two queries and their backups share one 180-second budget rather than renewing it", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  try {
    const controller = new AbortController();
    const cause = new DOMException("total deadline", "TimeoutError");
    setTimeout(() => controller.abort(cause), 180_000);
    const retrieve = vi.spyOn(rag, "retrieveDocuments").mockImplementation((settings, _query, signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (settings.url === backup) setTimeout(() => resolve(cpu), 90_000);
    }));
    const history = [{ role: "user" as const, content: "old topic" }, { role: "user" as const, content: "new topic" }];
    const outcome = answerChat(history, config(), controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(controller.signal.aborted).toBe(false);
    expect(retrieve.mock.calls.map(call => call[0].url)).toEqual([primary, backup, primary, backup]);
    expect(retrieve.mock.calls.filter(call => call[0].url === backup).every(call => call[2] === controller.signal)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe(cause);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

test.each(["http://192.0.2.1/mcp", "not a url", "https://user:secret@example.com/mcp"])("invalid primary configuration fails closed: %s", url => {
  const candidate = readServerConfig({ OPENROUTER_API_KEY: "test", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: backup, MCP_RAG_PRIMARY_URL: url });
  expect(() => chatStatus(candidate)).toThrow();
});
