// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Home from "../app/page";
beforeEach(() => {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);
test("anonymous visitors enter a shareable code, then can chat and log out", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => url === "/api/session" ? init?.method === "POST" || init?.method === "DELETE" ? Response.json({ authenticated: init.method === "POST" }) : new Response("{}", { status: 401 }) : Response.json({ mode: "demo", rag: false }));
  render(<Home />);
  const input = await screen.findByLabelText("Invitation code");
  expect(screen.getByRole("contentinfo").textContent).toContain("No tracking. No message logs on our servers.");
  expect(screen.getByRole("contentinfo").querySelector('a[href="/terms"]')).toBeTruthy();
  expect(screen.getByRole("contentinfo").querySelector('a[href="/privacy"]')).toBeTruthy();
  expect(screen.getByText(/Meta may retain.*training/)).toBeTruthy();
  expect(screen.getByText(/By selecting/)).toBeTruthy();
  expect(screen.queryByText("Sign in with your invitation to explore the Vesuvius corpus.")).toBeNull();
  expect(screen.getByText("The code can be shared. Your session lasts 24 hours.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Agree and sign in" })).toBeTruthy();
  const notice = document.getElementById("sign-in-terms")!;
  const signIn = screen.getByRole("button", { name: "Agree and sign in" });
  expect(input.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(notice.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(signIn.closest("form")?.contains(notice)).toBe(true);
  expect(screen.getByRole("heading", { name: "Vesuvius Challenge RAG Chat" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /LegacyBrand/i })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Your question about Vesuvius" })).toBeNull();
  fireEvent.change(input, { target: { value: "test-invite" } });
  fireEvent.submit(screen.getByRole("form", { name: "Sign in with an invitation" }));
  await screen.findByRole("textbox", { name: "Your question about Vesuvius" });
  expect(screen.getByRole("contentinfo").textContent).toContain("No tracking. No message logs on our servers.");
  expect(fetch.mock.calls.some(([, init]) => init?.body === JSON.stringify({ code: "test-invite" }))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByLabelText("Invitation code");
});
test("invalid codes and network errors are safe and retryable", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
  render(<Home />);
  fireEvent.change(await screen.findByLabelText("Invitation code"), { target: { value: "wrong" } });
  fetch.mockResolvedValue(Response.json({ error: "Invalid invitation code." }, { status: 401 }));
  fireEvent.submit(screen.getByRole("form", { name: "Sign in with an invitation" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Invalid invitation code");
  fetch.mockRejectedValue(new Error("SECRET"));
  fireEvent.submit(screen.getByRole("form", { name: "Sign in with an invitation" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not connect"));
  expect(screen.getByRole("alert").textContent).not.toContain("SECRET");
});
test("expired chat sessions return to the invitation gate", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async url => url === "/api/chat" ? new Response("{}", { status: 401 }) : Response.json({ authenticated: true, mode: "demo", rag: false }));
  render(<Home />);
  const input = await screen.findByRole("textbox", { name: "Your question about Vesuvius" });
  fireEvent.change(input, { target: { value: "Question" } });
  fireEvent.submit(screen.getByRole("form", { name: "Ask a question" }));
  await screen.findByLabelText("Invitation code");
});
test("unmount cancels session lookup and ignores late resolutions", async () => {
  let resolve!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => { signal = init?.signal as AbortSignal; return new Promise(r => { resolve = r; }); });
  const { unmount } = render(<Home />); unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolve(Response.json({ authenticated: true })); });
});
