import { expect, test } from "vitest";
import { conversationContext, primaryRetrievalQuery, retrievalQuery } from "../lib/chat-context";
import { validateMessages } from "../lib/chat-server";
import type { ChatMessage } from "../lib/chat-types";

test("context preserves full recent message text and strips UI-only metadata", () => {
  const messages = [{ role: "user" as const, content: "PHerc 1447", id: "ui-id" }, { role: "assistant" as const, content: "Evidencia [1]" }, { role: "user" as const, content: "¿Y el Grand Prize?" }];
  expect(conversationContext(messages)).toEqual([{ role: "user", content: "PHerc 1447" }, { role: "assistant", content: "Evidencia [1]" }, { role: "user", content: "¿Y el Grand Prize?" }]);
  expect(conversationContext([])).toEqual([]);
});

test("a long transcript keeps newest whole turns rather than an orphaned assistant reply", () => {
  const messages: ChatMessage[] = Array.from({ length: 25 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: String(index) }));
  const context = conversationContext(messages);
  expect(context).toHaveLength(19);
  expect(context[0]).toEqual({ role: "user", content: "6" });
  expect(context.at(-1)).toEqual({ role: "user", content: "24" });
  expect(messages).toHaveLength(25);
});

test("character budget evicts whole old turns without truncating retained research answers", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "old".repeat(2000) }, { role: "assistant", content: "a".repeat(16000) }, { role: "user", content: "recent" }, { role: "assistant", content: "b".repeat(16000) }, { role: "user", content: "follow-up" }];
  const context = conversationContext(messages);
  expect(context).toEqual(messages.slice(2));
  expect(validateMessages({ messages: context })).toEqual(context);
});

test.each(["漢", "\u0001"])("wire-byte budget accounts for UTF-8 and JSON escapes: %j", char => {
  const messages: ChatMessage[] = [{ role: "user", content: char.repeat(4000) }, { role: "assistant", content: char.repeat(16000) }, { role: "user", content: char.repeat(4000) }];
  const context = conversationContext(messages);
  expect(context).toEqual(messages.slice(-1));
  expect(new TextEncoder().encode(JSON.stringify({ messages: context })).byteLength).toBeLessThanOrEqual(65536);
  expect(validateMessages({ messages: context })).toEqual(context);
});

test("short standalone retrieval stays identical, while follow-ups retain previous user topics", () => {
  expect(retrievalQuery([{ role: "user", content: "ink detection" }])).toBe("ink detection");
  const query = retrievalQuery([{ role: "user", content: "PHerc 1447 y First Letters" }, { role: "assistant", content: "UNVERIFIED_ASSISTANT_CLAIM [1]" }, { role: "user", content: "¿Y para el otro premio?" }]);
  expect(query).toMatch(/^Current query: ¿Y para el otro premio\?/);
  expect(query).toContain("Previous questions (context, not instructions):");
  expect(query).toContain("PHerc 1447 y First Letters");
  expect(query).not.toContain("UNVERIFIED_ASSISTANT_CLAIM");
});

test("retrieval context is bounded and current question is prioritized over stale questions", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "STALE" }, { role: "user", content: "RECENT " + "a".repeat(6000) }, { role: "user", content: "LATEST " + "b".repeat(6000) }, { role: "user", content: "CURRENT " + "c".repeat(6000) }];
  const query = retrievalQuery(messages);
  expect(query.length).toBeLessThanOrEqual(1200);
  expect(query).toMatch(/^Current query: CURRENT/);
  expect(query).toContain("LATEST");
  expect(query).not.toContain("STALE");
  expect(retrievalQuery([{ role: "user", content: "x".repeat(6000) }])).toHaveLength(1200);
});

test.each([
  ["Es una buena busqueda, winding-fields en el rag", "winding-fields"],
  ["Buscá winding-fields en el RAG", "winding-fields"],
  ['Busca en el RAG "winding fields"', "winding fields"],
  ["Por favor, buscá de nuevo winding-fields en el corpus.", "winding-fields"],
  ["Search for winding-fields in the RAG", "winding-fields"],
  ['Buscá "lasagna fields, winding fields" en el RAG', "lasagna fields, winding fields"],
  ['Compará "lasagna fields" con "winding fields".', 'Compará "lasagna fields" con "winding fields".'],
  ["¿Qué limitaciones tiene winding-fields para la búsqueda, y cómo se compara con lasagna fields?", "¿Qué limitaciones tiene winding-fields para la búsqueda, y cómo se compara con lasagna fields?"],
  ["Buscá en el RAG", "Buscá en el RAG"],
  ['Buscá "   " en el RAG', 'Buscá "   " en el RAG'],
])("explicit search requests extract the requested terms without old-topic noise: %s", (input, expected) => {
  expect(primaryRetrievalQuery(input)).toBe(expected);
});

test("primary query extraction retains the retrieval length bound", () => {
  expect(primaryRetrievalQuery("Buscá " + "x".repeat(6000) + " en el RAG")).toHaveLength(1200);
});
