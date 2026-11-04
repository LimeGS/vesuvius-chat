import { ChatError } from "./chat-server";
import { localRequest, privateHash, securityConfig } from "./auth";
import { defaultLimits, type Limits } from "./quota";
import { applyPersistentLimits } from "./quota-store";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";

export function readLimits(bindings: unknown): Limits {
  const env = bindings as Record<string, unknown>;
  const names = { login: "LIMIT_LOGIN_PER_15_MINUTES", ip: "LIMIT_CHAT_IP_PER_MINUTE", minute: "LIMIT_CHAT_GLOBAL_PER_MINUTE", day: "LIMIT_CHAT_GLOBAL_PER_DAY", concurrent: "LIMIT_CHAT_CONCURRENT" };
  return Object.fromEntries(Object.entries(names).map(([key, name]) => {
    const value = env[name] === undefined ? defaultLimits[key as keyof Limits] : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > (key === "concurrent" ? 128 : 1_000_000)) throw new ChatError(503, "Request limits are still being configured.", "configuration_error");
    return [key, value];
  })) as Limits;
}

export function limitStore(bindings: unknown): string {
  const path = (bindings as { LIMITS_DB_PATH?: unknown }).LIMITS_DB_PATH;
  if (typeof path !== "string" || !isAbsolute(path)) throw new ChatError(503, "Access is still being configured.", "configuration_error");
  return path;
}

export async function reserveLimit(request: Request, bindings: unknown, operation: "login" | "chat" | "mcp"): Promise<() => Promise<void>> {
  const config = securityConfig(bindings);
  const path = limitStore(bindings);
  const limits = readLimits(bindings);
  const local = !config.production && localRequest(request);
  const ip = local ? "local" : request.headers.get("x-real-ip");
  const origin = (bindings as { APP_ORIGIN?: string }).APP_ORIGIN;
  if (!ip || (!local && !isIP(ip)) || (config.production && (!origin || request.headers.get("x-forwarded-proto") !== "https" || request.headers.get("host") !== new URL(origin).host)))
    throw new ChatError(503, "Could not verify access.", "configuration_error");
  const key = await privateHash(config.secret, `ip:${ip}`);
  const call = (input: Parameters<typeof applyPersistentLimits>[1]) => {
    try { return applyPersistentLimits(path, input, Date.now()); }
    catch { throw new ChatError(503, "Could not verify the request limit. Please try again later.", "limits_unavailable"); }
  };
  const result = call({ operation, key, limits });
  if (!result.allowed) {
    const error = new ChatError(429, "Request limit reached. Please try again later.", "rate_limited");
    error.retryAfter = result.retryAfter;
    throw error;
  }
  if (operation !== "login" && (typeof result.lease !== "string" || !/^[a-f0-9-]{36}$/.test(result.lease))) throw new ChatError(503, "Could not verify access.", "limits_unavailable");
  return async () => { if (result.lease) call({ operation: "release", lease: result.lease }); };
}
