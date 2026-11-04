import assert from "node:assert/strict";
import { test } from "vitest";
import { driverMessageSchema, invocationSchema } from "../scripts/connector-preview/protocol.mjs";

test("preview protocol preserves arbitrary argument and result objects across Zod upgrades", () => {
  const invocation = { connectorId: "corpus", actionName: "search", arguments: { query: "ink", limit: 5, options: { readOnly: true } } };
  assert.deepEqual(invocationSchema.parse(invocation), invocation);
  const result = { jsonrpc: "2.0", id: "123e4567-e89b-42d3-a456-426614174000", result: { content: [{ type: "text", text: "found" }], isError: false } };
  assert.deepEqual(driverMessageSchema.parse(result), result);
  assert.equal(invocationSchema.safeParse({ ...invocation, accountId: "attacker" }).success, false);
  assert.equal(invocationSchema.safeParse({ ...invocation, arguments: null }).success, false);
});
