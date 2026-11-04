import { expect, test } from "vitest";
import { limitStore, readLimits, reserveLimit } from "../lib/limits";
import { defaultLimits } from "../lib/quota";
import { quotaDatabase } from "./fixtures/quota-db";
import { DatabaseSync } from "node:sqlite";
const env = () => ({ INVITATION_CODES: JSON.stringify(["a".repeat(32)]), SESSION_SECRET: "s".repeat(48), LIMITS_DB_PATH: quotaDatabase() });
const local = () => new Request("http://127.0.0.1/");
test("limits validate configuration and require an absolute persistent path", () => {
  expect(readLimits({})).toEqual(defaultLimits);
  expect(readLimits({ LIMIT_CHAT_GLOBAL_PER_DAY: "22" }).day).toBe(22);
  for (const value of ["", "NaN", "-1", "1.5", "1000001"]) expect(() => readLimits({ LIMIT_CHAT_GLOBAL_PER_DAY: value })).toThrow();
  for (const settings of [{}, { LIMITS_DB_PATH: "relative.sqlite" }]) expect(() => limitStore(settings)).toThrow();
});
test("only the canonical local proxy identity is trusted and stored IPs are keyed hashes", async () => {
  const settings = { ...env(), CHAT_ENV: "production", APP_ORIGIN: "https://chat.example" };
  const headers = { Host: "chat.example", "X-Forwarded-Proto": "https", "X-Real-IP": "192.0.2.1", "CF-Connecting-IP": "evil", "X-Forwarded-For": "evil" };
  for (const changes of [{ "X-Real-IP": "" }, { "X-Real-IP": "not-an-ip" }, { "X-Forwarded-Proto": "http" }, { Host: "evil.example" }])
    await expect(reserveLimit(new Request("https://chat.example/", { headers: { ...headers, ...changes } }), settings, "chat")).rejects.toMatchObject({ status: 503 });
  const release = await reserveLimit(new Request("https://chat.example/", { headers }), settings, "chat");
  const db = new DatabaseSync(settings.LIMITS_DB_PATH);
  const state = String(db.prepare("SELECT state FROM quotas").get()!.state); db.close();
  expect(state).not.toMatch(/192\.0\.2\.1|evil/);
  expect(state).toMatch(/chat:[a-f0-9]{64}/);
  await release();
});
test("unavailable storage fails closed and real quota denial supplies Retry-After", async () => {
  await expect(reserveLimit(local(), { ...env(), LIMITS_DB_PATH: "/missing-parent/no.sqlite" }, "chat")).rejects.toMatchObject({ code: "limits_unavailable" });
  const settings = { ...env(), LIMIT_LOGIN_PER_15_MINUTES: "1" };
  await reserveLimit(local(), settings, "login");
  await expect(reserveLimit(local(), settings, "login")).rejects.toMatchObject({ status: 429, retryAfter: expect.any(Number) });
});
