import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { parseDocuments, retrieveDocuments } from "../lib/rag";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { answerChat, ChatError, readServerConfig } from "../lib/chat-server";

const discordText = `_consulta en ingles: ink detection_

### 1. #announcements · 2026-09-24 → 2026-09-24
participantes: Example Researcher (researcher_one) [equipo]
rollos: PHerc1447
- [2026-09-24 21:38] Previous context. <https://discord.com/channels/1/2/100>
- ★ [2026-09-24 21:39] PHerc 1447 remains eligible for the Grand Prize. <https://discord.com/channels/1/2/101>

### 2. #ink-detection · 2026-09-25 → 2026-09-25
participantes: Example
- ★ [2026-09-25 10:00] Another conversation. <https://discord.com/channels/1/2/102>
`;

// A wire-level MCP fixture exercises our client, tool selection and parser together.
async function withMcp(
  callback: (url: string, calls: string[]) => Promise<void>,
  result: Record<string, unknown> = { content: [{ type: "text", text: discordText }], structuredContent: { result: discordText }, isError: false },
  destructive = false,
  toolName = "search_discord",
  toolDelayMs = 0,
) {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    calls.push(rpc.method);
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    if (rpc.method === "server/discover") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }));
      return;
    }
    let value;
    switch (rpc.method) {
      case "initialize": value = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "discord-rag", version: "1" } }; break;
      case "tools/list": value = { tools: [{ name: toolName, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { destructiveHint: destructive } }] }; break;
      case "tools/call":
        assert.equal(rpc.params.name, toolName);
        assert.deepEqual(rpc.params.arguments, { query: "ink detection" });
        if (toolDelayMs) await new Promise(resolve => setTimeout(resolve, toolDelayMs));
        value = result;
        break;
      default: throw new Error(`Unexpected method: ${rpc.method}`);
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: value }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await callback(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("search_discord results become numbered evidence with the matching message permalink", async () => {
  await withMcp(async url => {
    const docs = await retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5_000));
    assert.equal(docs.length, 3);
    assert.equal(docs[0].id, "1");
    assert.equal(docs[0].title, "#announcements · 2026-09-24 → 2026-09-24");
    assert.match(docs[0].text, /PHerc 1447 remains eligible/);
    assert.match(docs[0].text, /^Conversation context \(not citable or proof of authorship\):/);
    assert.match(docs[0].text, /Citable message:\n\[2026-09-24 21:39\] PHerc 1447/);
    assert.equal(docs[0].url, "https://discord.com/channels/1/2/101");
    assert.equal(docs[1].id, "2");
    assert.doesNotMatch(docs[0].text, /Previous context/);
    assert.equal(docs[2].id, "3");
    assert.match(docs[2].text, /Previous context/);
    assert.doesNotMatch(docs[2].text, /remains eligible/);
    assert.equal(docs[2].url, "https://discord.com/channels/1/2/100");
  });
});

test("Discord posting dates belong to each cited message, not its conversation range", async () => {
  const text = `### 1. #announcements · 2025-11-01 → 2026-10-30
- ★ [2025-11-03 10:00] The application form was announced. <https://discord.com/channels/1/2/200>
- [2026-10-30 12:00] Later conversation context. <https://discord.com/channels/1/2/201>

### 2. #surface-detection · 2024-02-29 → 2024-03-02
- ★ [2024-02-29 08:30] Kaggle surface detection announcement. <https://discord.com/channels/1/2/300>

### 3. #announcements · 2026-10-31 → 2026-10-31
- ★ This message has no posting date. <https://discord.com/channels/1/2/400>`;
  await withMcp(async url => {
    const docs = await retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5000));
    assert.deepEqual(docs.map(doc => doc.date), ["2025-11-03", "2024-02-29", undefined, "2026-10-30"]);
    assert.deepEqual(docs.map(doc => doc.url?.split("/").at(-1)), ["200", "300", "400", "201"]);
    assert.match(docs[0].text, /application form was announced/);
    assert.doesNotMatch(docs[0].text, /Later conversation context/);
  }, { content: [{ type: "text", text }], isError: false });
});

test.each([
  ["2025-11-03", "2025-11-03"], ["2024-02-29", "2024-02-29"],
  ["2025-02-29", undefined], ["2026-13-01", undefined], ["2026-11-31", undefined],
  ["2026-11-01T12:00:00Z", undefined], ["not a date", undefined], [null, undefined], [123, undefined],
])("source calendar dates are validated without normalizing invalid days: %s", (date, expected) => {
  const docs = parseDocuments({ documents: [{ title: "Source", text: "Evidence", date }] });
  assert.equal(docs[0].date, expected);
  assert.equal(docs[0].text, "Evidence");
});

test("real retrieval may exceed the old 25-second allowance without losing its valid result", async () => {
  await withMcp(async url => {
    const docs = await retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(180_000));
    assert.equal(docs.length, 3);
  }, undefined, false, "search_discord", 26_000);
}, 35_000);

test("the caller deadline still cancels retrieval before its longer tool allowance", async () => {
  await withMcp(async url => {
    await assert.rejects(retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(100)));
  }, undefined, false, "search_discord", 300);
});

test("retrieval uses the redirect mode supported by the Workers runtime", async () => {
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.redirect === "error") throw new TypeError("Workers does not support redirect:error");
    return originalFetch(input, init);
  });
  await withMcp(async url => {
    const docs = await retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5_000));
    assert.equal(docs.length, 3);
  });
});

test("retrieval redirects are rejected without following the Location", async () => {
  const destinations: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    destinations.push(String(input));
    return new Response(null, { status: 302, headers: { Location: "https://attacker.example/mcp" } });
  });
  await assert.rejects(retrieveDocuments({ url: "https://rag.example/mcp", token: "secret", tool: "search_discord" }, "ink detection", AbortSignal.timeout(5_000)));
  assert.ok(destinations.length > 0);
  assert.ok(destinations.every(url => url === "https://rag.example/mcp"));
});

test("search_discord also accepts text-only MCP results from older servers", async () => {
  await withMcp(async url => {
    const docs = await retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5_000));
    assert.equal(docs.length, 3);
  }, { content: [{ type: "text", text: discordText }], isError: false });
});

test("Discord message evidence keeps distinct permalinks and prioritizes hits over surrounding context", async () => {
  const text = Array.from({ length: 6 }, (_, i) => `### ${i + 1}. #channel-${i}\nparticipantes: Example\n- [2026-10-01 10:00] Context-${i}. <https://discord.com/channels/1/2/${100 + i}>\n- ★ [2026-10-01 10:01] Hit-${i}. <https://discord.com/channels/1/2/${200 + i}>`).join("\n\n");
  await withMcp(async url => {
    const docs = await retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5000));
    assert.equal(docs.length, 5);
    assert.deepEqual(docs.map(doc => doc.url), Array.from({ length: 5 }, (_, i) => `https://discord.com/channels/1/2/${200 + i}`));
    assert.ok(docs.every(doc => !doc.text.includes("Context-")));
  }, { content: [{ type: "text", text }], isError: false });
});

test("overlapping Discord results do not duplicate a permalink under different source IDs", async () => {
  const text = "### 1. #first\n- ★ Hit. <https://discord.com/channels/1/2/200>\n- Other fact. <https://discord.com/channels/1/2/100>\n\n### 2. #overlap\n- ★ Hit. <https://discord.com/channels/1/2/200>";
  await withMcp(async url => {
    const docs = await retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5000));
    assert.deepEqual(docs.map(doc => doc.url), ["https://discord.com/channels/1/2/200", "https://discord.com/channels/1/2/100"]);
    assert.doesNotMatch(docs[0].text, /Other fact/);
    assert.match(docs[1].text, /Other fact/);
  }, { content: [{ type: "text", text }], isError: false });
});

test("oversized MCP results are rejected before being parsed into evidence or reaching the model", async () => {
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (String(input).startsWith("https://openrouter.ai/")) { modelCalls++; throw new Error("Must not reach model"); }
    return originalFetch(input, init);
  });
  await withMcp(async url => {
    await assert.rejects(answerChat([{ role: "user", content: "ink detection" }], readServerConfig({ OPENROUTER_API_KEY: "test", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: url, MCP_RAG_TOOL: "search_discord" }), AbortSignal.timeout(5000)), { status: 503, code: "rag_unavailable" });
  }, { content: [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }] });
  assert.equal(modelCalls, 0);
});

test.each(["healthy", "tool-error", "timeout"])("real MCP %s primary preserves evidence or returns to the CPU endpoint", async state => {
  const originalFetch = globalThis.fetch;
  const model = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => String(input) === "https://openrouter.ai/api/v1/chat/completions"
    ? Promise.resolve(Response.json({ choices: [{ message: { content: "Synthetic answer [1]." } }] }))
    : originalFetch(input, init));
  if (state === "timeout") {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => originalTimeout(milliseconds === 15_000 ? 50 : milliseconds));
  }
  const text = "### 1. #gpu\n- ★ GPU evidence. <https://discord.com/channels/1/2/300>";
  await withMcp(async (primary, primaryCalls) => {
    await withMcp(async (backup, backupCalls) => {
      const config = readServerConfig({ OPENROUTER_API_KEY: "test-only", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: backup, MCP_RAG_PRIMARY_URL: primary, MCP_RAG_TOOL: "search_discord" });
      const response = await answerChat([{ role: "user", content: "ink detection" }], config, AbortSignal.timeout(5_000));
      assert.equal(response.sources[0].url, state === "healthy" ? "https://discord.com/channels/1/2/300" : "https://discord.com/channels/1/2/101");
      assert.equal(backupCalls.includes("tools/call"), state !== "healthy");
      if (state !== "timeout") assert.ok(primaryCalls.includes("tools/call"));
      assert.equal(model.mock.calls.filter(call => String(call[0]) === "https://openrouter.ai/api/v1/chat/completions").length, 1);
    });
  }, { content: [{ type: "text", text }], isError: state === "tool-error" }, false, "search_discord", state === "timeout" ? 200 : 0);
});

test("a long conversation keeps its matching message inside the bounded model excerpt", async () => {
  const text = `### 1. #general · 2026-09-24 → 2026-09-24\nparticipantes: Example\n- [2026-09-24 10:00] ${"old context ".repeat(600)} <https://discord.com/channels/1/2/100>\n- ★ [2026-09-24 11:00] The relevant finding is here. <https://discord.com/channels/1/2/101>\n`;
  await withMcp(async url => {
    const docs = await retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5_000));
    assert.ok(docs[0].text.length <= 4_000);
    assert.match(docs[0].text, /The relevant finding is here/);
    assert.match(docs[0].text, /participantes: Example/);
  }, { content: [{ type: "text", text }], structuredContent: { result: text }, isError: false });
});

test("a genuine empty search does not fabricate evidence", async () => {
  await withMcp(async url => {
    assert.deepEqual(await retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5_000)), []);
  }, { content: [{ type: "text", text: "_consulta en ingles: ink detection_\n\n(sin resultados)" }], isError: false });
});

test("English no-results metadata is accepted by the Discord adapter", async () => {
  await withMcp(async url => {
    assert.deepEqual(await retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5_000)), []);
  }, { content: [{ type: "text", text: "(no results)" }], isError: false });
});

test("malformed retrieval and tool errors fail instead of pretending there are no matches", async () => {
  for (const result of [
    { content: [{ type: "text", text: "unexpected backend response" }] },
    { content: [{ type: "text", text: "### 1. fake\nno Discord permalink" }] },
    { content: [{ type: "text", text: discordText }], isError: true },
  ]) {
    await withMcp(async url => {
      await assert.rejects(retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5_000)));
    }, result);
  }
});

test("destructive tools are never invoked", async () => {
  await withMcp(async (url, calls) => {
    await assert.rejects(retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(5_000)), /tool unavailable/);
    assert.ok(!calls.includes("tools/call"));
  }, {}, true);
});

test("HTTP is rejected for non-loopback endpoints before making any request", async () => {
  for (const url of ["http://example.com/mcp", "http://192.0.2.10/mcp", "http://127.0.0.1.example.com/mcp", "https://user:secret@example.com/mcp"]) {
    await assert.rejects(retrieveDocuments({ url, tool: "search_discord" }, "ink detection", AbortSignal.timeout(100)), /Invalid retrieval endpoint/);
  }
});

test("generic document contract keeps limits and strips unsafe source URLs", () => {
  const docs = parseDocuments({ documents: Array.from({ length: 8 }, (_, i) => ({ title: `Doc ${i}`, text: "x".repeat(5_000), url: i ? "https://example.com/doc" : "javascript:alert(1)" })) });
  assert.equal(docs.length, 4);
  assert.equal(docs.reduce((sum, doc) => sum + doc.text.length, 0), 16_000);
  assert.equal(docs[0].url, undefined);
  assert.equal(docs[1].url, "https://example.com/doc");
});

test("generic MCP retrieval remains supported and reports upstream response statuses", async () => {
  const observer = vi.fn();
  await withMcp(async url => {
    expectGeneric(await retrieveDocuments({ url, tool: "search" }, "ink detection", AbortSignal.timeout(5_000), observer));
    assert.ok(observer.mock.calls.some(call => call[0] === 200));
  }, { content: [{ type: "text", text: "found" }], structuredContent: { documents: [{ title: "Generic source", text: "evidence", url: "https://example.com/doc" }] } }, false, "search");
  function expectGeneric(docs: Awaited<ReturnType<typeof retrieveDocuments>>) {
    assert.deepEqual(docs, [{ id: "1", title: "Generic source", text: "evidence", url: "https://example.com/doc" }]);
  }
});

test("document validation rejects malformed envelopes and skips unusable entries without unsafe URLs", () => {
  for (const value of [null, [], {}, { documents: "bad" }]) assert.throws(() => parseDocuments(value));
  const docs = parseDocuments({ documents: [null, {}, { title: "empty", text: " " }, { title: " ", text: "text" }, ...Array.from({ length: 7 }, (_, i) => ({ title: "t".repeat(200), text: `evidence ${i}`, url: i === 0 ? "not a url" : i === 1 ? "https://user:password@example.com" : undefined }))] });
  assert.equal(docs.length, 5);
  assert.equal(docs[0].title.length, 180);
  assert.ok(docs.every(doc => doc.url === undefined));
});

test("nonempty generic results with no usable documents are not a genuine zero-hit search", async () => {
  assert.deepEqual(parseDocuments({ documents: [] }), []);
  for (const documents of [[{ title: "Broken", text: 123 }], [null, {}], [{ title: "Empty", text: " " }]])
    assert.throws(() => parseDocuments({ documents }), /Invalid retrieval result/);
  await withMcp(async url => {
    await assert.rejects(retrieveDocuments({ url, tool: "search" }, "ink detection", AbortSignal.timeout(5000)), /Invalid retrieval result/);
  }, { content: [{ type: "text", text: "bad schema" }], structuredContent: { documents: [{ title: "Broken", text: 123 }] } }, false, "search");
});

test("chat passes retrieved evidence to the model and returns the actual source citations", async () => {
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "https://openrouter.ai/api/v1/chat/completions") return originalFetch(input, init);
    assert.equal(init?.redirect, "manual", "Workers rejects redirect:error");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, "test/model");
    assert.match(payload.messages[0].content, /Vesuvius Challenge/);
    assert.match(payload.messages[0].content, /PHerc 1447 remains eligible/);
    assert.doesNotMatch(payload.messages[0].content, /Sos el asistente de LegacyBrand Security/);
    assert.doesNotMatch(String(init?.body), /test-secret/);
    return Response.json({ choices: [{ message: { content: "PHerc 1447 sigue siendo elegible para el Grand Prize, según el anuncio del 24 de septiembre de 2026. [1]" } }] });
  });
  await withMcp(async url => {
    const response = await answerChat([{ role: "user", content: "ink detection" }], readServerConfig({ OPENROUTER_API_KEY: "test-secret", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: url, MCP_RAG_TOOL: "search_discord" }), AbortSignal.timeout(5_000));
    assert.equal(response.mode, "live");
    assert.equal(response.rag, true);
    assert.match(response.message, /\[1\]/);
    assert.equal(response.sources[0].url, "https://discord.com/channels/1/2/101");
    assert.equal("text" in response.sources[0], false);
  });
});

test("RAG failure returns a safe 503 without contacting the model", async () => {
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://openrouter.ai/api/v1/chat/completions") { modelCalls++; throw new Error("model must not be called"); }
    return originalFetch(input, init);
  });
  await withMcp(async url => {
    await assert.rejects(answerChat([{ role: "user", content: "ink detection" }], readServerConfig({ OPENROUTER_API_KEY: "test", OPENROUTER_MODEL: "test/model", MCP_RAG_URL: url, MCP_RAG_TOOL: "search_discord" }), AbortSignal.timeout(5_000)), (error: unknown) => error instanceof ChatError && error.status === 503 && !error.message.includes("backend-secret"));
  }, { content: [{ type: "text", text: "backend-secret" }], isError: true });
  assert.equal(modelCalls, 0);
});
