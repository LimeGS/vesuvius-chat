import { env } from "node:process";
import { checkOrigin, createSession, requireSession, securityConfig, sessionCookie } from "@/lib/auth";
import { ChatError, errorResponse, noStoreHeaders, readJsonRequest } from "@/lib/chat-server";
import { limitStore, readLimits, reserveLimit } from "@/lib/limits";
import { createRequestLog, type ErrorCode } from "@/lib/logging";

async function handle(request: Request, action: "login" | "check" | "logout"): Promise<Response> {
  const log = createRequestLog("session");
  const started = Date.now();
  let response: Response;
  let code: ErrorCode | undefined;
  try {
    const config = securityConfig(env);
    sessionCookie(request, "", config.production);
    limitStore(env); readLimits(env);
    if (action !== "check") checkOrigin(request);
    if (action === "check") {
      await requireSession(request, env);
      response = Response.json({ authenticated: true }, { headers: noStoreHeaders });
    } else if (action === "logout") {
      response = Response.json({ authenticated: false }, { headers: { ...noStoreHeaders, "Set-Cookie": sessionCookie(request, "", config.production) } });
    } else {
      await reserveLimit(request, env, "login");
      const input = await readJsonRequest(request, AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]), 2048) as { code?: unknown } | null;
      if (!input || typeof input.code !== "string" || input.code.length > 128) throw new ChatError(400, "Invalid invitation code.");
      const token = await createSession(input.code, config);
      response = Response.json({ authenticated: true }, { headers: { ...noStoreHeaders, "Set-Cookie": sessionCookie(request, token, config.production) } });
    }
  } catch (error) {
    code = error instanceof ChatError ? error.code : "internal_error";
    response = errorResponse(error, log.requestId);
  }
  response.headers.set("X-Request-ID", log.requestId);
  log.write(response.status >= 500 ? "error" : response.ok ? "info" : "warn", "request.completed", { status: response.status, code, durationMs: Date.now() - started });
  return response;
}
export function POST(request: Request) { return handle(request, "login"); }
export function GET(request: Request) { return handle(request, "check"); }
export function DELETE(request: Request) { return handle(request, "logout"); }
