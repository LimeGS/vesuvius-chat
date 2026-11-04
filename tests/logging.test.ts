import { expect, test, vi } from "vitest";
import { createRequestLog } from "../lib/logging";

test("development emits inspectable structured request metadata", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  createRequestLog("chat").write("info", "request.completed");
  expect(info.mock.calls[0][0]).toMatchObject({ event: "request.completed", level: "info" });
  expect(typeof info.mock.calls[0][0]).toBe("object");
});

test("production emits one JSON record for the content-filtering service supervisor", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv("NODE_ENV", "production");
  try {
    createRequestLog("chat").write("info", "request.completed", { status: 200, message: "PRIVATE_SENTINEL" } as never);
    expect(typeof info.mock.calls[0][0]).toBe("string");
    expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({ route: "chat", status: 200 });
    expect(info.mock.calls[0][0]).not.toContain("PRIVATE_SENTINEL");
  } finally { vi.unstubAllEnvs(); }
});

test("logs are request-correlated JSON with only safe allowlisted fields", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const log = createRequestLog("chat");
  const other = createRequestLog("status");
  expect(log.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(other.requestId).not.toBe(log.requestId);
  log.write("info", "request.completed", { status: 200, durationMs: 7, mode: "live", rag: true, password: "TOP_SECRET", message: "PRIVATE_CHAT", error: new Error("TOKEN") } as never);
  const record = info.mock.calls[0][0];
  expect(record).toMatchObject({ level: "info", event: "request.completed", route: "chat", requestId: log.requestId, status: 200, durationMs: 7, mode: "live", rag: true });
  expect(record.timestamp).toMatch(/^\d{4}-/);
  expect(JSON.stringify(record)).not.toMatch(/TOP_SECRET|PRIVATE_CHAT|TOKEN|password|stack/);
});

test("dependency failures log stable codes and status, never arbitrary nested values", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  createRequestLog("chat").write("error", "dependency.failed", { dependency: "rag", code: "rag_unavailable", upstreamStatus: 401, durationMs: 4, status: { secret: "SECRET" }, sourceCount: NaN } as never);
  expect(error.mock.calls[0][0]).toMatchObject({ dependency: "rag", code: "rag_unavailable", upstreamStatus: 401 });
  expect(JSON.stringify(error.mock.calls[0][0])).not.toMatch(/SECRET|sourceCount|"status"/);
});

test("warnings are emitted, but a failing log sink must not break a user request", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("sink offline"); });
  expect(() => createRequestLog("status").write("warn", "request.completed", { status: 400 })).not.toThrow();
  expect(warn).toHaveBeenCalledOnce();
});

test("cache usage logs accept only finite nonnegative numeric token counts", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const log = createRequestLog("chat");
  log.write("info", "dependency.completed", { dependency: "model", promptTokens: 100, cachedTokens: 64 } as never);
  expect(info.mock.calls[0][0]).toMatchObject({ promptTokens: 100, cachedTokens: 64 });
  log.write("info", "dependency.completed", { promptTokens: "PRIVATE_VALUE", cachedTokens: -1 } as never);
  expect(info.mock.calls[1][0]).not.toHaveProperty("promptTokens");
  expect(info.mock.calls[1][0]).not.toHaveProperty("cachedTokens");
  expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE_VALUE");
});
