import { expect, test } from "vitest";
import { createSession, requireSession, sessionCookie, securityConfig, checkOrigin } from "../lib/auth";

export const securityEnv = () => ({ INVITATION_CODES: JSON.stringify(["a".repeat(32), "b".repeat(32)]), SESSION_SECRET: "s".repeat(48) });
const request = (cookie = "", url = "https://chat.example/") => new Request(url, { headers: { Cookie: cookie } });

test("shareable invitations create independent signed sessions; never store the code", async () => {
  const config = securityConfig(securityEnv());
  const first = await createSession("a".repeat(32), config);
  const second = await createSession("a".repeat(32), config);
  expect(first).not.toBe(second);
  expect(first).not.toContain("a".repeat(32));
  const cookie = sessionCookie(request(), first);
  expect(cookie).toMatch(/^__Host-vesuvius_session=/);
  expect(cookie).toContain("HttpOnly; SameSite=Lax; Path=/; Max-Age=86400; Secure");
  await expect(requireSession(request(cookie), securityEnv())).resolves.toBeUndefined();
});

test("bad codes and missing, tampered, duplicate, expired or revoked sessions are denied", async () => {
  const config = securityConfig(securityEnv());
  await expect(createSession("wrong", config)).rejects.toMatchObject({ status: 401, message: "Enter a valid invitation code." });
  const token = await createSession("b".repeat(32), config);
  for (const cookie of ["", `__Host-vesuvius_session=${token}x`, `__Host-vesuvius_session=x; __Host-vesuvius_session=${token}`, "__Host-vesuvius_session=%%%"])
    await expect(requireSession(request(cookie), securityEnv())).rejects.toMatchObject({ status: 401 });
  const old = await createSession("a".repeat(32), config, Date.now() - 86_401_000);
  await expect(requireSession(request(sessionCookie(request(), old)), securityEnv())).rejects.toMatchObject({ status: 401 });
  await expect(requireSession(request(sessionCookie(request(), token)), { ...securityEnv(), INVITATION_CODES: JSON.stringify(["a".repeat(32)]) })).rejects.toMatchObject({ status: 401 });
  await expect(requireSession(request(sessionCookie(request(), token)), { ...securityEnv(), SESSION_SECRET: "new".repeat(16) })).rejects.toMatchObject({ status: 401 });
  const future = await createSession("a".repeat(32), config, Date.now() + 120_000);
  await expect(requireSession(request(sessionCookie(request(), future)), securityEnv())).rejects.toMatchObject({ status: 401 });
});

test("secrets fail closed and insecure HTTP is restricted to local development", () => {
  for (const env of [{}, { ...securityEnv(), SESSION_SECRET: "short" }, { ...securityEnv(), INVITATION_CODES: "not json" }, { ...securityEnv(), INVITATION_CODES: "[]" }])
    expect(() => securityConfig(env)).toThrow();
  expect(sessionCookie(request("", "http://127.0.0.1/"), "token")).toContain("vesuvius_session=token;");
  expect(() => sessionCookie(request("", "http://chat.example/"), "token")).toThrow();
  expect(() => sessionCookie(request("", "http://localhost/"), "token", true)).toThrow();
  expect(() => checkOrigin(new Request("https://chat.example/", { headers: { Origin: "https://evil.example" } }))).toThrow();
});
