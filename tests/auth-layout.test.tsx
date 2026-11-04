import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { chatGPTSignInPath, chatGPTSignOutPath, getChatGPTUser, requireChatGPTUser } from "../app/chatgpt-auth";
import Layout, { metadata } from "../app/layout";
import { cn } from "../lib/utils";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));

test.each([
  [{}, null],
  [{ "oai-authenticated-user-id": "1" }, null],
  [{ "oai-authenticated-user-email": "a@example.com" }, null],
  [{ "oai-authenticated-user-id": "1", "oai-authenticated-user-email": "a@example.com" }, { userId: "1", email: "a@example.com", fullName: null, displayName: "a@example.com" }],
  [{ "oai-authenticated-user-id": "1", "oai-authenticated-user-email": "a@example.com", "oai-authenticated-user-full-name": "Jos%C3%A9", "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8" }, { userId: "1", email: "a@example.com", fullName: "José", displayName: "José" }],
  [{ "oai-authenticated-user-id": "1", "oai-authenticated-user-email": "a@example.com", "oai-authenticated-user-full-name": "%bad", "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8" }, { userId: "1", email: "a@example.com", fullName: null, displayName: "a@example.com" }],
  [{ "oai-authenticated-user-id": "1", "oai-authenticated-user-email": "a@example.com", "oai-authenticated-user-full-name": "Name", "oai-authenticated-user-full-name-encoding": "unknown" }, { userId: "1", email: "a@example.com", fullName: null, displayName: "a@example.com" }],
])("legacy hosting user projection handles missing/encoded headers: %#", async (values, expected) => {
  vi.mocked(headers).mockResolvedValue(new Headers(values) as never);
  expect(await getChatGPTUser()).toEqual(expected);
});

test.each(["https://evil.example", "//evil.example", "/signin-with-chatgpt", "/signout-with-chatgpt", "/callback", "/\\evil.example", "/\\["])
("legacy auth redirects reject unsafe return paths: %s", path => {
  expect(new URL(chatGPTSignInPath(path), "https://chat.example").searchParams.get("return_to")).toBe("/");
});

test("legacy auth preserves safe query/hash paths and signs out to the default root", async () => {
  expect(new URL(chatGPTSignInPath("/search?q=ink#result"), "https://chat.example").searchParams.get("return_to")).toBe("/search?q=ink#result");
  expect(chatGPTSignOutPath()).toBe("/signout-with-chatgpt?return_to=%2F");
  vi.mocked(headers).mockResolvedValue(new Headers() as never);
  await expect(requireChatGPTUser("/private")).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith("/signin-with-chatgpt?return_to=%2Fprivate");
  vi.mocked(headers).mockResolvedValue(new Headers({ "oai-authenticated-user-id": "1", "oai-authenticated-user-email": "a@example.com" }) as never);
  expect(await requireChatGPTUser("/private")).toMatchObject({ userId: "1" });
});

test("root layout renders the accessible locale and class helper resolves conflicting utilities", () => {
  const html = renderToStaticMarkup(<Layout><main>Chat</main></Layout>);
  expect(html).toContain('lang="en"');
  expect(metadata.description).toBe("Explore the Vesuvius Challenge Discord corpus with sources and citations.");
  expect(html).toContain("<main>Chat</main>");
  expect(metadata.title).toBe("Vesuvius Challenge RAG Chat");
  expect(cn("p-2", false, "p-4", { hidden: false, block: true })).toBe("p-4 block");
});
