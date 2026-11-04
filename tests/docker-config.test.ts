import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("Docker initializes private credentials and quotas once without printing secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "vesuvius-docker-"));
  try {
    const env = { ...process.env, STATE_DIR: directory, APP_ORIGIN: "https://localhost:8443", OPENROUTER_MODEL: "chosen-model", OPENROUTER_API_KEY: "provider-secret", DOCKER_INIT_ONLY: "1" };
    const run = () => execFileSync(process.execPath, ["docker/app-entrypoint.mjs"], { env, encoding: "utf8" });
    expect(run()).not.toContain("provider-secret");
    const before = readFileSync(join(directory, "access.json"), "utf8");
    expect(JSON.parse(before).SESSION_SECRET).toMatch(/^[A-Za-z0-9_-]{48,}$/);
    expect(statSync(join(directory, "access.json")).mode & 0o777).toBe(0o600);
    const inode = statSync(join(directory, "quotas.sqlite")).ino;
    run();
    expect(readFileSync(join(directory, "access.json"), "utf8")).toBe(before);
    expect(statSync(join(directory, "quotas.sqlite")).ino).toBe(inode);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
