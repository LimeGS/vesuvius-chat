import Link from "next/link";

export default function PrivacyFooter() {
  return <footer className="privacy-footer">
    <p className="privacy-statement">No tracking. No message logs on our servers.</p>
    <nav aria-label="Legal">
      <Link href="/terms" target="_blank" rel="noreferrer noopener" aria-label="Terms of Use (opens in a new tab)" title="Opens in a new tab">Terms of Use <span aria-hidden="true">↗</span></Link>
      <Link href="/privacy" target="_blank" rel="noreferrer noopener" aria-label="Privacy Notice (opens in a new tab)" title="Opens in a new tab">Privacy Notice <span aria-hidden="true">↗</span></Link>
    </nav>
  </footer>;
}
