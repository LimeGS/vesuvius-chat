import { expect, test, vi } from "vitest";
import { createConnectors, type ConnectorBinding } from "../lib/connector-contract.mjs";
import { connectorErrorRecovery, connectorResponse } from "../lib/connector-errors.mjs";
import { getConnectorBinding, runWithConnectorBinding } from "../lib/connector-context";
import { connectorsForRequest } from "../lib/connectors";

const binding = (context: unknown, invoke = vi.fn(async () => ({ status: "success", result: { content: [] } }))) => ({ getContext: vi.fn(async () => context), invoke }) as unknown as ConnectorBinding;

test("connector context is private to concurrent asynchronous requests", async () => {
  const a = binding({ status: "binding_unavailable" }); const b = binding({ status: "upstream_error" });
  await Promise.all([a, b].map(value => runWithConnectorBinding(value, async () => {
    await Promise.resolve();
    expect(getConnectorBinding()).toBe(value);
    expect(await connectorsForRequest().getContext()).toEqual(await value.getContext!());
  })));
  expect(getConnectorBinding()).toBeUndefined();
});

test("missing connectors are explicit and browser-side use is rejected", async () => {
  expect(await createConnectors(undefined).getContext()).toEqual({ status: "binding_unavailable" });
  expect(await createConnectors(undefined).invoke("x", "read", {})).toMatchObject({ status: "binding_unavailable" });
  vi.stubGlobal("window", {});
  try {
    await expect(createConnectors(undefined).getContext()).rejects.toThrow(/server routes/);
    await expect(createConnectors(undefined).invoke("x", "read", {})).rejects.toThrow(/server routes/);
  } finally { vi.unstubAllGlobals(); }
});

test("connector projection preserves valid tools without exposing extra context fields", async () => {
  const context = { status: "success", secret: "SECRET", connectors: [{ connectorId: "kb", policy: "enabled", tools: [{ actionName: "read", description: "Read", inputSchema: {}, secret: "SECRET" }, { actionName: "search", inputSchema: {} }] }, { connectorId: "off", policy: "disabled", tools: null }] };
  expect(await createConnectors(binding(context)).getContext()).toEqual({ status: "success", connectors: [{ connectorId: "kb", policy: "enabled", tools: [{ actionName: "read", description: "Read", inputSchema: {} }, { actionName: "search", inputSchema: {} }] }, { connectorId: "off", policy: "disabled", tools: null }] });
});

test.each(["request_context_expired", "internal_error", "binding_unavailable", "upstream_error"] as const)("connector outcome %s is preserved", async status => {
  expect(await createConnectors(binding({ status })).getContext()).toEqual({ status });
});

test.each([
  null, {}, { status: "unknown" }, { status: "success", connectors: null },
  ...[null, {}, { connectorId: 2 }, { connectorId: "kb", policy: "unknown", tools: [] }, { connectorId: "kb", policy: "enabled", tools: {} }].map(connector => ({ status: "success", connectors: [connector] })),
  ...[null, {}, { actionName: 4 }, { actionName: "read", description: 4, inputSchema: {} }, { actionName: "read", inputSchema: null }, { actionName: "read", inputSchema: 1 }, { actionName: "read", inputSchema: [] }].map(tool => ({ status: "success", connectors: [{ connectorId: "kb", policy: "enabled", tools: [tool] }] })),
])("malformed connector metadata becomes a safe unconfirmed result: %#", async context => {
  expect(await createConnectors(binding(context)).getContext()).toEqual({ status: "upstream_error" });
});

test("connector exceptions do not trigger unsafe retries or expose runtime errors", async () => {
  const invoke = vi.fn(async () => { throw new Error("SECRET"); });
  const provider = binding({}, invoke);
  vi.mocked(provider.getContext!).mockRejectedValue(new Error("SECRET"));
  expect(await createConnectors(provider).getContext()).toEqual({ status: "upstream_error" });
  const result = await createConnectors(provider).invoke("kb", "write", {});
  expect(result).toMatchObject({ status: "upstream_error" });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(invoke).toHaveBeenCalledOnce();
  expect(await createConnectors(binding({})).invoke("kb", "read", { query: "ink" })).toEqual({ status: "success", result: { content: [] } });
});

test("connector HTTP output projects valid envelopes and strips invalid diagnostic IDs", async () => {
  const success = connectorResponse({ status: "success", result: { content: [{ type: "text", text: "found" }], structuredContent: { found: true } }, requestId: "safe-id", private: "SECRET" });
  expect(success.status).toBe(200);
  expect(await success.json()).toEqual({ status: "success", result: { content: [{ type: "text", text: "found" }], structuredContent: { found: true } }, requestId: "safe-id" });
  const failure = connectorResponse({ status: "rate_limited", message: "Retry later", retryAfterMs: 20, requestId: "bad\nheader" });
  expect(await failure.json()).toEqual({ status: "rate_limited", message: "Retry later", retryAfterMs: 20 });
  expect(failure.headers.get("Cache-Control")).toBe("private, no-store");
});

test.each([null, {}, { status: "success", result: { content: [] }, isError: true }, { status: "success", result: { content: [], error: "SECRET" } }, { status: "bad", message: "fail", retryAfterMs: -1 }, { status: "success", result: { content: [{ type: "text", value: BigInt(1) }] } }])
("invalid connector envelopes become safe 502s: %#", async value => {
  const response = connectorResponse(value);
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ status: "upstream_error" });
});

test("cyclic connector values cannot escape the response validator", () => {
  const value: Record<string, unknown> = {}; value.self = value;
  expect(connectorResponse({ status: "success", result: { content: [], structuredContent: value } }).status).toBe(502);
});

test("only reauthentication failures offer a consent action, never an automatic replay", () => {
  expect(connectorErrorRecovery({ status: "reauthentication_required", message: "Sign in" }, "KB", "/signin")).toEqual({ message: "Sign in", action: { label: "Connect KB", href: "/signin" } });
  expect(connectorErrorRecovery({ status: "upstream_error", message: "Unconfirmed" }, "KB", "/signin")).toEqual({ message: "Unconfirmed" });
});
