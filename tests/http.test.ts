import { expect, test, vi } from "vitest";
import { answerChat, readServerConfig } from "../lib/chat-server";
import { boundedResponse, ResponseTooLargeError } from "../lib/http";

test("a streamed oversized provider body is rejected before JSON materialization", async () => {
  const cancel = vi.fn();
  let chunks = 0;
  const bytes = new TextEncoder().encode(JSON.stringify({ padding: "x".repeat(1024 * 1024), choices: [{ message: { content: "ok" } }] }));
  const body = new ReadableStream({ pull(controller) { const start = chunks * 65_536; if (start >= bytes.length) { controller.close(); return; } chunks++; controller.enqueue(bytes.slice(start, start + 65_536)); }, cancel });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: { "Content-Type": "application/json" } }));
  await expect(answerChat([{ role: "user", content: "audit" }], readServerConfig({ OPENROUTER_API_KEY: "test", OPENROUTER_MODEL: "test/model" }), AbortSignal.timeout(200))).rejects.toMatchObject({ status: 502, code: "model_response_too_large" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(chunks).toBeLessThan(8);
});

test("declared oversize is canceled and empty responses retain their status", async () => {
  const cancel = vi.fn();
  await expect(boundedResponse(new Response(new ReadableStream({ cancel }), { headers: { "content-length": "11" } }), 10)).rejects.toBeInstanceOf(ResponseTooLargeError);
  expect(cancel).toHaveBeenCalledOnce();
  const empty = new Response(null, { status: 204 });
  expect(await boundedResponse(empty, 10)).toBe(empty);
});
test("small decoded bodies preserve headers, stream failures and downstream cancellation", async () => {
  const small = await boundedResponse(new Response("ok", { headers: { "content-length": "2", "content-encoding": "gzip", "x-test": "yes" } }), 2);
  expect(await small.text()).toBe("ok");
  expect(small.headers.get("x-test")).toBe("yes");
  expect(small.headers.has("content-encoding")).toBe(false);
  const failure = await boundedResponse(new Response(new ReadableStream({ pull(c) { c.error(new Error("offline")); } })), 10);
  await expect(failure.text()).rejects.toThrow("offline");
  const cancel = vi.fn();
  const pending = await boundedResponse(new Response(new ReadableStream({ cancel })), 10);
  await pending.body!.cancel("stop");
  expect(cancel).toHaveBeenCalledWith("stop");
});
