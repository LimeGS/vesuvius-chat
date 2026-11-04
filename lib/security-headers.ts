export function secureRequest(request: Request): Request {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
  const headers = new Headers(request.headers);
  headers.delete("content-security-policy-report-only");
  headers.delete("x-nonce");
  headers.set("content-security-policy", `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'${process.env.NODE_ENV !== "production" ? " ws://localhost:* ws://127.0.0.1:*" : ""}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  return new Request(request, { headers });
}

export function secureResponse(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", request.headers.get("content-security-policy")!);
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (new URL(request.url).protocol === "https:" || process.env.NODE_ENV === "production") headers.set("Strict-Transport-Security", "max-age=31536000");
  if (headers.get("content-type")?.includes("text/html")) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
