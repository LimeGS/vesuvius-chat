import { env } from "node:process";
import { answerChat, ChatError, chatStatus, errorResponse, noStoreHeaders, readChatRequest, readServerConfig } from "@/lib/chat-server";
import { createRequestLog, type ErrorCode } from "@/lib/logging";
import { requireSession } from "@/lib/auth";
import { reserveLimit } from "@/lib/limits";

export async function POST(request: Request) {
  const log = createRequestLog("chat");
  const started = Date.now();
  const timeout = AbortSignal.timeout(180_000);
  const signal = AbortSignal.any([request.signal, timeout]);
  let response: Response;
  let code: ErrorCode | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    await requireSession(request, env);
    const messages = await readChatRequest(request, signal);
    if (signal.aborted) throw signal.reason;
    const config = readServerConfig(env);
    chatStatus(config);
    release = await reserveLimit(request, env, "chat");
    signal.throwIfAborted();
    response = Response.json(await answerChat(messages, config, signal, log), { headers: noStoreHeaders });
  } catch (error) {
    const failure = request.signal.aborted ? new ChatError(499, "Request cancelled.", "request_cancelled")
      : timeout.aborted ? new ChatError(504, "The response is taking longer than expected. Please try again.", "request_timeout") : error;
    code = failure instanceof ChatError ? failure.code : "internal_error";
    response = errorResponse(failure, log.requestId);
  } finally {
    try { await release?.(); }
    catch { log.write("error", "dependency.failed", { code: "limits_unavailable" }); }
  }
  response.headers.set("X-Request-ID", log.requestId);
  log.write(response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info", "request.completed", { status: response.status, code, durationMs: Date.now() - started });
  return response;
}
