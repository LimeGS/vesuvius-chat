import { expect, test } from "vitest";
import { applyLimits, defaultLimits, type LimitState } from "../lib/quota";

test("atomic quota reservations enforce IP, global, daily and concurrency budgets", () => {
  const state: LimitState = { counters: {}, leases: {} };
  const input = { operation: "chat" as const, key: "a".repeat(64), limits: defaultLimits };
  expect(applyLimits(state, input, 1000)).toMatchObject({ allowed: true, lease: expect.any(String) });
  const second = applyLimits(state, input, 1000);
  expect(second.allowed).toBe(true);
  expect(applyLimits(state, input, 1000)).toMatchObject({ allowed: false, retryAfter: 185 });
  applyLimits(state, { operation: "release", lease: second.lease! }, 1000);
  expect(applyLimits(state, input, 1000).allowed).toBe(true);
  // Expired leases do not survive indefinitely after a cancelled/crashed request.
  expect(applyLimits(state, input, 187_000).allowed).toBe(true);
});

test("three-minute requests retain both slots until release or crash recovery expiry", () => {
  const state: LimitState = { counters: {}, leases: {} };
  const input = { operation: "chat" as const, key: "first", limits: defaultLimits };
  const first = applyLimits(state, input, 1000);
  applyLimits(state, { ...input, key: "second" }, 1000);
  expect(applyLimits(state, { ...input, key: "third" }, 51_001).allowed).toBe(false);
  expect(applyLimits(state, { ...input, key: "third" }, 180_999)).toMatchObject({ allowed: false, retryAfter: 6 });
  applyLimits(state, { operation: "release", lease: first.lease! }, 180_999);
  expect(applyLimits(state, { ...input, key: "third" }, 180_999).allowed).toBe(true);
  expect(applyLimits(state, { ...input, key: "fourth" }, 186_000).allowed).toBe(true);
});

test("per-IP and global minute limits cannot be reset by switching identities or sessions", () => {
  for (const dimension of ["ip", "minute"] as const) {
    const state: LimitState = { counters: {}, leases: {} };
    const limits = { ...defaultLimits, [dimension]: 1 };
    const input = { operation: "chat" as const, key: "a".repeat(64), limits };
    const first = applyLimits(state, input, 1000);
    applyLimits(state, { operation: "release", lease: first.lease! }, 1000);
    expect(applyLimits(state, { ...input, key: dimension === "minute" ? "b".repeat(64) : input.key }, 1000).allowed).toBe(false);
    expect(applyLimits(state, input, 61_001).allowed).toBe(true);
  }
});
test("identity storage has a hard bound and stale identities are eventually removed", () => {
  const state: LimitState = { counters: Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`login:${i}`, { count: 1, expires: 2000 }])), leases: {} };
  const input = { operation: "login" as const, key: "a".repeat(64), limits: defaultLimits };
  expect(applyLimits(state, input, 1000).allowed).toBe(false);
  expect(Object.keys(state.counters)).toHaveLength(512);
  expect(applyLimits(state, input, 2001).allowed).toBe(true);
  expect(Object.keys(state.counters)).toHaveLength(1);
});

test("anonymous login capacity cannot deny authenticated chat or an existing admitted login identity", () => {
  const state: LimitState = { counters: {}, leases: {} };
  for (let i = 0; i < 512; i++)
    expect(applyLimits(state, { operation: "login", key: String(i), limits: defaultLimits }, 1000).allowed).toBe(true);
  expect(applyLimits(state, { operation: "login", key: "new", limits: defaultLimits }, 1000).allowed).toBe(false);
  expect(applyLimits(state, { operation: "login", key: "0", limits: defaultLimits }, 1000).allowed).toBe(true);
  expect(applyLimits(state, { operation: "chat", key: "authenticated", limits: defaultLimits }, 1000).allowed).toBe(true);
  expect(state.counters.day.count).toBe(1);
});

test("login attempts and daily quotas survive serialization/restart", () => {
  let state: LimitState = { counters: {}, leases: {} };
  const login = { operation: "login" as const, key: "a".repeat(64), limits: defaultLimits };
  for (let i = 0; i < 5; i++) expect(applyLimits(state, login, 1000).allowed).toBe(true);
  state = JSON.parse(JSON.stringify(state));
  expect(applyLimits(state, login, 1000)).toMatchObject({ allowed: false, retryAfter: 900 });
  expect(applyLimits(state, login, 901_000).allowed).toBe(true);
  const input = { ...login, operation: "chat" as const, limits: { ...defaultLimits, day: 1 } };
  const first = applyLimits(state, input, 1000);
  applyLimits(state, { operation: "release", lease: first.lease! }, 1000);
  expect(applyLimits(state, input, 61_000).allowed).toBe(false);
  expect(applyLimits(state, input, 86_400_000).allowed).toBe(true);
});
