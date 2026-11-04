export const defaultLimits = { login: 5, ip: 5, minute: 10, day: 40, concurrent: 2 };
export type Limits = typeof defaultLimits;
export type LimitInput = { operation: "login" | "chat" | "mcp"; key: string; limits: Limits } | { operation: "release"; lease: string };
export type LimitResult = { allowed: boolean; retryAfter?: number; lease?: string };
export type LimitState = { counters: Record<string, { count: number; expires: number }>; leases: Record<string, number>; mcp?: LimitState };

// Called inside a storage transaction; no awaits between checking and reserving.
export function applyLimits(state: LimitState, input: LimitInput, now: number): LimitResult {
  if (input.operation === "mcp") {
    state.mcp ||= { counters: {}, leases: {} };
    return applyLimits(state.mcp, { ...input, operation: "chat", limits: { login: 5, ip: 30, minute: 60, day: 1000, concurrent: 2 } }, now);
  }
  for (const [key, counter] of Object.entries(state.counters)) if (counter.expires <= now) delete state.counters[key];
  for (const [lease, expiry] of Object.entries(state.leases)) if (expiry <= now) delete state.leases[lease];
  if (input.operation === "release") { delete state.leases[input.lease]; if (state.mcp) delete state.mcp.leases[input.lease]; return { allowed: true }; }
  const prefix = input.operation === "login" ? "login:" : "chat:";
  const windows: [string, number, number][] = input.operation === "login"
    ? [[`${prefix}${input.key}`, input.limits.login, now + 900_000]]
    : [[`${prefix}${input.key}`, input.limits.ip, now + 60_000], ["minute", input.limits.minute, (Math.floor(now / 60_000) + 1) * 60_000], ["day", input.limits.day, (Math.floor(now / 86_400_000) + 1) * 86_400_000]];
  let retry = 0;
  for (const [key, limit] of windows) if (state.counters[key]?.count >= limit) retry = Math.max(retry, state.counters[key].expires - now);
  if (input.operation === "chat" && Object.keys(state.leases).length >= input.limits.concurrent)
    retry = Math.max(retry, Math.min(...Object.values(state.leases)) - now);
  // Anonymous identities cannot consume chat capacity or evict admitted identities.
  const identities = Object.entries(state.counters).filter(([key]) => key.startsWith(prefix));
  if (!state.counters[`${prefix}${input.key}`] && identities.length >= 512)
    retry = Math.max(retry, Math.min(...identities.map(([, counter]) => counter.expires)) - now);
  if (retry) return { allowed: false, retryAfter: Math.max(1, Math.ceil(retry / 1000)) };
  for (const [key, , expires] of windows) {
    const counter = state.counters[key] ||= { count: 0, expires };
    counter.count++;
  }
  if (input.operation === "login") return { allowed: true };
  const lease = crypto.randomUUID();
  state.leases[lease] = now + 185_000;
  return { allowed: true, lease };
}
