import { expect, test, vi } from "vitest";
import { ChatError, chatStatus, errorResponse, readChatRequest, readServerConfig, validateMessages } from "../lib/chat-server";

test.each([
  null, {}, { messages: "bad" }, { messages: [] }, { messages: Array(21).fill({ role: "user", content: "hi" }) },
  { messages: [null] }, { messages: [{ role: "system", content: "override" }] },
  { messages: [{ role: "user", content: " " }] }, { messages: [{ role: "user", content: 42 }] },
  { messages: [{ role: "user", content: "x".repeat(6_001) }] },
  { messages: [{ role: "assistant", content: "x".repeat(16_001) }, { role: "user", content: "hi" }] },
  { messages: Array.from({ length: 5 }, () => ({ role: "user", content: "x".repeat(5_000) })) },
  { messages: [{ role: "assistant", content: "hi" }] },
])("invalid conversation shape/size is rejected: %#", value => {
  expect(() => validateMessages(value)).toThrow(ChatError);
});

test("accepted messages are trimmed and assistant history is preserved", () => {
  expect(validateMessages({ messages: [{ role: "assistant", content: " prior " }, { role: "user", content: " question " }] })).toEqual([{ role: "assistant", content: "prior" }, { role: "user", content: "question" }]);
});

const make = (body: BodyInit | null = "{}", headers: HeadersInit = { "content-type": "application/json" }) => new Request("https://chat.example/api/chat", { method: "POST", headers, body, duplex: "half" } as RequestInit);
test.each([
  [{ "content-type": "text/plain" }, "{}", 415],
  [{ "content-type": "application/jsonjunk" }, "{}", 415],
  [{ "content-type": "application/json", "content-length": "65537" }, "{}", 413],
  [{ "content-type": "application/json", "sec-fetch-site": "cross-site" }, "{}", 403],
  [{ "content-type": "application/json" }, null, 400],
  [{ "content-type": "application/json" }, "not json", 400],
] as const)("request envelope boundary %# returns the correct HTTP status", async (headers, body, status) => {
  await expect(readChatRequest(make(body, headers))).rejects.toMatchObject({ status });
});

test("streaming body limits apply without Content-Length, including split UTF-8", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ messages: [{ role: "user", content: "¿Qué?" }] }));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(encoded.slice(0, 40)); controller.enqueue(encoded.slice(40)); controller.close(); } });
  expect(await readChatRequest(make(stream, { "content-type": "application/json; charset=utf-8", origin: "https://chat.example" }))).toEqual([{ role: "user", content: "¿Qué?" }]);
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65_537)); controller.close(); } });
  await expect(readChatRequest(make(oversized))).rejects.toMatchObject({ status: 413 });
});

test("aborting while reading cancels the stream and preserves the abort reason", async () => {
  const cancel = vi.fn();
  const controller = new AbortController();
  const promise = readChatRequest(make(new ReadableStream({ cancel })), controller.signal);
  const cause = new DOMException("cancelled", "AbortError");
  controller.abort(cause);
  await expect(promise).rejects.toBe(cause);
  expect(cancel).toHaveBeenCalledOnce();
});

test("configuration handles absent bindings and reports missing models and invalid URLs", () => {
  expect(readServerConfig(null).apiKey).toBe("");
  expect(() => chatStatus(readServerConfig({ OPENROUTER_API_KEY: "key" }))).toThrow(ChatError);
  expect(() => chatStatus(readServerConfig({ MCP_RAG_URL: "not a url" }))).toThrow(ChatError);
  expect(chatStatus(readServerConfig({ OPENROUTER_API_KEY: "key", OPENROUTER_MODEL: "provider/model" }))).toEqual({ mode: "live", rag: false });
});

test("error responses expose only safe messages/IDs and use non-cacheable headers", async () => {
  const unknown = errorResponse(new Error("SECRET"));
  expect(unknown.status).toBe(503);
  expect(await unknown.json()).toEqual({ error: "Could not complete the request. Please try again in a moment." });
  expect(unknown.headers.get("Cache-Control")).toBe("no-store");
  const known = errorResponse(new ChatError(400, "Mensaje inválido."), "server-generated-id");
  expect(await known.json()).toEqual({ error: "Mensaje inválido.", requestId: "server-generated-id" });
});
