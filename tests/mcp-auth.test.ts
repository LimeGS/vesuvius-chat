import { expect, test } from "vitest";
import { requireMcpToken } from "../lib/auth";
import { applyLimits, defaultLimits, type LimitState } from "../lib/quota";

const env = { INVITATION_CODES: JSON.stringify(["a".repeat(32)]), SESSION_SECRET: "s".repeat(48) };
test("MCP accepts only a current invitation bearer, never cookies or query tokens", async () => {
  const request = (authorization?: string, url = "https://chat.example/mcp", origin?: string) => new Request(url, { headers: { ...(authorization ? { Authorization: authorization } : {}), ...(origin ? { Origin: origin } : {}) } });
  await expect(requireMcpToken(request(`Bearer ${"a".repeat(32)}`), env)).resolves.toBeUndefined();
  for (const header of [undefined, "Basic abc", "Bearer wrong", `Bearer ${"a".repeat(32)}, Bearer ${"a".repeat(32)}`])
    await expect(requireMcpToken(request(header), env)).rejects.toMatchObject({ status: 401 });
  await expect(requireMcpToken(request(`Bearer ${"a".repeat(32)}`, "https://chat.example/mcp?token=secret"), env)).rejects.toMatchObject({ status: 401 });
  await expect(requireMcpToken(request(`Bearer ${"a".repeat(32)}`), { ...env, INVITATION_CODES: JSON.stringify(["b".repeat(32)]) })).rejects.toMatchObject({ status: 401 });
  await expect(requireMcpToken(request(`Bearer ${"a".repeat(32)}`, undefined, "https://evil.example"), env)).rejects.toMatchObject({ status: 403 });
});

test("MCP quotas persist separately and cannot consume chat counters or leases", () => {
  let state: LimitState = { counters: {}, leases: {} };
  const call = (key = "one") => applyLimits(state, { operation: "mcp", key, limits: defaultLimits }, 1000);
  const a = call(), b = call();
  expect(a.allowed && b.allowed).toBe(true);
  expect(call().allowed).toBe(false);
  expect(applyLimits(state, { operation: "chat", key: "chat", limits: defaultLimits }, 1000).allowed).toBe(true);
  for (const lease of [a.lease!, b.lease!]) applyLimits(state, { operation: "release", lease }, 1000);
  for (let i = 2; i < 30; i++) {
    const r = call(); expect(r.allowed).toBe(true);
    applyLimits(state, { operation: "release", lease: r.lease! }, 1000);
  }
  state = JSON.parse(JSON.stringify(state));
  expect(call().allowed).toBe(false);
  expect(state.counters.day.count).toBe(1);
  for (let i = 0; i < 30; i++) {
    const r = call("two"); expect(r.allowed).toBe(true);
    applyLimits(state, { operation: "release", lease: r.lease! }, 1000);
  }
  expect(call("three").allowed).toBe(false);
});
