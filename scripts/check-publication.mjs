// Source-only publication guard. Findings contain rule names and relative files, never values.
import { readdir, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { relative, resolve } from "node:path";

const root = resolve(process.argv[2] || ".");
const generated = new Set([".git", "node_modules", ".next", "coverage", "__pycache__"]);
const findings = [];
let files = 0;
const rules = [
  ["personal-home-path", /\/(?:Users|home)\/[^\s"'`<>]+|[A-Z]:\\Users\\[^\s"']+/g],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["provider-secret", /\b(?:sk-or-v1|sk-proj)-[A-Za-z0-9_-]{20,}\b/g],
  ["deployment-host", /https?:\/\/(?:[a-z0-9-]+\.)+(?:internal|lan|local|monster)(?=[:/\s"']|$)/gi],
  ["real-discord-reference", /discord\.com\/channels\/\d{10,}/g],
];
const add = (file, rule) => findings.push({ file, rule });
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (generated.has(entry.name)) continue;
    const path = resolve(directory, entry.name), file = relative(root, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) { add(file, "symlink-not-reviewed"); continue; }
    if (entry.isDirectory()) {
      if (["deploy/state", "rag/bundle", ".rag-refresh", "outputs", ".agents", ".openai", ".superpowers"].includes(file)) { add(file, "private-directory"); continue; }
      await walk(path); continue;
    }
    files++;
    if ((/^\.env(?:\.|$)/.test(entry.name) && entry.name !== ".env.example") || /(?:\.env|\.sqlite(?:-wal|-shm)?|\.db|\.npy|\.jsonl|\.pem|\.key|\.tgz|\.tar|\.zip|\.log|\.local\.json)$/.test(entry.name) || /^ssh[-_]/.test(entry.name)) add(file, "private-artifact");
    if (/\.woff2$/.test(file)) continue; // Redistributed fonts retain public upstream license notices.
    const buffer = await readFile(path);
    if (buffer.includes(0)) { add(file, "unreviewed-binary"); continue; }
    const text = buffer.toString("utf8");
    for (const [name, pattern] of rules) if (text.match(pattern)) add(file, name);
    for (const address of text.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g) || []) {
      if (!isIP(address)) continue;
      if (!/^(?:127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(address) && address !== "0.0.0.0") { add(file, "non-documentation-ip"); break; }
    }
    for (const email of text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) || []) {
      if (!/@(?:[\w.-]+\.)?(?:example|invalid|test)$|@example\.(?:com|org|net)$/i.test(email)) { add(file, "non-synthetic-email"); break; }
    }
  }
}
await walk(root);
console.log(JSON.stringify({ ok: findings.length === 0, files, findings }, null, 2));
process.exitCode = findings.length ? 1 : 0;
