// Server-only. Codes and signatures never enter the client bundle or logs.
import { ChatError } from "./chat-server";

type SecurityConfig = { codes: string[]; secret: string; production: boolean };
export function securityConfig(bindings: unknown): SecurityConfig {
  const env = (bindings || {}) as Record<string, unknown>;
  let codes: unknown;
  try { codes = JSON.parse(String(env.INVITATION_CODES)); } catch { /* rejected below */ }
  if (!Array.isArray(codes) || !codes.length || codes.length > 20 || codes.some(code => typeof code !== "string" || !/^[A-Za-z0-9_-]{24,128}$/.test(code)) || typeof env.SESSION_SECRET !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(env.SESSION_SECRET))
    throw new ChatError(503, "Access is still being configured.", "configuration_error");
  const production = env.NODE_ENV === "production" || env.CHAT_ENV === "production";
  if (production) {
    try {
      const origin = new URL(String(env.APP_ORIGIN));
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.origin !== env.APP_ORIGIN) throw new Error("Invalid origin");
    } catch { throw new ChatError(503, "Access is still being configured.", "configuration_error"); }
  }
  return { codes, secret: env.SESSION_SECRET, production };
}

function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decode(text: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0)); }
const utf8 = new TextEncoder();
async function key(secret: string) { return crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
export async function privateHash(secret: string, text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), utf8.encode(text)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
const unauthorized = () => new ChatError(401, "Enter a valid invitation code.", "unauthorized");

async function acceptedInvitation(code: string, config: SecurityConfig): Promise<string> {
  const invite = await privateHash(config.secret, `invite:${code}`);
  const accepted = await Promise.all(config.codes.map(candidate => privateHash(config.secret, `invite:${candidate}`)));
  if (!accepted.includes(invite)) throw unauthorized();
  return invite;
}

export async function requireMcpToken(request: Request, bindings: unknown): Promise<void> {
  const config = securityConfig(bindings);
  if (new URL(request.url).search) throw unauthorized();
  checkOrigin(request);
  const match = /^Bearer ([A-Za-z0-9_-]{24,128})$/i.exec(request.headers.get("authorization") || "");
  if (!match) throw unauthorized();
  await acceptedInvitation(match[1], config);
}

export async function createSession(code: string, config: SecurityConfig, now = Date.now()): Promise<string> {
  const invite = await acceptedInvitation(code, config);
  const payload = encode(utf8.encode(JSON.stringify([invite, Math.floor(now / 1000) + 86_400, crypto.randomUUID()])));
  return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", await key(config.secret), utf8.encode(payload))))}`;
}

export function localRequest(request: Request): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname);
}
export function sessionCookie(request: Request, token: string, production = false): string {
  const secure = new URL(request.url).protocol === "https:" || (production && request.headers.get("x-forwarded-proto") === "https" && !!process.env.APP_ORIGIN && request.headers.get("host") === new URL(process.env.APP_ORIGIN).host);
  if (!secure && (production || !localRequest(request))) throw new ChatError(503, "Access requires HTTPS.", "configuration_error");
  return `${secure ? "__Host-" : ""}vesuvius_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? 86_400 : 0}${secure ? "; Secure" : ""}`;
}

export async function requireSession(request: Request, bindings: unknown): Promise<void> {
  const config = securityConfig(bindings);
  const name = sessionCookie(request, "", config.production).split("=")[0];
  const cookies = (request.headers.get("cookie") || "").split(";").map(cookie => cookie.trim()).filter(cookie => cookie.startsWith(`${name}=`));
  if (cookies.length !== 1) throw unauthorized();
  const token = cookies[0].slice(name.length + 1);
  if (token.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
  const [payload, signature] = token.split(".");
  try {
    if (!await crypto.subtle.verify("HMAC", await key(config.secret), decode(signature), utf8.encode(payload))) throw unauthorized();
    const data: unknown = JSON.parse(new TextDecoder().decode(decode(payload)));
    const now = Math.floor(Date.now() / 1000);
    if (!Array.isArray(data) || data.length !== 3 || typeof data[0] !== "string" || !Number.isInteger(data[1]) || data[1] <= now || data[1] > now + 86_400 || typeof data[2] !== "string") throw unauthorized();
    const accepted = await Promise.all(config.codes.map(code => privateHash(config.secret, `invite:${code}`)));
    if (!accepted.includes(data[0])) throw unauthorized();
  } catch { throw unauthorized(); }
}

export function checkOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = process.env.NODE_ENV === "production" ? process.env.APP_ORIGIN : new URL(request.url).origin;
  if ((origin && origin !== expected) || request.headers.get("sec-fetch-site") === "cross-site")
    throw new ChatError(403, "This request is not allowed.");
}
