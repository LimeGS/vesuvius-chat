"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp, ArrowUpRight, ChevronDown, Plus, Square, X } from "lucide-react";
import type { ChatResponse, ChatSource, ChatStatus, ChatResearch } from "@/lib/chat-types";
import { contextLimits, conversationContext } from "@/lib/chat-context";
import PrivacyFooter from "./privacy-footer";

type Message = { id: string; role: "user" | "assistant"; content: string; sources?: ChatSource[]; demo?: boolean; truncated?: boolean; research?: ChatResearch };
function safeUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function inline(text: string, sources: ChatSource[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\*\*[^*]+\*\*|(`+)[^\n]*?\1|\[\d+\]/g)) {
    const piece = match[0];
    parts.push(text.slice(cursor, match.index));
    if (match[1]) parts.push(<code key={match.index}>{piece.slice(match[1].length, -match[1].length)}</code>);
    else if (piece.startsWith("**")) parts.push(<strong key={match.index}>{inline(piece.slice(2, -2), sources)}</strong>);
    else {
      const number = Number(piece.slice(1, -1)); const source = sources[number - 1]; const href = safeUrl(source?.url);
      parts.push(href ? <a key={match.index} className="citation" href={href} target="_blank" rel="noreferrer noopener" title={source.date ? `Posted ${source.date}` : "Date unavailable"} aria-label={`Source ${number}: ${source.title}${source.date ? ` (posted ${source.date})` : ""}`}>{number}</a> : piece);
    }
    cursor = match.index + piece.length;
  }
  parts.push(text.slice(cursor));
  return parts;
}
function Answer({ text, sources }: { text: string; sources: ChatSource[] }) {
  return <div className="answer-text">{text.split(/(```[\s\S]*?(?:```|$))/g).map((section, si) => {
    if (section.startsWith("```")) return <pre key={si}><code>{section.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</code></pre>;
    const lines = section.trim().split("\n"), blocks: ReactNode[] = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i], key = `${si}-${i}`;
      if (!line.trim()) { i++; continue; }
      if (/^#{1,6}\s/.test(line)) {
        blocks.push(<h3 key={key}>{inline(line.replace(/^#{1,6}\s+/, ""), sources)}</h3>); i++; continue;
      }
      if (/^>\s?/.test(line)) {
        const quote: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
        blocks.push(<blockquote key={key}>{inline(quote.join(" "), sources)}</blockquote>); continue;
      }
      const ordered = /^\d+\.\s/.test(line);
      if (ordered || /^[-*]\s/.test(line)) {
        const pattern = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
        const items: ReactNode[] = [];
        while (i < lines.length && pattern.test(lines[i])) items.push(<li key={i}>{inline(lines[i++].replace(pattern, ""), sources)}</li>);
        blocks.push(ordered ? <ol key={key} start={Number.parseInt(line, 10)}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
      }
      const paragraph: string[] = [lines[i++]];
      while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|>\s?|[-*]\s|\d+\.\s)/.test(lines[i])) paragraph.push(lines[i++]);
      blocks.push(<p key={key}>{paragraph.map((text, j) => <span key={j}>{j > 0 && <br />}{inline(text, sources)}</span>)}</p>);
    }
    return blocks;
  })}</div>;
}

export default function Chat({ onExpired, onLogout, accessError }: { onExpired?: () => void; onLogout?: () => void; accessError?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [error, setError] = useState("");
  const [contextTrimmed, setContextTrimmed] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const messageId = useRef(0);
  const hasConversation = messages.length > 0;

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/status", { signal: controller.signal }).then(async response => {
      if (controller.signal.aborted) return;
      if (response.status === 401) { onExpired?.(); return; }
      if (!response.ok) throw new Error("status"); setStatus(await response.json() as ChatStatus);
    }).catch(() => { if (!controller.signal.aborted) setStatusError(true); });
    return () => { controller.abort(); requestRef.current?.abort(); };
  }, [onExpired]);
  function resizeComposer() {
    const area = composerRef.current;
    if (!area) return;
    area.style.height = "auto";
    const limit = Number.parseFloat(getComputedStyle(area).maxHeight) || 256;
    area.style.height = `${Math.min(area.scrollHeight, limit)}px`;
  }
  useEffect(() => { resizeComposer(); }, [draft]);
  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    let disposed = false;
    const scheduleResize = () => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resizeComposer);
    };
    const updateViewport = () => {
      const height = viewport && viewport.scale === 1 ? viewport.height : window.innerHeight;
      shellRef.current?.style.setProperty("--app-height", `${height}px`);
      scheduleResize();
    };
    window.addEventListener("resize", updateViewport);
    viewport?.addEventListener("resize", updateViewport);
    void document.fonts.ready.then(scheduleResize);
    updateViewport();
    return () => { disposed = true; cancelAnimationFrame(frame); window.removeEventListener("resize", updateViewport); viewport?.removeEventListener("resize", updateViewport); };
  }, []);
  useEffect(() => {
    if (hasConversation) bottomRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "end" });
  }, [messages, loading, hasConversation]);
  useEffect(() => {
    if (!loading && hasConversation) composerRef.current?.focus({ preventScroll: true });
  }, [loading, hasConversation]);


  async function sendMessage(text: string) {
    const content = text.trim();
    if (!content || loading) return;
    if (content.length > contextLimits.user) { setError("Your question is too long. Use up to 6,000 characters."); return; }
    const before = messages;
    const next: Message[] = [...messages, { id: String(++messageId.current), role: "user", content }];
    const context = conversationContext(next);
    const controller = new AbortController(); requestRef.current = controller; const thisRequest = ++requestId.current;
    setMessages(next); setDraft(""); setError(""); setLoading(true);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: context }), signal: controller.signal });
      if (thisRequest !== requestId.current) return;
      if (response.status === 401) { onExpired?.(); return; }
      const data = await response.json().catch(() => { throw new Error("Could not get a response. Please try again."); }) as ChatResponse & { error?: string };
      if (!response.ok) {
        const id = response.headers.get("X-Request-ID");
        const reference = id && /^[a-f0-9-]{36}$/i.test(id) ? ` Reference: ${id}` : "";
        throw new Error((data.error || "Could not get a response. Please try again.") + reference);
      }
      if (thisRequest !== requestId.current) return;
      if (typeof data.message !== "string" || !data.message.trim()) throw new Error("The response was empty. Please try again.");
      setStatus({ mode: data.mode, rag: data.rag }); setStatusError(false);
      setContextTrimmed(context.length < next.length);
      setMessages([...next, { id: String(++messageId.current), role: "assistant", content: data.message, sources: data.sources || [], demo: data.mode === "demo", truncated: data.truncated === true, research: data.research }]);
    } catch (err) {
      if (thisRequest !== requestId.current) return;
      setMessages(before); setDraft(content);
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not connect. Please try again.");
    } finally { if (thisRequest === requestId.current) { setLoading(false); requestRef.current = null; composerRef.current?.focus({ preventScroll: true }); } }
  }
  function newConversation() {
    ++requestId.current; requestRef.current?.abort(); requestRef.current = null; setMessages([]); setDraft(""); setError(""); setContextTrimmed(false); setLoading(false); composerRef.current?.focus({ preventScroll: true });
  }
  function submit(event: FormEvent) { event.preventDefault(); void sendMessage(draft); }

  return <div ref={shellRef} className={`app-shell ${hasConversation ? "is-conversation" : "is-welcome"}`}>
    <header className="site-header">
      <div className="header-actions">
        {onLogout && <button className="logout-button" type="button" onClick={onLogout}>Sign out</button>}
        {status?.mode === "demo" && <span className="demo-tag" aria-label="Demo: sample responses" title="Sample responses. The AI model is not connected yet.">Demo</span>}
        {hasConversation && <button className="new-chat" type="button" onClick={newConversation} aria-label="New conversation" title="New conversation"><Plus size={20} strokeWidth={1.5} /></button>}
      </div>
    </header>
    <main className="main-content" aria-label="Vesuvius Challenge RAG Chat">
      <h1 className={hasConversation ? "sr-only" : "welcome-title"}>Vesuvius Challenge <span>RAG Chat</span></h1>
      {hasConversation && <section className="conversation" aria-label="Conversation" role="log" aria-live="polite" aria-relevant="additions">
        {messages.map(message => <article key={message.id} className={`message ${message.role}`}>
          {message.role === "user" ? <><span className="sr-only">You: </span><div className="user-bubble">{message.content}</div></> : <>
            <span className="sr-only">Vesuvius Challenge RAG Chat: </span>
            <Answer text={message.content} sources={message.sources || []} />
            {message.truncated && <p className="status-error" role="status">Incomplete response: the generation or length limit was reached. You can ask to continue.</p>}
            {!!message.sources?.length && <details className="sources"><summary><span>Sources <span className="source-count">{message.sources.length}</span></span><ChevronDown size={14} /></summary><div className="source-list">{message.sources.map((source, i) => { const href = safeUrl(source.url); const label = <span><span>{source.title}</span><br />{source.date ? <time dateTime={source.date}>Posted {source.date}</time> : "Date unavailable"}</span>; return href ? <a key={`${source.id}-${i}`} href={href} target="_blank" rel="noreferrer noopener"><span className="source-number">{i + 1}</span>{label}<ArrowUpRight size={14} /></a> : <div key={`${source.id}-${i}`}><span className="source-number">{i + 1}</span>{label}</div>; })}</div></details>}
          </>}
        </article>)}
        {loading && <div className="thinking" role="status"><span /><span /><span /><span className="sr-only">Preparing a response…</span></div>}
        <div ref={bottomRef} className="scroll-anchor" />
      </section>}
      <div className="composer-region">
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Scrollable notices need keyboard access. */}
        {(error || accessError) && <div className="composer-notices" role="region" aria-label="Notices" tabIndex={0}>
          {accessError && <div className="access-error" role="alert">{accessError}</div>}
          {error && <div className="error-message" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss notice" onClick={() => setError("")}><X size={16} /></button></div>}
        </div>}
        <form className="composer" onSubmit={submit} aria-label="Ask a question">
          <label className="sr-only" htmlFor="question">Your question about Vesuvius</label>
          <textarea id="question" ref={composerRef} value={draft} onChange={event => { setDraft(event.target.value); if (error) setError(""); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!loading) void sendMessage(draft); } }} placeholder={hasConversation ? "Write a message…" : "Ask your question…"} rows={1} maxLength={6000} disabled={loading} autoComplete="off" />
          {loading ? <button type="button" className="send-button" aria-label="Stop response" title="Stop response" onClick={() => requestRef.current?.abort()}><Square size={13} fill="currentColor" /></button> : <button type="submit" className="send-button" aria-label="Send question" title="Send question" disabled={!draft.trim()}><ArrowUp size={21} strokeWidth={1.9} /></button>}
        </form>
        {statusError && !error && <p className="status-error" role="status">Could not verify the connection. Please try again.</p>}
        {contextTrimmed && <p className="status-error" role="status">Using recent context. Older turns remain visible but are not included in the context sent. Repeat important details if needed.</p>}
      </div>
    </main>
    <PrivacyFooter />
  </div>;
}
