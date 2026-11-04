import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import * as rag from "../lib/rag";
import type { TemporalScope } from "../lib/chat-time";

const now = "2026-11-03T13:00:00.000Z";
const scope: TemporalScope = { now, timeZone: "UTC", timezoneFallback: true, since: "2026-11-02T00:00:00.000Z", until: "2026-11-03T00:00:00.000Z", list: true };
const info = { version: 1, snapshot: "fixture-v1", backend: "cpu", coverageStart: "2026-10-01T00:00:00Z", coverageEnd: "2026-11-03T12:59:00Z", updatedAt: "2026-11-03T12:59:00Z", latestMessageAt: "2026-11-03T12:58:00Z", messageCount: 123, capabilities: { structured: true } };
const filters = { since: { type: "string" }, until: { type: "string" }, channel: { type: "string" }, author: { type: "string" } };
const schemas = {
  corpus_info: { type: "object", properties: {} },
  search_messages: { type: "object", properties: { query: { type: "string" }, ...filters, limit: { type: "integer" } }, required: ["query"] },
  list_messages: { type: "object", properties: { ...filters, limit: { type: "integer" }, cursor: { type: "string" } } },
  get_message: { type: "object", properties: { message_id: { type: "string" }, ...filters }, required: ["message_id"] },
  get_thread: { type: "object", properties: { message_id: { type: "string" }, ...filters, limit: { type: "integer" }, cursor: { type: "string" } }, required: ["message_id"] },
};
const catalog = Object.entries(schemas).map(([name, inputSchema]) => ({ name, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false } }));
type WireCall = { name: string; arguments: Record<string, unknown> };
function message(id = "100", extra: Record<string, unknown> = {}) {
  return { messageId: id, timestamp: "2026-11-02T12:00:00+00:00", channelId: "2", channel: "research", authorId: "3", author: "Original Author", threadId: null, text: "Synthetic finding", url: `https://discord.com/channels/1/2/${id}`, ...extra };
}
function page(messages: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { version: 1, snapshot: "fixture-v1", messages, nextCursor: null, exhaustive: true, ...extra };
}
async function fixture(
  run: (url: string, calls: WireCall[], lifecycle: string[]) => Promise<void>,
  options: { info?: unknown; tools?: unknown[]; result?: (call: WireCall) => unknown | Promise<unknown>; discoveryDelay?: number; raw?: unknown; redirect?: string } = {},
) {
  const calls: WireCall[] = [], lifecycle: string[] = [];
  const server = createServer(async (request, response) => {
    lifecycle.push(request.method!);
    if (options.redirect) { response.writeHead(302, { Location: options.redirect }).end(); return; }
    if (request.method === "DELETE") { response.writeHead(200).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    lifecycle.push(rpc.method);
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    if (rpc.method === "server/discover") {
      if (options.discoveryDelay) await new Promise(resolve => setTimeout(resolve, options.discoveryDelay));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } })); return;
    }
    let result: unknown;
    switch (rpc.method) {
      case "initialize": result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } }; break;
      case "tools/list": result = { tools: options.tools ?? catalog }; break;
      case "tools/call": {
        calls.push(rpc.params);
        const structuredContent = rpc.params.name === "corpus_info" ? (options.info ?? info) : await (options.result?.(rpc.params) ?? page());
        result = options.raw ?? { content: [], structuredContent }; break;
      }
      default: result = {};
    }
    response.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "synthetic-session" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls, lifecycle); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function research() { return import("../lib/rag-research"); }
const config = (ragUrl: string) => ({ ragUrl, ragToken: "SYNTHETIC_TOKEN" });
const signal = () => AbortSignal.timeout(5_000);

test("legacy snapshots with unknown message count report unsupported capability, not service failure", async () => {
  const { withResearch, ResearchUnsupportedError } = await research();
  await fixture(async url => {
    await assert.rejects(withResearch(config(url), scope, signal(), async session => session.initial("date")), ResearchUnsupportedError);
  }, { info: { ...info, messageCount: null, capabilities: { structured: false } } });
});

test("the exclusive end of corpus coverage is already outside coverage", async () => {
  const { withResearch } = await research();
  await fixture(async (url, calls) => withResearch(config(url), { ...scope, since: info.coverageEnd, until: "2026-11-04T00:00:00Z" }, signal(), async session => {
    await session.initial("date");
    assert.equal(session.summary().state, "outside_coverage");
    assert.equal(calls.length, 1);
  }));
});

test("chronology preserves microseconds before comparing the string ID tie-breaker", async () => {
  const { withResearch } = await research();
  for (const messages of [
    [message("20", { timestamp: "2026-11-02T12:00:00.000100Z" }), message("10", { timestamp: "2026-11-02T12:00:00.000200Z" })],
    [message("11"), message("2")],
  ]) await fixture(async url => withResearch(config(url), scope, signal(), async session => {
    await session.initial("list"); assert.equal(session.reviewed, 2);
  }), { result: () => page(messages) });
});

test("shared lifecycle exposes the connected client and always terminates its MCP session", async () => {
  assert.equal(typeof rag.withRagClient, "function");
  await fixture(async (url, _calls, lifecycle) => {
    const result = await rag.withRagClient({ url, tool: "unused" }, signal(), async client => (await client.listTools()).tools.length);
    assert.equal(result, 5);
    assert.ok(lifecycle.includes("DELETE"));
  });
});

test("structured research injects immutable scope and retains original provenance", async () => {
  const { withResearch } = await research();
  await fixture(async (url, calls, lifecycle) => {
    await withResearch(config(url), { ...scope, channel: "research", author: "3" }, signal(), async session => {
      await session.initial("anything");
      assert.deepEqual(calls, [{ name: "corpus_info", arguments: {} }, { name: "list_messages", arguments: { since: scope.since, until: scope.until, channel: "research", author: "3", limit: 20 } }]);
      assert.equal(session.info.snapshot, "fixture-v1");
      assert.equal(session.calls, 2);
      assert.equal(session.reviewed, 1);
      assert.equal(session.complete, true);
      assert.equal(session.absenceVerified, false);
      assert.equal(session.documents[0].date, "2026-11-02");
      assert.equal(session.documents[0].url, "https://discord.com/channels/1/2/100");
      assert.equal(session.documents[0].timestamp, "2026-11-02T12:00:00+00:00");
      assert.equal(session.documents[0].messageId, "100");
      assert.equal(session.documents[0].channel, "research");
      assert.equal(session.documents[0].author, "Original Author");
      assert.match(session.documents[0].text, /Original Author[\s\S]*2026-11-02T12:00:00\+00:00[\s\S]*research/);
      assert.match(session.context(), /fixture-v1/);
      assert.doesNotMatch(session.context(), /SYNTHETIC_TOKEN/);
      assert.equal(session.summary().state, "complete");
    });
    assert.ok(lifecycle.includes("DELETE"));
  }, { result: () => page([message()]) });
});

test.each(["missing", "destructive", "writable", "unannotated", "schema", "unknown-required", "inherited-required"])("unsupported %s catalogs never invoke content tools", async kind => {
  const { withResearch, ResearchUnsupportedError } = await research();
  const tools = structuredClone(catalog) as Array<Record<string, any>>;
  if (kind === "missing") tools.pop();
  if (kind === "destructive") tools[1].annotations.destructiveHint = true;
  if (kind === "writable") tools[1].annotations.readOnlyHint = false;
  if (kind === "unannotated") delete tools[1].annotations.readOnlyHint;
  if (kind === "schema") tools[1].inputSchema.properties.query.type = "number";
  if (kind === "unknown-required") tools[1].inputSchema.required.push("shell_command");
  if (kind === "inherited-required") tools[1].inputSchema.required.push("constructor");
  await fixture(async (url, calls) => {
    await assert.rejects(withResearch(config(url), scope, signal(), async session => session.initial("test")), ResearchUnsupportedError);
    assert.equal(calls.length, 0);
  }, { tools });
});

test("model calls cannot select arbitrary tools, widen scope, or open unobserved IDs", async () => {
  const { withResearch } = await research();
  const log = vi.spyOn(console, "error");
  await fixture(async (url, calls) => {
    await withResearch(config(url), scope, signal(), async session => {
      await session.initial("test");
      const before = calls.length;
      for (const [name, args] of [["delete_messages", {}], ["corpus_info", {}], ["list_messages", { since: "2000-01-01" }], ["list_messages", { author: "SYNTHETIC_PRIVATE" }], ["list_messages", { limit: 21 }], ["search_messages", { query: "x".repeat(1201) }], ["search_messages", {}], ["get_message", { message_id: "999" }], ["get_thread", { message_id: "100", cursor: "forged" }]] as const) {
        await assert.rejects(session.call(name, args), error => error instanceof Error && !error.message.includes("SYNTHETIC_PRIVATE"));
      }
      assert.equal(calls.length, before);
    });
  }, { result: () => page([message()]) });
  assert.equal(log.mock.calls.length, 0);
});

test.each([
  { timestamp: "2026-11-03T00:00:00Z" }, { timestamp: "2026-11-01T23:59:59Z" },
  { timestamp: "2026-02-30T12:00:00Z" }, { timestamp: "2026-11-02 12:00:00" },
  { channelId: "99", url: "https://discord.com/channels/1/99/100" }, { authorId: "99", author: "Other" },
  { messageId: "not-id" }, { url: "https://discord.com/channels/1/2/999" },
  { url: "https://attacker.example/channels/1/2/100" }, { text: "x".repeat(4001) },
])("wrong scope or malformed message is rejected rather than silently postfiltered: %j", async extra => {
  const { withResearch } = await research();
  await fixture(async url => {
    await withResearch(config(url), { ...scope, channel: "2", author: "3" }, signal(), async session => {
      await assert.rejects(session.initial("test"));
      assert.equal(session.complete, false);
      assert.equal(session.absenceVerified, false);
      assert.equal(session.documents.length, 0);
    });
  }, { result: () => page([message("100", extra)]) });
});

test("exact half-open day includes its first instant and accepts canonical offset timestamps", async () => {
  const { withResearch } = await research();
  await fixture(async url => withResearch(config(url), scope, signal(), async session => {
    await session.initial("test");
    assert.equal(session.reviewed, 2);
    assert.equal(session.complete, true);
  }), { result: () => page([message("100", { timestamp: "2026-11-02T00:00:00Z" }), message("101", { timestamp: "2026-11-03T00:59:59+01:00" })]) });
});

test.each(["fresh", "stale", "unknown", "overlap", "outside", "search"])("empty %s results distinguish verified absence from unknown coverage", async kind => {
  const { withResearch } = await research();
  const metadata = { ...info, ...(kind === "stale" ? { updatedAt: "2026-11-03T10:59:59Z" } : kind === "unknown" ? { updatedAt: null } : kind === "overlap" ? { coverageEnd: "2026-11-02T12:00:00Z" } : kind === "outside" ? { coverageEnd: "2026-11-01T23:59:59Z" } : {}) };
  await fixture(async (url, calls) => withResearch(config(url), { ...scope, list: kind !== "search" }, signal(), async session => {
    await session.initial("test");
    assert.equal(session.absenceVerified, kind === "fresh");
    assert.equal(session.stale, kind === "stale" || kind === "unknown");
    assert.equal(session.complete, kind === "fresh" || kind === "stale" || kind === "unknown");
    assert.equal(session.summary().state, kind === "outside" ? "outside_coverage" : session.complete ? "complete" : "partial");
    assert.ok(session.summary().notice.length > 0);
    assert.equal(calls.length, kind === "outside" ? 1 : 2);
  }), { info: metadata });
});

test("missing message metadata fails capability explicitly, never pretends zero hits", async () => {
  const { withResearch, ResearchUnsupportedError } = await research();
  await fixture(async (url, calls) => {
    await assert.rejects(withResearch(config(url), scope, signal(), async session => session.initial("test")), ResearchUnsupportedError);
    assert.equal(calls.length, 1);
  }, { info: { ...info, coverageStart: null, coverageEnd: null, messageCount: 0, capabilities: { structured: false } } });
});

test("chronological enumeration follows only sequential cursors, counts all 100 returned messages, retains first bounded evidence", async () => {
  const { withResearch, ResearchBudgetError } = await research();
  await fixture(async (url, calls) => withResearch(config(url), scope, signal(), async session => {
    await session.initial("test");
    assert.equal(session.reviewed, 100);
    assert.equal(session.calls, 6);
    assert.equal(session.exhausted, true);
    assert.equal(session.hasMore, true);
    assert.equal(session.complete, false);
    assert.equal(session.summary().state, "budget_exhausted");
    assert.equal(session.documents.length, 4);
    assert.equal(session.documents.reduce((n, doc) => n + doc.text.length, 0), 16_000);
    assert.ok(session.documents.every(doc => doc.text.length <= 4000));
    assert.deepEqual(session.documents.map(doc => doc.url?.split("/").at(-1)), ["100", "101", "102", "103"]);
    await assert.rejects(session.call("list_messages", { cursor: "5" }), ResearchBudgetError);
    assert.deepEqual(calls.slice(1).map(call => call.arguments.cursor), [undefined, "1", "2", "3", "4"]);
  }), { result: call => {
    const index = Number(call.arguments.cursor ?? 0);
    return page(Array.from({ length: 20 }, (_, i) => message(String(100 + index * 20 + i), { text: "x".repeat(4000) })), { nextCursor: String(index + 1), exhaustive: false });
  } });
});

test("a fully exhausted stable list chain is complete, but repeated cursors and changed snapshots are errors", async () => {
  const { withResearch } = await research();
  for (const mode of ["complete", "cursor", "snapshot"]) {
    await fixture(async url => withResearch(config(url), scope, signal(), async session => {
      if (mode === "complete") { await session.initial("test"); assert.equal(session.complete, true); assert.equal(session.reviewed, 2); }
      else { await assert.rejects(session.initial("test")); assert.equal(session.complete, false); assert.equal(session.absenceVerified, false); }
    }), { result: call => !call.arguments.cursor ? page([message()], { nextCursor: "next", exhaustive: false }) : page([message("101")], { nextCursor: mode === "cursor" ? "next" : null, snapshot: mode === "snapshot" ? "changed" : "fixture-v1" }) });
  }
});

test("call cap counts corpus_info and duplicates, stops initial gracefully and rejects further calls", async () => {
  const { withResearch, ResearchBudgetError } = await research();
  await fixture(async (url, calls) => withResearch(config(url), scope, signal(), async session => {
    await session.initial("test");
    assert.equal(session.calls, 8);
    assert.equal(session.reviewed, 7);
    assert.equal(session.exhausted, true);
    assert.equal(session.documents.length, 1);
    await assert.rejects(session.call("get_message", { message_id: "100" }), ResearchBudgetError);
    assert.equal(calls.length, 8);
  }), { result: call => page([message()], { nextCursor: `${Number(call.arguments.cursor ?? 0) + 1}`, exhaustive: false }) });
});

test("subsequent tools return compact metadata and replace current evidence with renumbered original messages", async () => {
  const { withResearch } = await research();
  await fixture(async (url, calls) => withResearch(config(url), { ...scope, list: false }, signal(), async session => {
    await session.initial("ink");
    assert.equal(calls[1].name, "search_messages");
    assert.equal(session.complete, false);
    assert.equal(session.absenceVerified, false);
    const result = await session.call("get_thread", { message_id: "100", limit: 20 }) as { messages: Array<Record<string, any>> };
    assert.equal(result.messages.length, 6);
    assert.equal(result.messages[0].text.length, 400);
    assert.equal(result.messages[0].messageId, "200");
    assert.equal(result.messages[0].authorId, "3");
    assert.deepEqual(session.documents.map(doc => doc.id), ["1", "2", "3", "4", "5"]);
    assert.deepEqual(session.documents.map(doc => doc.url?.split("/").at(-1)), ["200", "201", "202", "203", "204"]);
    assert.doesNotMatch(session.context(), /OLD_EVIDENCE/);
    await session.call("get_message", { message_id: "200" });
    assert.equal(calls[3].arguments.since, scope.since);
    await assert.rejects(session.call("get_thread", { message_id: "100", cursor: "not-issued" }));
  }), { result: call => call.name === "search_messages" ? page([message("100", { text: "OLD_EVIDENCE" })], { exhaustive: false }) : call.name === "get_message" ? page([message("200")]) : page(Array.from({ length: 6 }, (_, i) => message(String(200 + i), { text: "new".repeat(300) }))) });
});

test("an explicitly requested message may be opened without first appearing in results", async () => {
  const { withResearch } = await research();
  await fixture(async (url, calls) => withResearch(config(url), { ...scope, list: false, messageId: "999" }, signal(), async session => {
    await session.initial("open");
    assert.equal(calls[1].name, "get_message");
    assert.equal(calls[1].arguments.message_id, "999");
  }), { result: () => page([message("999")]) });
});

test("primary fallback happens only before valid corpus_info, never after partial research", async () => {
  const { withResearch } = await research();
  for (const mode of ["unsupported", "info-error", "info-type", "content-error", "empty-unsupported", "healthy"]) {
    await fixture(async (primary, primaryCalls) => fixture(async (backup, backupCalls) => {
      const operation = withResearch({ ...config(backup), ragPrimaryUrl: primary }, scope, signal(), async session => {
        await session.initial("test");
        assert.equal(session.info.backend, mode === "unsupported" || mode === "info-error" || mode === "info-type" ? "cpu" : "gpu");
      });
      if (mode === "content-error" || mode === "empty-unsupported") await assert.rejects(operation);
      else await operation;
      assert.equal(backupCalls.length > 0, mode === "unsupported" || mode === "info-error" || mode === "info-type");
      if (mode === "content-error") assert.equal(primaryCalls.length, 2);
    }), { tools: mode === "unsupported" ? [] : catalog, info: mode === "info-error" ? { version: 99 } : { ...info, backend: mode === "info-type" ? ["gpu"] : "gpu", capabilities: { structured: mode !== "empty-unsupported" } }, result: () => mode === "content-error" ? { private: "SYNTHETIC_PRIVATE_PAYLOAD" } : page() });
  }
});

test("successful primary disables its connection timer before long content research", async () => {
  const { withResearch } = await research();
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, ms: number, ...args: any[]) => original(callback, ms === 15_000 ? 40 : ms, ...args)) as typeof setTimeout);
  await fixture(async primary => fixture(async (backup, backupCalls) => {
    await withResearch({ ...config(backup), ragPrimaryUrl: primary }, scope, signal(), async session => { await session.initial("test"); assert.equal(session.complete, true); });
    assert.equal(backupCalls.length, 0);
  }), { result: async () => { await new Promise(resolve => setTimeout(resolve, 90)); return page(); } });
});

test("primary connection timeout falls back, caller cancellation never does, both clean up", async () => {
  const { withResearch } = await research();
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, ms: number, ...args: any[]) => original(callback, ms === 15_000 ? 40 : ms, ...args)) as typeof setTimeout);
  await fixture(async primary => fixture(async (backup, backupCalls) => {
    await withResearch({ ...config(backup), ragPrimaryUrl: primary }, scope, signal(), async session => session.initial("test"));
    assert.equal(backupCalls.length, 2);
  }), { discoveryDelay: 150 });
  const close = vi.spyOn(Client.prototype, "close");
  await fixture(async primary => fixture(async (backup, backupCalls) => {
    const controller = new AbortController();
    await withResearch({ ...config(backup), ragPrimaryUrl: primary }, scope, controller.signal, async session => {
      const pending = session.initial("test");
      setTimeout(() => controller.abort(new Error("caller cancelled")), 20);
      await assert.rejects(pending);
    });
    assert.equal(backupCalls.length, 0);
    // An aborted signal prevents DELETE delivery, but the client still must close.
    assert.equal(close.mock.calls.length, 1);
  }), { result: async () => { await new Promise(resolve => setTimeout(resolve, 150)); return page(); } });
});

test("90-second session clock is shared across tools, not restarted per call", async () => {
  const { withResearch, ResearchBudgetError } = await research();
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  await fixture(async (url, calls) => withResearch(config(url), { ...scope, list: false }, signal(), async session => {
    await session.initial("test");
    offset = 90_001;
    await assert.rejects(session.call("search_messages", { query: "second" }), ResearchBudgetError);
    assert.equal(session.exhausted, true);
    assert.equal(calls.length, 2);
  }));
});

test("oversized responses and redirects fail safely without following destinations or exposing raw content", async () => {
  const { withResearch } = await research();
  await fixture(async url => {
    await assert.rejects(withResearch(config(url), scope, signal(), async session => session.initial("test")), error => error instanceof Error && !error.message.includes("SYNTHETIC_PRIVATE_PAYLOAD"));
  }, { raw: { content: [{ type: "text", text: "SYNTHETIC_PRIVATE_PAYLOAD".repeat(100_000) }] } });
  const original = globalThis.fetch;
  const destinations: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => { destinations.push(String(input)); assert.equal(init?.redirect, "manual"); return original(input, init); });
  await fixture(async url => {
    await assert.rejects(withResearch(config(url), scope, signal(), async session => session.initial("test")));
    assert.ok(destinations.length > 0);
    assert.ok(destinations.every(destination => destination === url));
  }, { redirect: "http://127.0.0.1:1/never-follow" });
});

test.each([
  { version: 2 }, { snapshot: "s".repeat(129) }, { backend: ["cpu"] }, { backend: "other" },
  { messageCount: -1 }, { messageCount: 1.5 }, { updatedAt: "2026-11-03" },
  { coverageStart: null }, { coverageEnd: "2026-09-01T00:00:00Z" },
  { capabilities: { structured: "true" } },
])("corpus_info contract rejects incompatible metadata: %j", async extra => {
  const { withResearch } = await research();
  await fixture(async url => {
    let entered = false;
    await assert.rejects(withResearch(config(url), scope, signal(), async () => { entered = true; }));
    assert.equal(entered, false);
  }, { info: { ...info, ...extra } });
});

test("scope is copied before initialization and unrelated catalog tools are ignored", async () => {
  const { withResearch } = await research();
  const mutable = { ...scope, channel: "Research", author: "Original Author" };
  await fixture(async (url, calls) => {
    const pending = withResearch(config(url), mutable, signal(), async session => {
      await session.initial("test");
      await session.call("get_message", { message_id: "100" });
      assert.equal(calls[2].arguments.since, "2026-11-02T00:00:00.000Z");
      assert.equal(calls[2].arguments.channel, "Research");
    });
    mutable.since = "2000-01-01T00:00:00Z";
    mutable.channel = "not-research";
    await pending;
    assert.ok(calls.every(call => call.name !== "run_command"));
  }, { tools: [...catalog, { name: "run_command", inputSchema: { type: "object" }, annotations: { destructiveHint: true } }], result: () => page([message()]) });
});

test("thread cursors are bound to the observed message and cannot be replayed into lists or other threads", async () => {
  const { withResearch } = await research();
  await fixture(async (url, calls) => withResearch(config(url), { ...scope, list: false }, signal(), async session => {
    await session.initial("test");
    await session.call("get_thread", { message_id: "100" });
    await assert.rejects(session.call("list_messages", { cursor: "thread-next" }));
    await assert.rejects(session.call("get_thread", { message_id: "101", cursor: "thread-next" }));
    await session.call("get_thread", { message_id: "100", cursor: "thread-next" });
    await assert.rejects(session.call("get_thread", { message_id: "100", cursor: "thread-next" }));
    assert.equal(calls.length, 4);
  }), { result: call => call.name === "search_messages" ? page([message("100"), message("101")], { exhaustive: false }) : call.arguments.cursor ? page([message("102")]) : page([message("101")], { nextCursor: "thread-next", exhaustive: false }) });
});

test("remaining result allowance is sent to the backend and an over-returning page is rejected", async () => {
  const { withResearch } = await research();
  for (const overflow of [false, true]) {
    await fixture(async (url, calls) => withResearch(config(url), scope, signal(), async session => {
      if (overflow) { await assert.rejects(session.initial("test")); assert.equal(session.complete, false); }
      else { await session.initial("test"); assert.equal(session.reviewed, 100); assert.equal(session.complete, true); }
      assert.equal(calls[6].arguments.limit, 5);
    }), { result: call => {
      const index = Number(call.arguments.cursor ?? 0);
      return page(Array.from({ length: index < 5 ? 19 : overflow ? 6 : 5 }, (_, i) => message(String(100 + index * 20 + i))), { nextCursor: index < 5 ? String(index + 1) : null, exhaustive: index >= 5 });
    } });
  }
});

test("timed-out initial research is partial without throwing, while explicit tools throw a budget error", async () => {
  const { withResearch, ResearchBudgetError } = await research();
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, ms: number, ...args: any[]) => original(callback, ms === 90_000 ? 40 : ms, ...args)) as typeof setTimeout);
  await fixture(async url => withResearch(config(url), scope, signal(), async session => {
    await session.initial("test");
    assert.equal(session.exhausted, true);
    assert.equal(session.complete, false);
    assert.equal(session.absenceVerified, false);
    await assert.rejects(session.call("list_messages", {}), ResearchBudgetError);
  }), { result: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return page(); } });
});

test("caller abort during initialization never attempts the fallback", async () => {
  const { withResearch } = await research();
  await fixture(async primary => fixture(async (backup, backupCalls) => {
    const controller = new AbortController();
    const error = new Error("synthetic cancellation");
    const pending = withResearch({ ...config(backup), ragPrimaryUrl: primary }, scope, controller.signal, async () => { assert.fail("must not enter research"); });
    setTimeout(() => controller.abort(error), 20);
    await assert.rejects(pending, cause => cause === error);
    assert.equal(backupCalls.length, 0);
  }), { discoveryDelay: 100 });
});

test("failed context lookup invalidates any earlier exhaustive absence", async () => {
  const { withResearch } = await research();
  await fixture(async url => withResearch(config(url), { ...scope, messageId: "100" }, signal(), async session => {
    // Deliberately enumerate before opening the explicit message.
    await session.call("list_messages", {});
    assert.equal(session.absenceVerified, true);
    await assert.rejects(session.call("get_message", { message_id: "100" }));
    assert.equal(session.complete, false);
    assert.equal(session.absenceVerified, false);
    assert.equal(session.summary().state, "partial");
  }), { result: call => call.name === "list_messages" ? page() : page([], { snapshot: "changed" }) });
});

test("opening a message does not hide a still-pending thread cursor", async () => {
  const { withResearch } = await research();
  await fixture(async url => withResearch(config(url), { ...scope, list: false }, signal(), async session => {
    await session.initial("test");
    await session.call("get_thread", { message_id: "100" });
    assert.equal(session.hasMore, true);
    await session.call("get_message", { message_id: "100" });
    assert.equal(session.hasMore, true);
    await session.call("get_thread", { message_id: "100", cursor: "next" });
    assert.equal(session.hasMore, false);
  }), { result: call => call.name === "get_thread" && !call.arguments.cursor ? page([message()], { nextCursor: "next", exhaustive: false }) : page([message()]) });
});

test.each([
  { since: "2026-02-30T00:00:00Z" }, { since: "2026-11-04T00:00:00Z" },
  { now: "not-time" }, { messageId: "https://attacker.example" }, { ambiguous: "date is ambiguous" },
  { channel: "" }, { author: "" },
])("invalid scope fails before network access: %j", async extra => {
  const { withResearch } = await research();
  await fixture(async (url, _calls, lifecycle) => {
    await assert.rejects(withResearch(config(url), { ...scope, ...extra }, signal(), async () => {}));
    assert.equal(lifecycle.length, 0);
  });
});

test.each(["too-many", "wrong-version", "wrong-id", "get-cursor", "backwards"])("invalid %s pages fail closed", async mode => {
  const { withResearch } = await research();
  await fixture(async url => withResearch(config(url), { ...scope, messageId: "100" }, signal(), async session => {
    await assert.rejects(mode === "backwards" ? session.call("list_messages", {}) : session.initial("test"));
    assert.equal(session.absenceVerified, false);
    assert.equal(session.complete, false);
  }), { result: () => mode === "too-many" ? page(Array.from({ length: 21 }, () => message()))
    : mode === "wrong-version" ? page([], { version: 2 }) : mode === "wrong-id" ? page([message("999")])
    : mode === "get-cursor" ? page([message()], { nextCursor: "impossible", exhaustive: false })
    : page([message("101"), message("100")]) });
});

test("FastMCP nullable optional string schemas are supported without accepting incompatible unions", async () => {
  const { withResearch, ResearchUnsupportedError } = await research();
  for (const invalid of [false, true]) {
    const tools = catalog.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, properties: Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([key, value]) => [key, ["since", "until", "channel", "author", "cursor"].includes(key) ? { anyOf: [value, { type: "null" }, ...(invalid ? [{ type: "number" }] : [])], default: null } : value])) } }));
    await fixture(async (url, calls) => {
      const operation = withResearch(config(url), scope, signal(), async session => session.initial("test"));
      if (invalid) { await assert.rejects(operation, ResearchUnsupportedError); assert.equal(calls.length, 0); }
      else { await operation; assert.equal(calls.length, 2); }
    }, { tools });
  }
});

test("the configured sole backend may be GPU, but fallback after a failed primary must be CPU", async () => {
  const { withResearch, ResearchUnsupportedError } = await research();
  await fixture(async url => withResearch(config(url), scope, signal(), async session => {
    await session.initial("test"); assert.equal(session.info.backend, "gpu");
  }), { info: { ...info, backend: "gpu" } });
  await fixture(async primary => fixture(async backup => {
    await assert.rejects(withResearch({ ...config(backup), ragPrimaryUrl: primary }, scope, signal(), async () => {}), ResearchUnsupportedError);
  }, { info: { ...info, backend: "gpu" } }), { tools: [] });
});

test("a protocol error terminates the session instead of allowing later queries against uncertain state", async () => {
  const { withResearch } = await research();
  await fixture(async (url, calls) => withResearch(config(url), { ...scope, list: false }, signal(), async session => {
    await assert.rejects(session.initial("first"));
    await assert.rejects(session.call("search_messages", { query: "second" }));
    assert.equal(calls.length, 2);
  }), { result: () => page([], { snapshot: "changed" }) });
});

test.each([
  ["researcher_one", { username: "researcher_one" }, true],
  ["RESEARCHER_ONE", { username: "researcher_one" }, true],
  ["PaulH", { globalName: "paulh" }, true],
  ["3", { username: "researcher_one" }, true],
  ["Example Researcher", {}, true],
  ["researcher_one", {}, false],
  ["researcher_one", { username: "other" }, false],
  ["researcher_one", { username: 123 }, false],
  ["researcher_one", { username: "researcher_one", globalName: null }, false],
])("author filter %s verifies original IDs/display names or explicitly supplied aliases", async (author, aliases, valid) => {
  const { withResearch } = await research();
  await fixture(async url => withResearch(config(url), { ...scope, author }, signal(), async session => {
    const operation = session.initial("test");
    if (!valid) { await assert.rejects(operation); assert.equal(session.documents.length, 0); }
    else {
      await operation;
      assert.equal(session.documents[0].author, "Example Researcher");
      assert.match(session.documents[0].text, /Example Researcher/);
    }
  }), { result: () => page([message("100", { author: "Example Researcher", ...aliases })]) });
});
