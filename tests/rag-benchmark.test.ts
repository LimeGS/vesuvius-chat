import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("benchmark failures never print retained backend bodies on stdout or stderr", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", resolve("tests/fixtures/rag-benchmark-failure.mjs"), "scripts/check-rag-backends.ts"], { encoding: "utf8", timeout: 15_000 });
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).not.toContain("PRIVATE_BENCHMARK_UPSTREAM_SENTINEL");
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr.trim())).toEqual({ ok: false, code: "rag_benchmark_failed" });
});
