import { env } from "node:process";
import { ChatError, chatStatus, errorResponse, noStoreHeaders, readServerConfig } from "@/lib/chat-server";
import { createRequestLog, type ErrorCode } from "@/lib/logging";
import { requireSession } from "@/lib/auth";
import { limitStore, readLimits } from "@/lib/limits";

export async function GET(request: Request) {
  const log = createRequestLog("status");
  const started = Date.now();
  let response: Response;
  let code: ErrorCode | undefined;
  try { await requireSession(request, env); limitStore(env); readLimits(env); response = Response.json(chatStatus(readServerConfig(env)), { headers: noStoreHeaders }); }
  catch (error) {
    code = error instanceof ChatError ? error.code : "internal_error";
    response = errorResponse(error, log.requestId);
  }
  response.headers.set("X-Request-ID", log.requestId);
  log.write(response.status >= 500 ? "error" : response.ok ? "info" : "warn", "request.completed", { status: response.status, code, durationMs: Date.now() - started });
  return response;
}
