import { expect, test } from "vitest";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { setupAccess } from "../scripts/setup-access.mjs";
test("initial secrets are private, idempotent and preserve existing configuration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vesuvius-access-"));
  try {
    const file = path.join(dir, ".dev.vars");
    await writeFile(file, "OPENROUTER_API_KEY=test-preserve\n", { mode: 0o600 });
    await setupAccess(file);
    const first = await readFile(file, "utf8");
    const values = parseEnv(first);
    expect(values.OPENROUTER_API_KEY).toBe("test-preserve");
    expect(JSON.parse(values.INVITATION_CODES!)[0]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(values.SESSION_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(values.LIMITS_DB_PATH).toBe(path.join(dir, ".data", "limits.sqlite"));
    expect((await stat(path.join(dir, ".data"))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await setupAccess(file); expect(await readFile(file, "utf8")).toBe(first);
    const link = path.join(dir, "link"); await symlink(file, link);
    await expect(setupAccess(link)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
