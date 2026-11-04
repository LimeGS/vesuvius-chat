import { expect, test, vi } from "vitest";
import { answerChat, readServerConfig } from "../lib/chat-server";
import { createRequestLog } from "../lib/logging";
import * as rag from "../lib/rag";

const model = "meta/muse-spark-1.3-contributor";
const config = readServerConfig({ OPENROUTER_API_KEY: "PRIVATE_KEY", OPENROUTER_MODEL: model, MCP_RAG_URL: "http://127.0.0.1:8765/mcp" });

test("Muse preserves a growing prompt prefix across turns even when RAG evidence changes", async () => {
  const retrieve = vi.spyOn(rag, "retrieveDocuments").mockResolvedValue([{ id: "1", title: "Evidence", text: "PRIVATE_FIRST_EVIDENCE" }]);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ choices: [{ message: { content: "Synthetic answer [1]." } }] }));
  const first = [{ role: "user" as const, content: "¿Qué es spiral fit?" }];
  const reply = await answerChat(first, config, new AbortController().signal);
  const history = [...first, { role: "assistant" as const, content: reply.message }, { role: "user" as const, content: "¿Cuáles son sus límites?" }];
  const original = structuredClone(history);
  retrieve.mockResolvedValue([{ id: "1", title: "New evidence", text: "PRIVATE_SECOND_EVIDENCE" }]);
  await answerChat(history, config, new AbortController().signal);
  const payloads = fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
  expect(payloads[0].messages[0]).toEqual(payloads[1].messages[0]);
  expect(payloads[1].messages.slice(1, -1)).toEqual(original.slice(0, -1));
  expect(payloads[0].messages[0].content).not.toMatch(/PRIVATE_FIRST|PRIVATE_SECOND|¿Qué es/);
  expect(payloads[0].messages.at(-1).content).toContain("PRIVATE_FIRST_EVIDENCE");
  expect(payloads[1].messages.at(-1).content).toContain("PRIVATE_SECOND_EVIDENCE");
  expect(payloads[1].messages.at(-1).content).not.toContain("PRIVATE_FIRST_EVIDENCE");
  expect(payloads[1].messages.at(-1).content.startsWith("¿Cuáles son sus límites?")).toBe(true);
  expect(payloads[1].messages[0].content).toMatch(/language.*question/i);
  expect(payloads[1].provider).toEqual({ data_collection: "allow", zdr: false });
  expect(payloads.every(payload => payload.model === model)).toBe(true);
  expect(payloads.map(payload => payload.prompt_cache_key)).toEqual(["vesuvius-rag-genius-muse-cache-v1", "vesuvius-rag-genius-muse-cache-v1"]);
  expect(history).toEqual(original);
});

test("Muse cache usage reaches logs as numeric metadata without response bodies", async () => {
  vi.spyOn(rag, "retrieveDocuments").mockResolvedValue([]);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "PRIVATE_ANSWER" } }], usage: { prompt_tokens: 2400, prompt_tokens_details: { cached_tokens: 2048 }, private: "PRIVATE_USAGE" } }));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  await answerChat([{ role: "user", content: "PRIVATE_QUESTION" }], config, new AbortController().signal, createRequestLog("chat"));
  const record = info.mock.calls.map(call => call[0]).find(row => row.dependency === "model");
  expect(record).toMatchObject({ promptTokens: 2400, cachedTokens: 2048 });
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/PRIVATE_|PRIVATE_KEY/);
});

test("the UTC date updates each turn without invalidating Muse's stable prefix", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.spyOn(rag, "retrieveDocuments").mockResolvedValue([]);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ choices: [{ message: { content: "No current evidence." } }] }));
    for (const time of ["2026-11-01T23:59:00Z", "2026-11-02T00:01:00Z"]) {
      vi.setSystemTime(new Date(time));
      await answerChat([{ role: "user", content: "Is this competition currently open?" }], config, new AbortController().signal);
    }
    const payloads = fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(payloads[0].messages[0]).toEqual(payloads[1].messages[0]);
    expect(payloads[0].messages[0].content).not.toMatch(/2026-11-0[12]/);
    expect(payloads[0].messages.at(-1).content).toContain("Current date (UTC): 2026-11-01");
    expect(payloads[1].messages.at(-1).content).toContain("Current date (UTC): 2026-11-02");
    expect(payloads.map(payload => payload.prompt_cache_key)).toEqual(["vesuvius-rag-genius-muse-cache-v1", "vesuvius-rag-genius-muse-cache-v1"]);
  } finally { vi.useRealTimers(); }
});
