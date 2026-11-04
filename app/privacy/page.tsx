import type { Metadata } from "next";
import Link from "next/link";
import PrivacyFooter from "../privacy-footer";

export const metadata: Metadata = { title: "Privacy Notice | Vesuvius Challenge RAG Chat" };

export default function PrivacyPage() {
  return <div className="legal-shell">
    <header className="legal-header"><Link href="/">Vesuvius Challenge RAG Chat</Link></header>
    <main className="legal-content">
      <h1>Privacy Notice</h1>
      <p>Self-hosting notice template. The operator must review this notice against the installation&rsquo;s actual configuration and applicable requirements before offering access to others.</p>
      <p>This notice describes processing by the Vesuvius Challenge RAG Chat website and distinguishes it from processing by external AI providers. <strong>No message logs on our servers does not mean that external providers cannot retain your content.</strong></p>

      <h2>1. Questions, replies and conversation context</h2>
      <p>The website keeps the visible conversation in browser memory, not in local storage, session storage or a browser conversation database. Reloading the page or starting a new conversation clears that visible history. Recent turns are included in subsequent requests so the AI can understand follow-up questions.</p>
      <p>On our application servers, message content and retrieved evidence are processed to answer your request. We do not intentionally log question, evidence or reply contents, create a server-side conversation history, or add your chat messages to the source corpus. The corpus is an existing read-only snapshot; clearing your chat does not remove source material from it.</p>
      <p>The installation stores authorized Discord source messages and search indices in persistent volumes and refreshes them periodically. Authenticated MCP agents can retrieve source excerpts without invoking the server&rsquo;s chat model; those agents may forward evidence to their own providers under separate policies.</p>

      <h2>2. The selected AI model and provider-side caching</h2>
      <p>The operator selects the model through the installation configuration. Generating an answer sends your question, recent conversation history and retrieved corpus excerpts through OpenRouter to that model&rsquo;s provider. Model availability, data use and retention depend on the selected provider and account settings; there is no fixed provider for every installation.</p>
      <p>If the operator selects Meta Muse Spark 1.3 Contributor, Contributor permits Meta to retain submitted content and use it to train models. The exact model IDs <code>meta/muse-spark-1.3-contributor</code> and <code>nvidia/nemotron-3-ultra-550b-a55b:free</code> are explicit routing exceptions that permit provider data collection without requiring zero-data-retention routing. Other model IDs request denied data collection and zero-data-retention routing. These settings are not an end-to-end retention guarantee; review the selected provider&rsquo;s terms before submitting content.</p>
      <p>The provider also supports input caching, which may retain and reuse the computed prefix of repeated prompts. This is provider-side processing, not a conversation database on our servers. Clearing the chat, signing out or reloading the page does not itself delete content or cached state held by a provider. OpenRouter&rsquo;s own logging, use and retention of data depend on its policies and account settings; this notice does not promise that provider-side logging is disabled.</p>
      <p>Review <a href="https://openrouter.ai/docs/guides/privacy/data-collection" target="_blank" rel="noreferrer noopener">OpenRouter&rsquo;s data policies</a> and <a href="https://dev.meta.ai/docs/pricing-rate-limits#contributor-mode" target="_blank" rel="noreferrer noopener">Meta&rsquo;s explanation of Contributor mode</a> before use. Do not submit sensitive personal data, confidential information, credentials or anything you do not have permission to share.</p>

      <h2>3. Essential sign-in cookie, not tracking cookies</h2>
      <p>Signing in sets the essential <code>__Host-vesuvius_session</code> cookie, normally valid for up to 24 hours and removed on successful sign-out. It contains a signed access token, not your conversation. It is configured with Secure, HttpOnly and SameSite protections. The website does not use advertising cookies, analytics scripts or tracking cookies. Your browser may still cache public assets such as fonts and JavaScript; those assets do not contain your conversation.</p>

      <h2>4. Operational metadata and rate limits</h2>
      <p>The default Docker proxy disables access logging. The quota database stores keyed hashes for per-IP limits, counters and expiring capacity leases rather than raw addresses or conversations. Service logs contain limited operational metadata such as status/error codes, source counts and numeric token counts, not question, evidence or reply contents. Expired quota entries are pruned as requests are processed.</p>
      <p>Operators may configure additional proxies, hosting logs or monitoring. Their collection, access controls and retention must be disclosed by that operator; this template does not promise a particular log-rotation schedule or immediate metadata deletion. IP addresses can be personal data, and operating-system or infrastructure records are separate from application content logs.</p>

      <h2>5. Processing memory and deletion limits</h2>
      <p>No conversation-history feature or chat-content archive is provided by the application. However, transient processing is not a forensic-erasure guarantee: runtime memory, temporary storage and host swap settings have a different lifecycle from the visible conversation. The operator controls those infrastructure settings; this software does not guarantee that every memory byte is securely erased as soon as a request ends.</p>
      <p>Depending on applicable law, you may have rights relating to personal data. Provider-held data and deletion requests are subject to the providers&rsquo; processes and legal obligations. We cannot promise to remove data from an external provider simply because you clear the local chat. If these practices are not acceptable to you, do not submit content or use the service.</p>

      <h2>6. Changes to this notice</h2>
      <p>Changes will be published here with an updated effective date. Check this notice before submitting content, especially if the model or provider changes. The current practices described here do not waive any mandatory privacy rights or establish compliance with every jurisdiction&rsquo;s legal requirements.</p>
      <p><Link href="/">Back to chat</Link> · <Link href="/terms">Read the Terms of Use</Link></p>
    </main>
    <PrivacyFooter />
  </div>;
}
