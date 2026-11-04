import assert from "node:assert/strict";
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://openrouter.ai") {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "offline/fixed-model");
    if (process.env.MCP_RAG_RESEARCH === "1") {
      if (body.tools) assert.deepEqual(body.tools.map(tool => tool.function.name), ["search_messages", "list_messages", "get_message", "get_thread"]);
    } else assert.equal(body.tools, undefined);
    assert.deepEqual(body.provider, { data_collection: "deny", zdr: true });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: `${process.env.TEST_CONTENT_MARKER} [1]` } }] });
  }
  assert.equal(url.hostname, "127.0.0.1", "Offline integration must not contact external services");
  return original(input, init);
};
