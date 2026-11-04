"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import Chat from "./chat";
import PrivacyFooter from "./privacy-footer";

export default function Home() {
  const [access, setAccess] = useState<"checking" | "required" | "granted">("checking");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const expire = useCallback(() => { setAccess("required"); setCode(""); }, []);

  useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    fetch("/api/session", { signal: controller.signal }).then(async response => {
      const data = await response.json() as { authenticated?: unknown } | null;
      if (controller.signal.aborted) return;
      setAccess(response.ok && data?.authenticated === true ? "granted" : "required");
      if (!response.ok && response.status !== 401) setError("Could not verify access. Please try again.");
    }).catch(() => { if (!controller.signal.aborted) { setAccess("required"); setError("Could not connect. Please try again."); } });
    return () => { active.current?.abort(); };
  }, []);

  async function changeSession(method: "POST" | "DELETE") {
    if (busy) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/session", { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ code }) } : {}), signal: controller.signal });
      const data = await response.json() as { authenticated?: unknown; error?: unknown } | null;
      if (controller.signal.aborted) return;
      if (!response.ok) { setError(typeof data?.error === "string" ? data.error : "Could not verify access. Please try again."); return; }
      setCode(""); setAccess(method === "POST" && data?.authenticated === true ? "granted" : "required");
    } catch { if (!controller.signal.aborted) setError("Could not connect. Please try again."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (code) void changeSession("POST"); }

  if (access === "granted") return <Chat onExpired={expire} onLogout={() => { void changeSession("DELETE"); }} accessError={error} />;
  return <div className="app-shell is-welcome">
    <div className="site-header" />
    <main className="main-content">
      <h1 className="welcome-title">Vesuvius Challenge <span>RAG Chat</span></h1>
      {access === "checking" ? <p className="status-error" role="status">Checking access…</p> : <div className="invitation">
        <form onSubmit={submit} aria-label="Sign in with an invitation">
          <label htmlFor="invitation-code">Invitation code</label>
          <input id="invitation-code" type="password" value={code} onChange={event => setCode(event.target.value)} maxLength={128} autoComplete="off" autoCapitalize="none" spellCheck={false} required disabled={busy} aria-describedby="invitation-note" />
          <p id="sign-in-terms" className="sign-in-notice">By selecting <strong>Agree and sign in</strong>, you agree to the <Link href="/terms" target="_blank" rel="noreferrer noopener" aria-label="Terms of Use (opens in a new tab)" title="Opens in a new tab">Terms of Use <span aria-hidden="true">↗</span></Link> and acknowledge the <Link href="/privacy" target="_blank" rel="noreferrer noopener" aria-label="Privacy Notice (opens in a new tab)" title="Opens in a new tab">Privacy Notice <span aria-hidden="true">↗</span></Link>. Meta may retain submitted content and use it for training. Do not submit sensitive or confidential information.</p>
          <button type="submit" disabled={busy || !code} aria-describedby="sign-in-terms">{busy ? "Signing in…" : "Agree and sign in"}</button>
        </form>
        <p id="invitation-note">The code can be shared. Your session lasts 24 hours.</p>
        {error && <div className="error-message" role="alert">{error}</div>}
      </div>}
    </main>
    <PrivacyFooter />
  </div>;
}
