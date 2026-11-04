import { afterEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
afterEach(() => vi.unstubAllEnvs());
test("production proxy fails closed on missing configuration and untrusted HTTPS or host metadata", () => {
  vi.stubEnv("NODE_ENV", "production");
  for (const APP_ORIGIN of ["", "not an origin", "http://chat.example", "https://chat.example/path"]) {
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
    expect(proxy(new NextRequest("http://127.0.0.1/PRIVATE_SENTINEL")).status).toBe(503);
  }
  vi.stubEnv("APP_ORIGIN", "https://chat.example");
  for (const headers of [{ Host: "evil.invalid", "X-Forwarded-Proto": "https" }, { Host: "chat.example", "X-Forwarded-Proto": "http" }])
    expect(proxy(new NextRequest("http://127.0.0.1/", { headers })).status).toBe(503);
});
test("trusted proxy forwards only its generated script nonce and non-cacheable hardened response", () => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("APP_ORIGIN", "https://chat.example");
  const response = proxy(new NextRequest("http://127.0.0.1/", { headers: { Host: "chat.example", "X-Forwarded-Proto": "https", "X-Nonce": "attacker", "Content-Security-Policy": "attacker" } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("'nonce-");
  expect(response.headers.get("content-security-policy")).not.toContain("attacker");
  expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(response.headers.get("content-security-policy"));
  expect(response.headers.get("cache-control")).toBe("no-store");
});
