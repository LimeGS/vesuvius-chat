// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import TermsPage from "../app/terms/page";
import PrivacyPage from "../app/privacy/page";
import PrivacyFooter from "../app/privacy-footer";

afterEach(cleanup);

test("terms explain self-hosted costs and as-is AI access without waiving mandatory rights", () => {
  render(<TermsPage />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Terms of Use");
  expect(screen.getByText(/API usage may incur charges/)).toBeTruthy();
  expect(screen.getByText(/as is.*as available/)).toBeTruthy();
  expect(screen.getByText(/Nothing in these terms excludes or limits liability where doing so would be unlawful/)).toBeTruthy();
  expect(screen.getByText(/independently verify important information/)).toBeTruthy();
  expect(screen.getByText(/do not select a governing jurisdiction/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to chat" }).getAttribute("href")).toBe("/");
});

test("privacy distinguishes our message handling from cookies and external training", () => {
  render(<PrivacyPage />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Privacy Notice");
  expect(screen.getByText("__Host-vesuvius_session")).toBeTruthy();
  expect(screen.getByText(/The operator selects the model/)).toBeTruthy();
  expect(screen.getByText(/If the operator selects Meta Muse Spark/)).toBeTruthy();
  expect(screen.getByText(/No message logs on our servers does not mean/)).toBeTruthy();
  expect(screen.getByText(/not a forensic-erasure guarantee/)).toBeTruthy();
  expect(screen.getByText(/default Docker proxy disables access logging/)).toBeTruthy();
  expect(screen.queryByText(/encrypted EC2 swap|seven rotated access-log files/)).toBeNull();
  expect(screen.getByRole("link", { name: "OpenRouter’s data policies" }).getAttribute("href")).toBe("https://openrouter.ai/docs/guides/privacy/data-collection");
});

test("shared footer preserves the privacy statement and public legal navigation", () => {
  render(<PrivacyFooter />);
  const footer = within(screen.getByRole("contentinfo"));
  expect(footer.getByText("No tracking. No message logs on our servers.")).toBeTruthy();
  expect(footer.getByRole("link", { name: /Terms of Use/ }).getAttribute("href")).toBe("/terms");
  expect(footer.getByRole("link", { name: /Privacy Notice/ }).getAttribute("href")).toBe("/privacy");
});

test("reading footer policies opens a protected new tab instead of discarding the current chat", () => {
  render(<PrivacyFooter />);
  for (const name of [/Terms of Use/, /Privacy Notice/]) {
    const link = screen.getByRole("link", { name });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    expect(link.getAttribute("rel")).toMatch(/noreferrer/);
    expect(link.getAttribute("aria-label")).toMatch(/opens in a new tab/);
  }
});
