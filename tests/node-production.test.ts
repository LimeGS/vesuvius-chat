import { expect, test, vi } from "vitest";
import { chatStatus, readServerConfig } from "../lib/chat-server";
import { securityConfig } from "../lib/auth";
import { secureRequest } from "../lib/security-headers";

test("a production Node runtime cannot silently opt into demonstration mode", () => {
  const config = readServerConfig({ NODE_ENV: "production", CHAT_ENV: "development" });
  expect(config.production).toBe(true);
  expect(() => chatStatus(config)).toThrow();
});
test("production access requires a canonical HTTPS origin, not just cookie secrets", () => {
  const base = { NODE_ENV: "production", INVITATION_CODES: JSON.stringify(["a".repeat(32)]), SESSION_SECRET: "s".repeat(48) };
  for (const APP_ORIGIN of [undefined, "http://chat.example", "https://user:password@chat.example", "https://chat.example/path"])
    expect(() => securityConfig({ ...base, APP_ORIGIN })).toThrow();
  expect(securityConfig({ ...base, APP_ORIGIN: "https://chat.example" }).production).toBe(true);
});
test("compiled Node security policy never permits development websocket destinations", () => {
  vi.stubEnv("NODE_ENV", "production");
  try { expect(secureRequest(new Request("https://chat.example/")).headers.get("content-security-policy")).not.toContain("ws://"); }
  finally { vi.unstubAllEnvs(); }
});
