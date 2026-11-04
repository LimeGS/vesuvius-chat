import { expect, test, vi } from "vitest";
import { temporalScope, type TemporalScope } from "../lib/chat-time";

const now = new Date("2026-11-03T23:30:45.123Z");

test("best posts of the day uses today's local calendar interval, not all historical posts", () => {
  expect(temporalScope("What are the best posts of the day?", now, "America/Argentina/Buenos_Aires"))
    .toMatchObject({ since: "2026-11-03T03:00:00.000Z", until: "2026-11-04T03:00:00.000Z", list: true });
  expect(temporalScope("Best posts about ink detection of the day", now))
    .toMatchObject({ since: "2026-11-03T00:00:00.000Z", until: "2026-11-04T00:00:00.000Z", list: false });
});

test("the Nov 2 date-only question enumerates exactly that day, not semantic neighbors", () => {
  const scope: TemporalScope = temporalScope("2026-11-02 do you have something of that date?", now);
  expect(scope).toEqual({ now: "2026-11-03T23:30:45.123Z", timeZone: "UTC", timezoneFallback: true,
    since: "2026-11-02T00:00:00.000Z", until: "2026-11-03T00:00:00.000Z", list: true });
});

test.each([
  ["", false], ["ink detection", false], ["PHerc 1447", false],
  ['"winding-fields" on 2026-11-02', false], ["ink detection on 2026-11-02", false],
  ["list messages on 2026-11-02", true], ["list messages about ink detection on 2026-11-02", false],
  ["show messages", true], ["¿Hay mensajes del 2026-11-02?", true],
  ["scroll-2026-11-02", false],
])("only keyword-free requests enumerate: %s", (text, list) => {
  expect(temporalScope(text, now).list).toBe(list);
});

test("plain topic identifiers and scroll numbers are not dates", () => {
  expect(temporalScope('PHerc 1447 "winding-fields" scroll-2026-11-02', now, "UTC"))
    .toEqual({ now: "2026-11-03T23:30:45.123Z", timeZone: "UTC", timezoneFallback: false, list: false });
});

test.each([undefined, "", "   "])("missing/blank timezone explicitly falls back: %j", zone => {
  expect(temporalScope("", now, zone)).toMatchObject({ timeZone: "UTC", timezoneFallback: true });
});

test("explicit valid zones are validated without claiming fallback", () => {
  expect(temporalScope("", now, "UTC")).toMatchObject({ timeZone: "UTC", timezoneFallback: false });
  expect(temporalScope("", now, " America/New_York "))
    .toMatchObject({ timeZone: "America/New_York", timezoneFallback: false });
});

test.each(["Not/AZone", "+01:00", "America/New_York; DROP TABLE messages"])("bad configured timezone throws RangeError: %s", zone => {
  expect(() => temporalScope("today", now, zone)).toThrow(RangeError);
});

test("default clock is read server-side and includes milliseconds", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T23:30:00.123Z"));
    expect(temporalScope("today")).toMatchObject({ now: "2026-01-01T23:30:00.123Z",
      since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" });
  } finally { vi.useRealTimers(); }
});

test.each([
  ["today", "UTC", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z"],
  ["hoy", "Asia/Tokyo", "2026-11-03T15:00:00.000Z", "2026-11-04T15:00:00.000Z"],
  ["yesterday", "America/Los_Angeles", "2026-11-02T08:00:00.000Z", "2026-11-03T08:00:00.000Z"],
  ["ayer", "Pacific/Kiritimati", "2026-11-02T10:00:00.000Z", "2026-11-03T10:00:00.000Z"],
  ["2026-11-02", "Asia/Kathmandu", "2026-11-01T18:15:00.000Z", "2026-11-02T18:15:00.000Z"],
  ["2026-03-08", "America/New_York", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
  ["2026-11-01", "America/New_York", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ["2018-11-04", "America/Sao_Paulo", "2018-11-04T03:00:00.000Z", "2018-11-05T02:00:00.000Z"],
])("calendar boundaries are zone-local, including DST: %s %s", (text, zone, since, until) => {
  expect(temporalScope(text, now, zone)).toMatchObject({ since, until, list: true });
});

test.each([
  ["2026-12-31T23:30:00.000Z", "Asia/Tokyo", "today", "2026-12-31T15:00:00.000Z", "2027-01-01T15:00:00.000Z"],
  ["2026-03-01T00:15:00.000Z", "America/New_York", "today", "2026-02-28T05:00:00.000Z", "2026-03-01T05:00:00.000Z"],
  ["2027-01-01T00:15:00.000Z", "UTC", "ayer", "2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
])("relative days cross local month/year correctly: %s %s", (clock, zone, text, since, until) => {
  expect(temporalScope(text, new Date(clock), zone)).toMatchObject({ since, until });
});

test.each(["last week", "semana pasada"])("previous week is Monday-to-Monday across DST: %s", text => {
  expect(temporalScope(text, now, "America/New_York")).toMatchObject({
    since: "2026-10-26T04:00:00.000Z", until: "2026-11-02T05:00:00.000Z", list: true });
});

test("Sunday still belongs to the current Monday-based week", () => {
  expect(temporalScope("last week", new Date("2026-03-08T23:30:00Z"), "America/New_York"))
    .toMatchObject({ since: "2026-02-23T05:00:00.000Z", until: "2026-03-02T05:00:00.000Z" });
});

test.each([
  "from 2026-03-07 to 2026-03-08", "between 2026-03-07 and 2026-03-08",
  "desde 2026-03-07 hasta 2026-03-08", "entre 2026-03-07 y 2026-03-08",
])("calendar range end includes the whole last local date: %s", text => {
  expect(temporalScope(text, now, "America/New_York")).toMatchObject({
    since: "2026-03-07T05:00:00.000Z", until: "2026-03-09T04:00:00.000Z", list: true });
});

test("offset timestamp range denotes exact instants and an exclusive end", () => {
  expect(temporalScope("from 2026-11-01T01:00:00-04:00 to 2026-11-01T01:00:00-05:00", now, "Asia/Tokyo"))
    .toMatchObject({ since: "2026-11-01T05:00:00.000Z", until: "2026-11-01T06:00:00.000Z", list: true });
});

test.each([
  ["since 2026-11-02T11:30:00+05:30", { since: "2026-11-02T06:00:00.000Z" }],
  ["until 2026-11-02T11:30Z", { until: "2026-11-02T11:30:00.000Z" }],
  ["since 2026-11-02", { since: "2026-11-02T00:00:00.000Z" }],
  ["hasta 2026-11-02", { until: "2026-11-03T00:00:00.000Z" }],
])("explicit one-sided bounds do not invent the other bound: %s", (text, bounds) => {
  const scope = temporalScope(text, now, "UTC");
  expect({ since: scope.since, until: scope.until }).toEqual(bounds);
});

test("a standalone timestamp denotes exactly its millisecond", () => {
  expect(temporalScope("2026-11-02T01:02:03.456+02:00", now))
    .toMatchObject({ since: "2026-11-01T23:02:03.456Z", until: "2026-11-01T23:02:03.457Z" });
});

test.each([
  "03/04/2026", "03-04-2026", "2026-02-30", "2026-13-01", "2026-00-01", "2026-11-00",
  "2026-2-03", "2026-11-02T25:00:00Z", "2026-02-30T12:00:00Z", "2026-11-02T12:00:00",
  "2026-11-02T12:00:00+25:00", "2026-11-02T12:00:60Z", "2026-11-02 12:00",
  "2026-11-02 and 2026-11-03", "from 2026-11-03 to 2026-11-02",
  "from 2026-11-02T12:00Z to 2026-11-02T11:00Z", "today or yesterday", "today on 2026-11-02",
  "from 2026-11-01 to 2026-11-02 and 2026-11-03", "2011-12-30",
])("ambiguous/invalid temporal requests never silently become unfiltered: %s", text => {
  const scope = temporalScope(text, now, "Pacific/Apia");
  expect(scope.ambiguous).toEqual(expect.any(String));
  expect(scope.ambiguous!.length).toBeGreaterThan(0);
  expect(scope.since).toBeUndefined();
  expect(scope.until).toBeUndefined();
  expect(scope.list).toBe(false);
});

test("leap dates are calendar-validated, not rejected wholesale", () => {
  expect(temporalScope("2024-02-29", now)).toMatchObject({
    since: "2024-02-29T00:00:00.000Z", until: "2024-03-01T00:00:00.000Z" });
});

test.each([
  ["list messages in #ink-detection by @researcher", "ink-detection", "researcher"],
  ["list messages <#123456789012345678> <@!987654321098765432>", "123456789012345678", "987654321098765432"],
  ['list messages channel:general author:"Display Name"', "general", "Display Name"],
  ["list messages channel:general <@987654321098765432>", "general", "987654321098765432"],
])("exact channel/author selectors are data, not search terms: %s", (text, channel, author) => {
  expect(temporalScope(text, now)).toMatchObject({ channel, author, list: true });
});

test("quoted author data remains inert and is not reparsed as a date", () => {
  expect(temporalScope('list messages author:"2026-11-02; DROP TABLE messages"', now))
    .toMatchObject({ author: "2026-11-02; DROP TABLE messages", list: true });
  expect(temporalScope('author:"Name" ink detection', now)).toMatchObject({ author: "Name", list: false });
});

test.each([
  "#" + "a".repeat(81), 'author:"' + "a".repeat(81) + '"', "<#" + "1".repeat(33) + ">",
  "<@!" + "1".repeat(33) + ">", "#first #second", "@first @second", 'author:"unterminated',
])("malformed, oversized or conflicting selectors fail closed: %s", text => {
  const scope = temporalScope(text, now);
  expect(scope.ambiguous).toEqual(expect.any(String));
  expect(scope.list).toBe(false);
});

test("selector boundaries accept 80-character names and 32-digit snowflakes", () => {
  expect(temporalScope("#" + "a".repeat(80) + " <@" + "1".repeat(32) + ">", now))
    .toMatchObject({ channel: "a".repeat(80), author: "1".repeat(32), list: true });
});

test.each([
  "https://discord.com/channels/111/222/123456789012345678",
  "https://discord.com/channels/111/222/123456789012345678?jump=1",
  "https://discordapp.com/channels/111/222/123456789012345678",
  "get message 123456789012345678", "message ID: 123456789012345678", "message_id:123456789012345678",
])("direct message references preserve the original ID: %s", text => {
  expect(temporalScope(text, now)).toMatchObject({ messageId: "123456789012345678", list: false });
});

test("arbitrary URLs and bare numbers are not message references", () => {
  expect(temporalScope("https://evil.test/channels/111/222/333 PHerc 1447 123456789012345678", now).messageId)
    .toBeUndefined();
});

test.each(["message ID: " + "1".repeat(33), "get message 111 and get message 222"])("invalid/conflicting message IDs fail closed: %s", text => {
  expect(temporalScope(text, now).ambiguous).toEqual(expect.any(String));
});

test("oversized input is rejected rather than truncating away temporal filters", () => {
  expect(temporalScope("x".repeat(65537) + " 2026-11-02", now).ambiguous).toEqual(expect.any(String));
});

test("an invalid server clock is a configuration error, not a guessed current date", () => {
  expect(() => temporalScope("today", new Date(NaN))).toThrow(RangeError);
});

test.each(["2026-001-02", "2026-11-002", "2026-02-29", "2026-11-02T12:00:00.1234Z"])("malformed date widths/precision cannot drop temporal intent: %s", text => {
  expect(temporalScope(text, now).ambiguous).toEqual(expect.any(String));
});

test.each(["today-fields", "scroll-yesterday", "lastweek-results"])("relative-looking identifiers do not add date filters: %s", text => {
  expect(temporalScope(text, now)).toEqual({ now: "2026-11-03T23:30:45.123Z", timeZone: "UTC", timezoneFallback: true, list: false });
});

test.each(["https://", "https://!invalid host", "https://[invalid]"])("malformed URL text never throws or becomes a fetched reference: %s", text => {
  expect(temporalScope(text, now)).toEqual({ now: "2026-11-03T23:30:45.123Z", timeZone: "UTC", timezoneFallback: true, list: false });
});

test.each([
  ["2026-03-08T23:30:00Z", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
  ["2026-11-01T23:30:00Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
])("relative today uses DST-correct local boundaries: %s", (clock, since, until) => {
  expect(temporalScope("today", new Date(clock), "America/New_York")).toMatchObject({ since, until });
});

test("ambiguous temporal input cannot leave partial selectors for a caller to accidentally execute", () => {
  expect(temporalScope("list messages #general @user on 2026-02-30", now))
    .toEqual({ now: "2026-11-03T23:30:45.123Z", timeZone: "UTC", timezoneFallback: true,
      list: false, ambiguous: expect.any(String) });
});

test("control characters in selector data fail closed", () => {
  expect(temporalScope('author:"Name\u0085Hidden"', now).ambiguous).toEqual(expect.any(String));
});

test.each(["message ID: 123", "https://discord.com/channels/111/222/333"])("quoted author is opaque even when it looks like a message reference: %s", author => {
  expect(temporalScope('list messages author:"' + author + '"', now))
    .toEqual({ now: "2026-11-03T23:30:45.123Z", timeZone: "UTC", timezoneFallback: true, list: true, author });
});

test("selector-like text inside unrelated URLs is not a filter", () => {
  expect(temporalScope("https://example.test/?author:name&channel:general", now))
    .toEqual({ now: "2026-11-03T23:30:45.123Z", timeZone: "UTC", timezoneFallback: true, list: false });
});
