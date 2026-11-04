import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test("publication scan accepts synthetic examples and refuses private material without echoing it", () => {
  const directory = mkdtempSync(join(tmpdir(), "publication-test-"));
  const run = () => spawnSync(process.execPath, [resolve("scripts/check-publication.mjs"), directory], { encoding: "utf8" });
  try {
    writeFileSync(join(directory, "example.txt"), "https://rag.example/mcp 127.0.0.1 192.0.2.1");
    expect(run().status).toBe(0);
    const secret = "PRIVATE_SENTINEL_" + "x".repeat(30);
    writeFileSync(join(directory, ".env"), "OPENROUTER_API_KEY=" + secret);
    const denied = run();
    expect(denied.status).toBe(1); expect(denied.stdout + denied.stderr).not.toContain(secret);
    rmSync(join(directory, ".env"));
    writeFileSync(join(directory, "example.txt"), ["", "Users", "example", "project"].join("/"));
    expect(run().status).toBe(1);
    writeFileSync(join(directory, "example.txt"), [8, 8, 4, 4].join("."));
    expect(run().status).toBe(1);
    writeFileSync(join(directory, "example.txt"), "safe");
    mkdirSync(join(directory, "rag/bundle"), { recursive: true });
    writeFileSync(join(directory, "rag/bundle", "corpus.jsonl"), secret);
    expect(run().status).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("release badges require measured coverage above 90 percent and a clean audit", () => {
  const directory = mkdtempSync(join(tmpdir(), "badge-test-"));
  const run = () => spawnSync(process.execPath, [resolve("scripts/update-badges.mjs")], { cwd: directory, encoding: "utf8" });
  try {
    mkdirSync(join(directory, "coverage"));
    const metrics = { total: { lines: { pct: 99 }, statements: { pct: 97 }, branches: { pct: 94 }, functions: { pct: 98 } } };
    writeFileSync(join(directory, "coverage/coverage-summary.json"), JSON.stringify(metrics));
    writeFileSync(join(directory, "audit.json"), JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }));
    expect(run().status).toBe(0);
    expect(readFileSync(join(directory, "docs/badges/coverage.svg"), "utf8")).toContain("94.00% min");
    metrics.total.branches.pct = 90;
    writeFileSync(join(directory, "coverage/coverage-summary.json"), JSON.stringify(metrics));
    expect(run().status).toBe(1);
    metrics.total.branches.pct = 94;
    writeFileSync(join(directory, "coverage/coverage-summary.json"), JSON.stringify(metrics));
    writeFileSync(join(directory, "audit.json"), JSON.stringify({ metadata: { vulnerabilities: { total: 1 } } }));
    expect(run().status).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
