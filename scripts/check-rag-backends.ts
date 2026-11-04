// Fixed synthetic paired trial. Never print queries, source text or answer content.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { retrieveDocuments } from "../lib/rag";

const cases = [
  { id: "spiral-en", query: "What is spiral fit?" },
  { id: "ink-en", query: "How is ink detected in Herculaneum scrolls?" },
  { id: "spiral-es", query: "¿Qué es spiral fit?" },
];
const backends = { cpu: "http://127.0.0.1:8765/mcp", gpu: "http://127.0.0.1:18765/mcp" };
type Row = { caseId: string; repetition: number; backend: "cpu" | "gpu"; elapsedMs: number; sourceHashes: string[]; evidenceHashes: string[] };
try {
  const rows: Row[] = [];
  for (let repetition = 0; repetition < 2; repetition++) {
    for (const item of cases) {
      for (const backend of (repetition ? ["gpu", "cpu"] : ["cpu", "gpu"]) as ("cpu" | "gpu")[]) {
        const started = performance.now();
        const documents = await retrieveDocuments({ url: backends[backend], tool: "search_discord" }, item.query, AbortSignal.timeout(180_000));
        assert.ok(documents.length > 0 && documents.length <= 5, "Expected bounded, nonempty synthetic research evidence");
        assert.ok(documents.every(document => document.url?.startsWith("https://discord.com/channels/")), "Invalid evidence permalink");
        assert.ok(documents.reduce((sum, document) => sum + document.text.length, 0) <= 16_000);
        const digest = (value: string) => createHash("sha256").update(value).digest("hex");
        rows.push({ caseId: item.id, repetition, backend, elapsedMs: Math.round(performance.now() - started), sourceHashes: documents.map(document => digest(document.url!)), evidenceHashes: documents.map(document => digest(JSON.stringify([document.title, document.text, document.url]))) });
      }
    }
  }
  const timings = (backend: "cpu" | "gpu") => rows.filter(row => row.backend === backend).map(row => row.elapsedMs).sort((a, b) => a - b);
  const summarize = (values: number[]) => ({ samples: values.length, minimumMs: values[0], medianMs: (values[2] + values[3]) / 2, maximumMs: values.at(-1) });
  const summary = { cpu: summarize(timings("cpu")), gpu: summarize(timings("gpu")) };
  const overlap = rows.filter(row => row.backend === "cpu").map(cpu => {
    const gpu = rows.find(row => row.backend === "gpu" && row.caseId === cpu.caseId && row.repetition === cpu.repetition)!;
    return { caseId: cpu.caseId, repetition: cpu.repetition, cpuSources: cpu.sourceHashes.length, gpuSources: gpu.sourceHashes.length, sharedSources: cpu.sourceHashes.filter(hash => gpu.sourceHashes.includes(hash)).length, identicalExcerpts: cpu.evidenceHashes.filter(hash => gpu.evidenceHashes.includes(hash)).length };
  });
  console.log(JSON.stringify({ rows, summary, overlap, realModelRequests: 0, conversationContentPersisted: false }, null, 2));
  assert.ok(summary.gpu.medianMs < summary.cpu.medianMs, "GPU trial did not improve median retrieval time; do not promote");
  assert.ok(timings("gpu").every(value => value < 15_000), "GPU did not fit the primary-attempt budget; do not promote");
  assert.ok(overlap.every(row => row.sharedSources >= 4), "Material source differences require inspection before promotion");
} catch {
  console.error(JSON.stringify({ ok: false, code: "rag_benchmark_failed" }));
  process.exitCode = 1;
}
