// Server-only. This allowlist intentionally cannot carry prompts, headers or errors.
const codes = ["unauthorized", "rate_limited", "limits_unavailable", "invalid_request", "configuration_error", "rag_unavailable", "rag_timeout", "rag_primary_unavailable", "rag_capability_unavailable", "model_auth_failed", "model_rate_limited", "model_unavailable", "model_timeout", "model_invalid_json", "model_invalid_response", "model_invalid_citations", "model_empty_response", "model_response_too_large", "request_cancelled", "request_timeout", "internal_error"] as const;
export type ErrorCode = typeof codes[number];
type LogFields = {
  dependency?: "rag" | "model"; code?: ErrorCode; status?: number;
  upstreamStatus?: number; durationMs?: number; sourceCount?: number;
  promptTokens?: number; cachedTokens?: number;
  mode?: "demo" | "live"; rag?: boolean;
};
export type RequestLog = ReturnType<typeof createRequestLog>;

export function createRequestLog(route: "chat" | "status" | "session") {
  const requestId = crypto.randomUUID();
  return {
    requestId,
    write(level: "info" | "warn" | "error", event: "request.completed" | "dependency.completed" | "dependency.failed", fields: LogFields = {}) {
      try {
        const record: Record<string, unknown> = { timestamp: new Date().toISOString(), level, event, requestId, route };
        for (const key of ["status", "upstreamStatus", "durationMs", "sourceCount", "promptTokens", "cachedTokens"] as const) {
          const value = fields[key];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) record[key] = value;
        }
        if (fields.dependency === "rag" || fields.dependency === "model") record.dependency = fields.dependency;
        if (codes.includes(fields.code!)) record.code = fields.code;
        if (fields.mode === "demo" || fields.mode === "live") record.mode = fields.mode;
        if (typeof fields.rag === "boolean") record.rag = fields.rag;
        console[level](process.env.NODE_ENV === "production" ? JSON.stringify(record) : record);
      } catch { /* Logging must not take down a request. */ }
    },
  };
}
