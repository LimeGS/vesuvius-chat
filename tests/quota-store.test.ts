import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { applyPersistentLimits } from "../lib/quota-store";
import { defaultLimits } from "../lib/quota";
import { initializeQuotaDatabase } from "../scripts/init-quota.mjs";

const directories: string[] = [];
function database() { const dir = mkdtempSync(join(tmpdir(), "quota-test-")); directories.push(dir); const path = join(dir, "quotas.sqlite"); initializeQuotaDatabase(path); return path; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("SQLite quotas survive reopen, preserve budgets and expire leases", () => {
  const path = database();
  const input = { operation: "chat" as const, key: "a".repeat(64), limits: { ...defaultLimits, day: 1 } };
  const first = applyPersistentLimits(path, input, 1000);
  expect(first.allowed).toBe(true);
  applyPersistentLimits(path, { operation: "release", lease: first.lease! }, 1000);
  expect(applyPersistentLimits(path, { ...input, key: "b".repeat(64) }, 61_000)).toMatchObject({ allowed: false });
  expect(applyPersistentLimits(path, input, 86_400_000).allowed).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path).includes(Buffer.from("PRIVATE_MESSAGE"))).toBe(false);
});
test("corrupt state and unavailable storage fail instead of resetting budgets", () => {
  expect(() => applyPersistentLimits("/missing-parent/no.sqlite", { operation: "release", lease: "x" }, 1000)).toThrow();
  const path = database(); const db = new DatabaseSync(path);
  db.exec("UPDATE quotas SET state='null'"); db.close();
  expect(() => applyPersistentLimits(path, { operation: "release", lease: "x" }, 1000)).toThrow();
});
test("separate processes atomically reserve only the two available slots", async () => {
  const path = database();
  const code = `import { applyPersistentLimits } from './lib/quota-store.ts'; import { defaultLimits } from './lib/quota.ts'; console.log(JSON.stringify(applyPersistentLimits(process.argv[1], { operation:'chat', key:'a'.repeat(64), limits:defaultLimits }, 1000)));`;
  const run = () => new Promise<{ allowed: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, path], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "", errors = ""; child.stdout.on("data", chunk => { text += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.on("error", reject); child.on("close", exit => exit === 0 ? resolve(JSON.parse(text)) : reject(new Error(`Quota process failed: ${errors}`)));
  });
  const results = await Promise.all(Array.from({ length: 8 }, run));
  expect(results.filter(result => result.allowed)).toHaveLength(2);
});

test("reopening SQLite cannot expire three-minute capacity reservations after the old 50 seconds", () => {
  const path = database();
  const input = { operation: "chat" as const, key: "first", limits: defaultLimits };
  const first = applyPersistentLimits(path, input, 1000);
  expect(applyPersistentLimits(path, { ...input, key: "second" }, 1000).allowed).toBe(true);
  expect(applyPersistentLimits(path, { ...input, key: "third" }, 51_001).allowed).toBe(false);
  expect(applyPersistentLimits(path, { ...input, key: "third" }, 180_999).allowed).toBe(false);
  applyPersistentLimits(path, { operation: "release", lease: first.lease! }, 180_999);
  expect(applyPersistentLimits(path, { ...input, key: "third" }, 180_999).allowed).toBe(true);
});

test("lost, empty or missing-state storage never recreates spending capacity", () => {
  for (const damage of ["deleted", "empty", "missing-state"]) {
    const path = database();
    const input = { operation: "chat" as const, key: "a".repeat(64), limits: { ...defaultLimits, day: 1 } };
    expect(applyPersistentLimits(path, input, 1000).allowed).toBe(true);
    expect(applyPersistentLimits(path, input, 1001).allowed).toBe(false);
    if (damage === "deleted") rmSync(path);
    else if (damage === "empty") writeFileSync(path, "");
    else { const db = new DatabaseSync(path); db.exec("DELETE FROM quotas"); db.close(); }
    expect(() => applyPersistentLimits(path, input, 1002), damage).toThrow();
  }
});

test("explicit quota initialization is private and cannot overwrite existing budgets", async () => {
  const { initializeQuotaDatabase } = await import("../scripts/init-quota.mjs");
  const path = database();
  // database() is an initialized fixture; the operator initializer must refuse it.
  expect(() => initializeQuotaDatabase(path)).toThrow();
  const fresh = path + ".fresh";
  initializeQuotaDatabase(fresh);
  expect(statSync(fresh).mode & 0o777).toBe(0o600);
  const input = { operation: "chat" as const, key: "a".repeat(64), limits: { ...defaultLimits, day: 1 } };
  expect(applyPersistentLimits(fresh, input, 1000).allowed).toBe(true);
  expect(() => initializeQuotaDatabase(fresh)).toThrow();
  expect(applyPersistentLimits(fresh, input, 1001).allowed).toBe(false);
});

test("operator initialization works through the atomic current-release symlink", () => {
  const path = database() + ".fresh";
  const script = join(dirname(path), "init.mjs");
  symlinkSync(resolve("scripts/init-quota.mjs"), script);
  const result = spawnSync(process.execPath, [script, path], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(existsSync(path)).toBe(true);
});
