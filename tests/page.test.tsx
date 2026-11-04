// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Home from "../app/chat";
import { validateMessages } from "../lib/chat-server";

beforeEach(() => {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false })) });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); });

const textbox = () => screen.getByRole("textbox", { name: "Your question about Vesuvius" }) as HTMLTextAreaElement;
const success = { message: "Respuesta verificada. [1]", sources: [{ id: "1", title: "Anuncio", url: "https://discord.com/channels/1/2/3" }], mode: "live", rag: true };
function api(reply: unknown = success) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async input => input === "/api/status" ? Response.json({ mode: "demo", rag: false }) : Response.json(reply));
}
function submit(text = "¿Qué se sabe de PHerc1447?") {
  fireEvent.change(textbox(), { target: { value: text } });
  fireEvent.submit(screen.getByRole("form", { name: "Ask a question" }));
}

test("welcome is accessible, exposes demo status, and disables an empty submission", async () => {
  const fetch = api(); render(<Home />);
  expect(screen.getByRole("contentinfo").textContent).toContain("No tracking. No message logs on our servers.");
  expect(screen.getByRole("heading", { name: "Vesuvius Challenge RAG Chat" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /LegacyBrand/i })).toBeNull();
  expect((screen.getByRole("button", { name: "Send question" }) as HTMLButtonElement).disabled).toBe(true);
  expect(textbox().placeholder).toBe("Ask your question…");
  await screen.findByLabelText("Demo: sample responses");
  submit("   ");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("submitting sends only conversation roles/content and renders real citation links", async () => {
  const fetch = api(); render(<Home />); submit();
  const citation = await screen.findByRole("link", { name: "Source 1: Anuncio" });
  expect(screen.getByText("Vesuvius Challenge RAG Chat:")).toBeTruthy();
  expect(citation.getAttribute("href")).toBe("https://discord.com/channels/1/2/3");
  expect(citation.getAttribute("rel")).toMatch(/noopener/);
  expect(JSON.parse(String(fetch.mock.calls.find(call => call[0] === "/api/chat")?.[1]?.body))).toEqual({ messages: [{ role: "user", content: "¿Qué se sabe de PHerc1447?" }] });
  submit("¿Y después?");
  await waitFor(() => expect(fetch.mock.calls.filter(call => call[0] === "/api/chat")).toHaveLength(2));
  expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body)).messages).toHaveLength(3);
});

test("source dates are shown for linked and linkless sources, with unknown dates explicit", async () => {
  api({ ...success, sources: [
    { ...success.sources[0], date: "2025-11-03" },
    { id: "2", title: "Undated note", url: "https://example.com/note" },
    { id: "3", title: "Kaggle announcement", date: "2024-02-29" },
  ] });
  const { container } = render(<Home />); submit();
  const citation = await screen.findByRole("link", { name: "Source 1: Anuncio (posted 2025-11-03)" });
  expect(citation.getAttribute("title")).toBe("Posted 2025-11-03");
  const dates = [...container.querySelectorAll(".source-list time")];
  expect(dates.map(date => [date.getAttribute("datetime"), date.textContent])).toEqual([
    ["2025-11-03", "Posted 2025-11-03"], ["2024-02-29", "Posted 2024-02-29"],
  ]);
  const undated = container.querySelector('.source-list a[href="https://example.com/note"]');
  expect(undated?.textContent).toContain("Date unavailable");
  expect(undated?.querySelector("time")).toBeNull();
});

test("research metadata does not add a diagnostic panel to answers or hide their citations", async () => {
  api({ ...success, research: { notice: "Partial interval review: more pages remain; this sample cannot prove absence.", backend: "cpu", timeZone: "UTC", timezoneFallback: true, updatedAt: "2026-11-02T09:00:00Z", coverageStart: "2023-03-12T00:00:00Z", coverageEnd: "2026-11-03T00:00:00Z" } });
  render(<Home />); submit();
  await screen.findByRole("link", { name: "Source 1: Anuncio" });
  expect(screen.queryByText("Research scope and coverage")).toBeNull();
  expect(screen.queryByText(/Partial interval review|Backend: cpu|Snapshot updated|Corpus coverage/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  expect(screen.queryByText(/Partial interval review/)).toBeNull();
});

test("long research conversations retain recent whole turns, keep visible history and disclose context eviction", async () => {
  const fetch = api({ ...success, message: "Respuesta extensa " + "x".repeat(15900), sources: [] });
  const { container } = render(<Home />);
  for (const [i, question] of ["PHerc1447: evidencia inicial", "¿Qué método usaron?", "¿Qué limitaciones tiene?"].entries()) {
    submit(question);
    await waitFor(() => expect(container.querySelectorAll(".message.assistant")).toHaveLength(i + 1));
  }
  const body = JSON.parse(String(fetch.mock.calls.filter(call => call[0] === "/api/chat").at(-1)?.[1]?.body));
  expect(() => validateMessages(body)).not.toThrow();
  expect(body.messages).toHaveLength(3);
  expect(body.messages[0]).toEqual({ role: "user", content: "¿Qué método usaron?" });
  expect(body.messages.at(-1)).toEqual({ role: "user", content: "¿Qué limitaciones tiene?" });
  expect(container.querySelectorAll(".message")).toHaveLength(6);
  await screen.findByText(/Older turns remain visible/);
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  expect(screen.queryByText(/Older turns remain visible/)).toBeNull();
  submit("Otro tema");
  await waitFor(() => expect(fetch.mock.calls.filter(call => call[0] === "/api/chat")).toHaveLength(4));
  expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body)).messages).toEqual([{ role: "user", content: "Otro tema" }]);
});

test("partial answers carry a persistent per-answer warning and never trigger an automatic retry", async () => {
  const fetch = api({ ...success, message: "Conclusión parcial: la primera excepción es", truncated: true });
  render(<Home />); submit();
  await screen.findByText(/Incomplete response/);
  expect(fetch.mock.calls.filter(call => call[0] === "/api/chat")).toHaveLength(1);
  expect(screen.getByText(/Conclusión parcial/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  expect(screen.queryByText(/Incomplete response/)).toBeNull();
});

test("double-backtick examples keep citation-like numbers inside code, not evidence links", async () => {
  api({ ...success, message: "Example: ``a` [99] [1]``\n\nOutside [1]." });
  const { container } = render(<Home />); submit();
  await screen.findByText("Outside", { exact: false });
  expect(container.querySelector("code")?.textContent).toBe("a` [99] [1]");
  expect(screen.getAllByRole("link", { name: "Source 1: Anuncio" })).toHaveLength(1);
  expect(container.querySelector("code a")).toBeNull();
});

test("an unfinished fenced block in a partial answer cannot turn array indices into citations", async () => {
  api({ ...success, message: "Intro\n\n```python\narray[1]", truncated: true });
  const { container } = render(<Home />); submit();
  await screen.findByText(/Incomplete response/);
  expect(container.querySelector("pre code")?.textContent).toContain("array[1]");
  expect(screen.queryByRole("link", { name: "Source 1: Anuncio" })).toBeNull();
});

test("answers render supported Markdown as safe React text, not raw HTML", async () => {
  api({ ...success, message: "### Hallazgo\n\n**Importante** y `código` [1] [9]\nsegunda línea\n\n- Uno\n- Dos\n\n1. Primero\n2. Segundo\n\n```python\nprint('hola')\n```\n\n<script>alert('x')</script>" });
  const { container } = render(<Home />); submit();
  await screen.findByRole("heading", { name: "Hallazgo" });
  expect(container.querySelector("strong")?.textContent).toBe("Importante");
  expect(container.querySelector("pre code")?.textContent).toContain("print('hola')");
  expect(container.querySelector("ul")?.children).toHaveLength(2);
  expect(container.querySelector("ol")?.children).toHaveLength(2);
  expect(container.querySelector("br")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText(/<script>/)).toBeTruthy();
});

test("unsafe, malformed and absent source URLs never become links", async () => {
  api({ ...success, message: "Fuentes [1] [2] [3] [4]", sources: [{ id: "1", title: "Unsafe", url: "javascript:alert(1)" }, { id: "2", title: "Missing" }, { id: "3", title: "Malformed", url: "not a url" }, { id: "4", title: "HTTPS", url: "https://example.com/doc" }] });
  render(<Home />); submit();
  await screen.findByText("Unsafe");
  expect(screen.queryByRole("link", { name: /Source [123]:/ })).toBeNull();
  expect(screen.getByRole("link", { name: "Source 4: HTTPS" }).getAttribute("href")).toBe("https://example.com/doc");
});

test.each([
  [new Response(JSON.stringify({ error: "Base temporalmente no disponible." }), { status: 503 }), "Base temporalmente no disponible."],
  [new Response("{}", { status: 500 }), "Could not get a response. Please try again."],
  [Response.json({ ...success, message: " " }), "The response was empty. Please try again."],
])("API errors preserve the draft and allow dismissing and retrying: %#", async (reply, message) => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => input === "/api/status" ? Response.json({ mode: "live", rag: true }) : reply);
  render(<Home />); submit("Pregunta original");
  expect((await screen.findByRole("alert")).textContent).toContain(message);
  expect(textbox().value).toBe("Pregunta original");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("malformed JSON responses produce a safe UI error without backend payload fragments", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => input === "/api/status" ? Response.json({ mode: "live", rag: true }) : new Response("SECRET_PROXY_BODY"));
  render(<Home />); submit();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toMatch(/SECRET_PROXY_BODY/);
  expect(textbox().value).toBe("¿Qué se sabe de PHerc1447?");
});

test("safe server-generated request references are visible for support", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => input === "/api/status" ? Response.json({ mode: "live", rag: true }) : Response.json({ error: "Servicio temporalmente no disponible." }, { status: 503, headers: { "X-Request-ID": "123e4567-e89b-42d3-a456-426614174000" } }));
  render(<Home />); submit();
  expect((await screen.findByRole("alert")).textContent).toContain("123e4567-e89b-42d3-a456-426614174000");
});

test("connection status failures are visible and clear after a successful chat", async () => {
  const fetch = api(); fetch.mockImplementation(async input => { if (input === "/api/status") throw new Error("offline"); return Response.json(success); });
  render(<Home />);
  await screen.findByText(/Could not verify the connection/);
  submit(); await screen.findByRole("link", { name: "Source 1: Anuncio" });
  expect(screen.queryByText(/Could not verify the connection/)).toBeNull();
});

test("non-OK status and non-Error transport failures stay recoverable", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => { if (input === "/api/status") return new Response("{}", { status: 503 }); throw "offline"; });
  render(<Home />); await screen.findByText(/Could not verify/); submit();
  expect((await screen.findByRole("alert")).textContent).toContain("Could not connect. Please try again.");
  fireEvent.change(textbox(), { target: { value: "otra" } });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("large questions are rejected locally without contacting the chat API", async () => {
  const fetch = api(); render(<Home />); submit("x".repeat(6_001));
  expect((await screen.findByRole("alert")).textContent).toContain("6,000");
  expect(fetch.mock.calls.filter(call => call[0] === "/api/chat")).toHaveLength(0);
});

test("Enter sends once, Shift+Enter/composition do not send, and Stop cancels without an error alert", async () => {
  const fetch = api();
  fetch.mockImplementation((input, init) => input === "/api/status" ? Promise.resolve(Response.json({ mode: "live", rag: true })) : new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); }));
  render(<Home />); fireEvent.change(textbox(), { target: { value: "Pregunta" } });
  fireEvent.keyDown(textbox(), { key: "Enter", shiftKey: true });
  fireEvent.keyDown(textbox(), { key: "Enter", isComposing: true });
  expect(fetch.mock.calls.filter(call => call[0] === "/api/chat")).toHaveLength(0);
  fireEvent.keyDown(textbox(), { key: "Enter" });
  await screen.findByRole("button", { name: "Stop response" });
  fireEvent.keyDown(textbox(), { key: "Enter" });
  expect(fetch.mock.calls.filter(call => call[0] === "/api/chat")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
  await waitFor(() => expect(textbox().disabled).toBe(false));
  expect(textbox().value).toBe("Pregunta");
  expect(screen.queryByRole("alert")).toBeNull();
});

test.each([false, true])("new conversation ignores stale %s responses from a cancelled request", async reject => {
  let finish!: (response: Response) => void;
  let fail!: (error: Error) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(input => input === "/api/status" ? Promise.resolve(Response.json({ mode: "live", rag: true })) : new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  render(<Home />); submit();
  fireEvent.click(await screen.findByRole("button", { name: "New conversation" }));
  await act(async () => { if (reject) fail(new Error("old error")); else finish(Response.json(success)); });
  expect(screen.queryByText(/Respuesta verificada/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(textbox().value).toBe("");
});

test("viewport resizing, reduced motion and composer height follow platform settings", async () => {
  const viewport = new EventTarget() as EventTarget & { height: number; scale: number };
  Object.assign(viewport, { height: 500, scale: 1 });
  Object.defineProperty(window, "visualViewport", { value: viewport });
  vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  api({ ...success, sources: [] }); const { container, unmount } = render(<Home />);
  expect((container.firstChild as HTMLElement).style.getPropertyValue("--app-height")).toBe("500px");
  textbox().style.maxHeight = "100px";
  Object.defineProperty(textbox(), "scrollHeight", { value: 200 });
  fireEvent.change(textbox(), { target: { value: "Question" } });
  expect(textbox().style.height).toBe("100px");
  viewport.scale = 2;
  act(() => { viewport.dispatchEvent(new Event("resize")); });
  expect((container.firstChild as HTMLElement).style.getPropertyValue("--app-height")).toBe(`${window.innerHeight}px`);
  fireEvent.submit(screen.getByRole("form", { name: "Ask a question" }));
  await screen.findByText(/Respuesta verificada/);
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "end" });
  unmount(); fireEvent(window, new Event("resize"));
});

test("unmount aborts both active status/chat work and ignores late font callbacks", async () => {
  const signals: AbortSignal[] = [];
  let fontsReady!: () => void;
  Object.defineProperty(document, "fonts", { value: { ready: new Promise<void>(resolve => { fontsReady = resolve; }) } });
  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => { signals.push(init!.signal!); return new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); }); });
  const { unmount } = render(<Home />); submit(); unmount();
  await act(async () => { fontsReady(); });
  expect(signals.every(signal => signal.aborted)).toBe(true);
});
