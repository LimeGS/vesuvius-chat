import { NextRequest, NextResponse } from "next/server";
import { secureRequest, secureResponse } from "./lib/security-headers";

export function proxy(request: NextRequest): Response {
  const hardened = secureRequest(request);
  if (process.env.NODE_ENV === "production") {
    let valid = false;
    try {
      const origin = new URL(process.env.APP_ORIGIN || "");
      valid = origin.protocol === "https:" && origin.origin === process.env.APP_ORIGIN
        && request.headers.get("host") === origin.host && request.headers.get("x-forwarded-proto") === "https";
    } catch { /* Invalid runtime configuration fails closed. */ }
    if (!valid) return secureResponse(new Response("Service unavailable", { status: 503 }), hardened);
  }
  const response = NextResponse.next({ request: { headers: hardened.headers } });
  response.headers.set("Cache-Control", "no-store");
  return secureResponse(response, hardened);
}
