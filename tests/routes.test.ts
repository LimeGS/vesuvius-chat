import { beforeEach, expect, test, vi } from "vitest";
import { env } from "node:process";
import { POST } from "../app/api/chat/route";
import { GET } from "../app/api/status/route";
import * as chat from "../lib/chat-server";
import * as limits from "../lib/limits";
import { createSession, securityConfig, sessionCookie } from "../lib/auth";
import { quotaDatabase } from "./fixtures/quota-db";
let cookie = "";
const base = "http://127.0.0.1";

beforeEach(async () => {
  for (const key of Object.keys(env)) if (/^(?:CHAT_|OPENROUTER_|MCP_|LIMIT_|LIMITS_|INVITATION_CODES$|SESSION_SECRET$|APP_ORIGIN$)/.test(key)) delete env[key];
  Object.assign(env, { INVITATION_CODES: JSON.stringify(["a".repeat(32)]), SESSION_SECRET: "s".repeat(48), LIMITS_DB_PATH: quotaDatabase() });
  cookie = sessionCookie(new Request(base), await createSession("a".repeat(32), securityConfig(env)));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
const request = (body = JSON.stringify({ messages: [{ role: "user", content: "PRIVATE_CHAT" }] }), signal?: AbortSignal) => new Request(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Request-ID": "untrusted-client-id", Cookie: cookie }, body, signal });
const statusRequest = () => new Request(`${base}/api/status`, { headers: { Cookie: cookie } });

test("real chat handler returns a generated ID and a correlated completion event", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ mode: "demo", rag: false });
  const id = response.headers.get("X-Request-ID");
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  const log = vi.mocked(console.info).mock.calls[0][0];
  expect(log).toMatchObject({ event: "request.completed", route: "chat", requestId: id, status: 200 });
  expect(JSON.stringify(log)).not.toMatch(/PRIVATE_CHAT|untrusted-client-id/);
});

test("invalid JSON gets a safe correlated 400, without logging the body", async () => {
  const response = await POST(request("SECRET not json"));
  expect(response.status).toBe(400);
  const body = await response.json() as { requestId: string };
  expect(body.requestId).toBe(response.headers.get("X-Request-ID"));
  expect(JSON.stringify(body)).not.toMatch(/SECRET/);
  expect(vi.mocked(console.warn).mock.calls[0][0]).toMatchObject({ code: "invalid_request", status: 400, requestId: body.requestId });
});

test("unexpected errors are correlated but never logged verbatim", async () => {
  vi.spyOn(chat, "answerChat").mockRejectedValue(new Error("SECRET_KEY and PRIVATE_CHAT"));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toMatch(/SECRET|PRIVATE/);
  const record = vi.mocked(console.error).mock.calls[0][0];
  expect(record).toMatchObject({ code: "internal_error", status: 503 });
  expect(JSON.stringify(record)).not.toMatch(/SECRET|PRIVATE|stack/);
});

test("request cancellation and server timeout have distinct responses and event codes", async () => {
  const cancelled = new AbortController(); cancelled.abort();
  let response = await POST(request(undefined, cancelled.signal));
  expect(response.status).toBe(499);
  expect(vi.mocked(console.warn).mock.calls[0][0].code).toBe("request_cancelled");
  const timeout = new AbortController(); timeout.abort(new DOMException("timeout", "TimeoutError"));
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  response = await POST(request());
  expect(response.status).toBe(504);
  expect(vi.mocked(console.error).mock.calls[0][0].code).toBe("request_timeout");
});

function simulatedDeadlineClock() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), milliseconds);
    return controller.signal;
  });
}

test("an admitted generation may finish after 45 seconds without losing its response", async () => {
  simulatedDeadlineClock();
  try {
    Object.assign(env, { OPENROUTER_API_KEY: "synthetic", OPENROUTER_MODEL: "test/model" });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      setTimeout(() => resolve(Response.json({ choices: [{ message: { content: "Synthetic late response." } }] })), 90_000);
      started();
    }));
    const pending = POST(request());
    await ready;
    await vi.advanceTimersByTimeAsync(90_000);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message: "Synthetic late response." });
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

test("the total 180-second budget cancels unfinished generation and releases capacity", async () => {
  simulatedDeadlineClock();
  try {
    Object.assign(env, { OPENROUTER_API_KEY: "synthetic", OPENROUTER_MODEL: "test/model" });
    let started!: () => void;
    let upstream!: AbortSignal;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      upstream = init!.signal!;
      upstream.addEventListener("abort", () => reject(upstream.reason), { once: true });
      started();
    }));
    const release = vi.fn(async () => {});
    vi.spyOn(limits, "reserveLimit").mockResolvedValue(release);
    const pending = POST(request());
    await ready;
    await vi.advanceTimersByTimeAsync(179_999);
    expect(upstream.aborted).toBe(false);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(504);
    expect(upstream.aborted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

test("status uses the same correlation/log contract for success and configuration failures", async () => {
  let response = await GET(statusRequest());
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Request-ID")).toBeTruthy();
  expect(vi.mocked(console.info).mock.calls[0][0]).toMatchObject({ route: "status", status: 200 });
  Object.assign(env, { CHAT_ENV: "production" });
  response = await GET(statusRequest());
  expect(response.status).toBe(503);
  const body = await response.json() as { requestId: string };
  expect(body.requestId).toBe(response.headers.get("X-Request-ID"));
  expect(vi.mocked(console.error).mock.calls[0][0]).toMatchObject({ route: "status", status: 503, code: "configuration_error" });
});

test("safe classified chat errors preserve their HTTP status", async () => {
  vi.spyOn(chat, "answerChat").mockRejectedValue(new chat.ChatError(429, "Probá más tarde.", "model_rate_limited"));
  const response = await POST(request());
  expect(response.status).toBe(429);
  expect(vi.mocked(console.warn).mock.calls[0][0].code).toBe("model_rate_limited");
});

test("an unexpected status failure remains a safe, correlated internal error", async () => {
  vi.spyOn(chat, "chatStatus").mockImplementation(() => { throw new Error("SECRET"); });
  const response = await GET(statusRequest());
  expect(response.status).toBe(503);
  expect(vi.mocked(console.error).mock.calls[0][0]).toMatchObject({ code: "internal_error", route: "status" });
  expect(JSON.stringify(await response.json())).not.toContain("SECRET");
});

test("anonymous requests are denied before RAG or generation", async () => {
  const answer = vi.spyOn(chat, "answerChat");
  cookie = "";
  expect((await POST(request())).status).toBe(401);
  expect((await GET(statusRequest())).status).toBe(401);
  expect(answer).not.toHaveBeenCalled();
});

test("known configuration errors are rejected before any quota reservation", async () => {
  Object.assign(env, { OPENROUTER_API_KEY: "test", OPENROUTER_MODEL: "" });
  const reserve = vi.spyOn(limits, "reserveLimit");
  const fetch = vi.spyOn(globalThis, "fetch");
  expect((await POST(request())).status).toBe(503);
  expect(reserve).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.mocked(console.error).mock.calls[0][0]).toMatchObject({ code: "configuration_error" });
});

test("an invalid GPU endpoint is rejected before reserving capacity or calling a backend", async () => {
  Object.assign(env, { OPENROUTER_API_KEY: "synthetic", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: "http://127.0.0.1:8765/mcp", MCP_RAG_PRIMARY_URL: "http://192.0.2.1/mcp" });
  const reserve = vi.spyOn(limits, "reserveLimit");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  expect((await POST(request())).status).toBe(503);
  expect(reserve).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("quota denial never dispatches generation, and errors always release a reservation", async () => {
  const answer = vi.spyOn(chat, "answerChat");
  Object.assign(env, { LIMIT_CHAT_GLOBAL_PER_DAY: "1" });
  expect((await POST(request())).status).toBe(200);
  answer.mockClear();
  const response = await POST(request());
  expect(response.status).toBe(429); expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(answer).not.toHaveBeenCalled();
  const release = vi.fn(async () => {});
  vi.spyOn(limits, "reserveLimit").mockResolvedValue(release);
  answer.mockRejectedValue(new Error("SECRET"));
  expect((await POST(request())).status).toBe(503);
  expect(release).toHaveBeenCalledOnce();
  release.mockRejectedValue(new Error("SECRET"));
  expect((await POST(request())).status).toBe(503);
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  expect(vi.mocked(console.error).mock.calls.some(([record]) => record.code === "limits_unavailable")).toBe(true);
});
