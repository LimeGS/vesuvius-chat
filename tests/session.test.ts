import { beforeEach, expect, test, vi } from "vitest";
import { env } from "node:process";
import { POST, GET, DELETE } from "../app/api/session/route";
import { quotaDatabase } from "./fixtures/quota-db";
const code = "a".repeat(32);
const req = (body: unknown = { code }, headers: Record<string, string> = {}) => new Request("http://127.0.0.1/api/session", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
beforeEach(() => {
  for (const key of Object.keys(env)) if (/^(?:CHAT_|OPENROUTER_|MCP_|LIMIT_|LIMITS_|INVITATION_CODES$|SESSION_SECRET$|APP_ORIGIN$)/.test(key)) delete env[key];
  Object.assign(env, { INVITATION_CODES: JSON.stringify([code]), SESSION_SECRET: "s".repeat(48), LIMITS_DB_PATH: quotaDatabase() });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
test("login creates a cookie, a separate request verifies it, logout clears it", async () => {
  const response = await POST(req());
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(JSON.stringify(await response.json())).not.toContain(code);
  expect((await GET(new Request("http://127.0.0.1/api/session", { headers: { Cookie: cookie } }))).status).toBe(200);
  const logout = await DELETE(new Request("http://127.0.0.1/api/session", { method: "DELETE" }));
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
});
test("bad codes, CSRF, invalid formats and large inputs are safely denied", async () => {
  for (const [request, status] of [[req({ code: "wrong" }), 401], [req({}, { Origin: "https://evil.example" }), 403], [req({}, { "Content-Type": "text/plain" }), 415], [req({ code: "x".repeat(6000) }), 413], [req({ code: 123 }), 400]] as const)
    expect((await POST(request)).status).toBe(status);
  expect((await GET(new Request("http://127.0.0.1/"))).status).toBe(401);
  expect((await DELETE(req({}, { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
});
test("login throttling returns Retry-After and never creates a session", async () => {
  for (let i = 0; i < 5; i++) expect((await POST(req())).status).toBe(200);
  const response = await POST(req());
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(response.headers.has("set-cookie")).toBe(false);
});
