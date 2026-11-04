// Badges are verified release snapshots, not fabricated live CI status.
import { readFile, mkdir, writeFile } from "node:fs/promises";

const coverage = JSON.parse(await readFile("coverage/coverage-summary.json", "utf8")).total;
const audit = JSON.parse(await readFile("audit.json", "utf8"));
const metrics = Object.fromEntries(["lines", "statements", "branches", "functions"].map(name => [name, coverage[name]?.pct]));
const minimum = Math.min(...Object.values(metrics));
if (Object.values(metrics).some(value => !Number.isFinite(value) || value <= 90 || value > 100)) throw new Error("All four application coverage metrics must exceed 90%.");
if (audit.error || audit.metadata?.vulnerabilities?.total !== 0) throw new Error("Dependency audit must report zero vulnerabilities.");
const date = new Date().toISOString().slice(0, 10);
if (!process.argv.includes("--check")) {
  await mkdir("docs/badges", { recursive: true });
  const badge = (label, value) => `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="20" role="img" aria-label="${label}: ${value}"><title>${label}: ${value}</title><rect width="220" height="20" rx="3" fill="#555"/><path d="M100 0h117q3 0 3 3v14q0 3-3 3H100z" fill="#287d30"/><g fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11"><text x="50" y="14">${label}</text><text x="160" y="14">${value}</text></g></svg>\n`;
  await writeFile("docs/badges/coverage.svg", badge("app coverage", `${minimum.toFixed(2)}% min`));
  await writeFile("docs/badges/audit.svg", badge("npm audit", "0 vulnerabilities"));
  await writeFile("docs/verification.md", `# Release verification\n\nVerified ${date} using this release's lockfile. These badges are snapshots, not live\nGitHub status or a promise that future dependency audits will remain clean.\n\n| Application metric | Coverage |\n| --- | --- |\n${Object.entries(metrics).map(([name, value]) => `| ${name} | ${value.toFixed(2)}% |`).join("\n")}\n\nAll four metrics exceed **90%**. Scope: executable application/lib/proxy TypeScript\ncovered by Vitest; Python backend tests run separately and are not included in this\npercentage. Dependencies, generated code and model weights are excluded.\n\n**npm audit: 0 vulnerabilities**, including development dependencies.\n\nReproduce with:\n\n\`\`\`sh\nnpm run test:coverage -- --maxWorkers=1\nnpm audit --json > audit.json\nnpm run badges:update\nnpm run check:publication\n\`\`\`\n\nThe Quality workflow enforces the same coverage floor and audit gate. Model weights,\nlive Discord credentials, paid generation and NVIDIA hardware are not exercised by\nthese offline verification commands. Keep generated reports and credentials out of\nsource publication.\n`);
}
console.log(JSON.stringify({ ok: true, coverage: metrics, minimum, vulnerabilities: 0, verified: date }));
