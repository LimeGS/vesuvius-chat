import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { initializeQuotaDatabase } from "../../scripts/init-quota.mjs";
const directories: string[] = [];
export function quotaDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "vesuvius-test-"));
  directories.push(directory);
  const path = join(directory, "quotas.sqlite");
  initializeQuotaDatabase(path);
  return path;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
