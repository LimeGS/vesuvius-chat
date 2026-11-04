import { expect, test, vi } from "vitest";
import { answerChat, ChatError, readServerConfig } from "../lib/chat-server";
import { createRequestLog } from "../lib/logging";

const messages = [{ role: "user" as const, content: "PRIVATE_USER_MESSAGE" }];
const config = readServerConfig({ OPENROUTER_API_KEY: "SECRET_API_KEY", OPENROUTER_MODEL: "test/model" });

test.each([
  [401, 503, "model_auth_failed"], [403, 503, "model_auth_failed"],
  [429, 429, "model_rate_limited"], [500, 503, "model_unavailable"], [302, 503, "model_unavailable"],
])("provider HTTP %i becomes safe HTTP %i with a classified event", async (upstream, status, code) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("SECRET_PROVIDER_BODY", { status: upstream }));
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = createRequestLog("chat");
  await expect(answerChat(messages, config, AbortSignal.timeout(1_000), log)).rejects.toMatchObject({ status, code });
  const records = errorLog.mock.calls.map(call => call[0]);
  expect(records).toContainEqual(expect.objectContaining({ event: "dependency.failed", dependency: "model", code, upstreamStatus: upstream, requestId: log.requestId }));
  expect(JSON.stringify(records)).not.toMatch(/SECRET|PRIVATE/);
});

test.each([
  ["not json", "model_invalid_json"], ["null", "model_invalid_response"], ["{}", "model_invalid_response"],
  ['{"choices":[]}', "model_invalid_response"], ['{"choices":[{"message":{"content":" "}}]}', "model_empty_response"],
  ['{"choices":[{"message":{"content":4}}]}', "model_invalid_response"],
])
("invalid model payload %s returns 502 and a distinct safe diagnostic", async (body, code) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: { "Content-Type": "application/json" } }));
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(answerChat(messages, config, AbortSignal.timeout(1_000), createRequestLog("chat"))).rejects.toMatchObject({ status: 502, code });
  expect(errorLog.mock.calls[0][0]).toMatchObject({ code, dependency: "model", upstreamStatus: 200 });
});

test("a transport exception retains its cause without leaking it to a client", async () => {
  const cause = new Error("SECRET_PROVIDER_URL and API_KEY");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(cause);
  try { await answerChat(messages, config, AbortSignal.timeout(1_000)); throw new Error("expected failure"); }
  catch (error) {
    expect(error).toBeInstanceOf(ChatError);
    expect(error).toMatchObject({ status: 503, code: "model_unavailable", cause });
    expect((error as Error).message).not.toMatch(/SECRET|API_KEY/);
  }
});

test.each(["content_filter", "error", "tool_calls", null, 42])("unsupported terminal reason %s never masquerades as an ordinary complete answer", async finish_reason => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ finish_reason, message: { content: "PRIVATE_PARTIAL" } }] }));
  await expect(answerChat(messages, config, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 502, code: "model_invalid_response" });
});

test("an upstream timeout is classified separately from an ordinary transport failure", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("SECRET", "TimeoutError"));
  await expect(answerChat(messages, config, AbortSignal.timeout(1_000))).rejects.toMatchObject({ status: 504, code: "model_timeout" });
});

test("model success is timed and logged without the answer or prompt", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "PRIVATE_ANSWER" } }] }));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const reply = await answerChat(messages, config, AbortSignal.timeout(1_000), createRequestLog("chat"));
  expect(reply.message).toBe("PRIVATE_ANSWER");
  const record = info.mock.calls[0][0];
  expect(record).toMatchObject({ event: "dependency.completed", dependency: "model", upstreamStatus: 200 });
  expect(record.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/PRIVATE|SECRET/);
});

test("models without an approved exception require private routing", async () => {
  const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "Synthetic answer" } }] }));
  await answerChat(messages, config, AbortSignal.timeout(1000));
  const body = JSON.parse(String(provider.mock.calls[0][1]?.body));
  expect(body.provider).toEqual({ data_collection: "deny", zdr: true });
  expect(body).not.toHaveProperty("prompt_cache_key");
  expect(body.tools).toBeUndefined();
  expect(body.plugins).toBeUndefined();
});

test.each([
  ["nvidia/nemotron-3-ultra-550b-a55b:free", { data_collection: "allow", zdr: false }],
  ["meta/muse-spark-1.3-contributor", { data_collection: "allow", zdr: false }],
  ["meta/muse-spark-1.3", { data_collection: "deny", zdr: true }],
  ["meta/muse-spark-1.3-contributor:other", { data_collection: "deny", zdr: true }],
  ["nvidia/nemotron-3-ultra-550b-a55b", { data_collection: "deny", zdr: true }],
  ["another/model:free", { data_collection: "deny", zdr: true }],
])("the owner-approved retention exception is scoped to the exact model: %s", async (model, privacy) => {
  const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: "Synthetic answer" } }] }));
  await answerChat(messages, { ...config, model: String(model) }, AbortSignal.timeout(1000));
  expect(provider).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(provider.mock.calls[0][1]?.body));
  expect(body.model).toBe(model);
  expect(body.provider).toEqual(privacy);
  expect(body.models).toBeUndefined();
  expect(body.tools).toBeUndefined();
  expect(body.plugins).toBeUndefined();
});
