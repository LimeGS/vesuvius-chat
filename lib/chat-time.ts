export type TemporalScope = {
  now: string;
  timeZone: string;
  timezoneFallback: boolean;
  since?: string;
  until?: string;
  channel?: string;
  author?: string;
  list: boolean;
  messageId?: string;
  ambiguous?: string;
};

const DAY = 86_400_000;

function utcDay(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
}

/** Parse only explicit selectors and documented date forms; never execute or fetch input. */
export function temporalScope(text: string, now: Date = new Date(), timeZone?: string): TemporalScope {
  const zone = timeZone?.trim() || "UTC";
  if (/^[+-]/.test(zone)) throw new RangeError("Expected an IANA time zone, not a UTC offset");
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, calendar: "iso8601", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const base: TemporalScope = {
    now: now.toISOString(), timeZone: formatter.resolvedOptions().timeZone,
    timezoneFallback: !timeZone?.trim(), list: false,
  };
  const scope = { ...base };
  const fail = (ambiguous: string): TemporalScope => ({ ...base, ambiguous });
  if (text.length > 65_536) return fail("Request exceeds 65536 characters; please shorten it.");

  let error = "";
  function selector(key: "channel" | "author" | "messageId", value: string, idOnly = false) {
    if (!value || /\p{Cc}/u.test(value) || value.length > 80 ||
        ((idOnly || /^\d+$/.test(value)) && !/^\d{1,32}$/.test(value))) {
      error = "Invalid selector: names allow 80 characters and IDs allow 32 digits.";
    } else if (scope[key] && scope[key] !== value) {
      error = "Conflicting selectors; specify one channel, author or message ID.";
    } else {
      scope[key] = value;
    }
  }

  let remaining = text.replace(/(?<!\S)(channel|author):(?:"([^"\r\n]*)"|([^\s,;!?]+))/giu,
    (_match, key: string, quoted: string | undefined, bare: string | undefined) => {
      if (bare?.startsWith('"')) error = "Unclosed quoted selector.";
      else selector(key.toLowerCase() as "channel" | "author", quoted ?? bare ?? "");
      return " ";
    });
  remaining = remaining.replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    let url: URL;
    try { url = new URL(raw.replace(/[.,!?)]*$/, "")); }
    catch { return " __url__ "; }
    if (!/^(?:(?:www|canary|ptb)\.)?discord(?:app)?\.com$/.test(url.hostname) ||
        url.protocol !== "https:" || url.username || url.password) return " __url__ ";
    const match = /^\/channels\/(?:\d{1,32}|@me)\/\d{1,32}\/(\d+)\/?$/.exec(url.pathname);
    if (match) selector("messageId", match[1], true);
    else if (url.pathname.startsWith("/channels/")) error = "Invalid Discord message permalink.";
    return " __url__ ";
  });
  remaining = remaining.replace(/\b(?:get\s+message|message[\s_]*id)\s*:?\s*(\d+)(?![\p{L}\p{N}_-])/giu, (_match, id: string) => {
    selector("messageId", id, true);
    return " ";
  });
  remaining = remaining.replace(/<([#@])(!?)([^<>\s]*)>/g, (_match, kind: string, bang: string, id: string) => {
    if (kind === "#" && bang) error = "Invalid channel mention.";
    selector(kind === "#" ? "channel" : "author", id, true);
    return " ";
  });
  remaining = remaining.replace(/(?<![\p{L}\p{N}_/])([#@])([\p{L}\p{N}_.-]+)/gu,
    (_match, kind: string, name: string) => {
      selector(kind === "#" ? "channel" : "author", name);
      return " ";
    });
  if (/\b(?:channel|author):|\bmessage[\s_]*id\s*:|<[#@]/i.test(remaining)) error = "Malformed selector.";
  if (error) return fail(error);

  // Synthetic UTC dates represent calendar arithmetic only, never a fixed-length local day.
  function localDay(instant: number): number {
    const parts = formatter.formatToParts(instant);
    const year = Number(parts.find(part => part.type === "year")!.value);
    const month = Number(parts.find(part => part.type === "month")!.value);
    const day = Number(parts.find(part => part.type === "day")!.value);
    return utcDay(year, month, day);
  }
  function boundary(day: number): number {
    if (base.timeZone === "UTC") return day;
    // First instant on/after the date also handles a DST gap at local midnight.
    let low = day - 2 * DAY;
    let high = day + 2 * DAY;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (localDay(middle) < day) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  function bounds(token: string): { start: number; end: number; calendar: boolean } | undefined {
    const date = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/i.exec(token);
    if (!date) return;
    const [year, month, day] = date.slice(1).map(Number);
    const calendarDay = utcDay(year, month, day);
    const check = new Date(calendarDay);
    if (year < 1 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return;
    if (token.length === 10) {
      const start = boundary(calendarDay);
      const end = boundary(calendarDay + DAY);
      if (start >= end) return;
      return { start, end, calendar: true };
    }
    const time = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(token);
    if (!time) return;
    const [, hour, minute, second = "0", fraction = "", offset, sign, offsetHour = "0", offsetMinute = "0"] = time;
    if (+hour > 23 || +minute > 59 || +second > 59 || +offsetHour > 23 || +offsetMinute > 59) return;
    const offsetMs = offset.toUpperCase() === "Z" ? 0 : (sign === "-" ? -1 : 1) * (+offsetHour * 60 + +offsetMinute) * 60_000;
    const start = calendarDay + +hour * 3_600_000 + +minute * 60_000 + +second * 1000 + Number(fraction.padEnd(3, "0")) - offsetMs;
    return { start, end: start + 1, calendar: false };
  }

  if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}\/\d{1,2}\/\d{1,2}\b/.test(remaining)) {
    return fail("Ambiguous numeric date; use YYYY-MM-DD or an ISO timestamp with UTC offset.");
  }
  const datePattern = /(?<![\p{L}\p{N}_-])\d{4}-\d+-\d+(?:T[\dA-Za-z:.+-]*)?(?![\p{L}\p{N}_-])/giu;
  const dates = [...remaining.matchAll(datePattern)];
  const relativePattern = /(?<![\p{L}\p{N}_-])(?:today|of\s+the\s+day|hoy|yesterday|ayer|last\s*week|semana\s+pasada)(?![\p{L}\p{N}_-])/giu;
  const relatives = [...remaining.matchAll(relativePattern)];
  if (dates.length > 2 || relatives.length > 1 || (dates.length && relatives.length)) {
    return fail("Multiple date scopes; specify one date or one explicit range.");
  }
  let since: number | undefined;
  let until: number | undefined;
  if (dates.length) {
    const tokens = dates.map(match => match[0].replace(/\.$/, ""));
    const parsed = tokens.map(bounds);
    if (parsed.some(value => !value) || dates.some(match => /^\s+\d{1,2}:\d{2}/.test(remaining.slice(match.index! + match[0].length)))) {
      return fail("Invalid date or timestamp; use a real YYYY-MM-DD date or ISO timestamp with UTC offset.");
    }
    const first = parsed[0]!;
    const prefix = remaining.slice(0, dates[0].index).trim();
    if (dates.length === 2) {
      const connector = remaining.slice(dates[0].index! + dates[0][0].length, dates[1].index).trim();
      if (!/^(?:to|a|hasta)$/i.test(connector) &&
          !(/^(?:and|y)$/i.test(connector) && /\b(?:between|entre)$/i.test(prefix))) {
        return fail("Two dates require an explicit from/to or between/and range.");
      }
      since = first.start;
      until = parsed[1]!.calendar ? parsed[1]!.end : parsed[1]!.start;
    } else if (/\b(?:since|desde)$/i.test(prefix)) {
      since = first.start;
    } else if (/\b(?:until|hasta)$/i.test(prefix)) {
      until = first.calendar ? first.end : first.start;
    } else {
      since = first.start;
      until = first.end;
    }
    remaining = remaining.replace(datePattern, " ");
  } else if (relatives.length) {
    const token = relatives[0][0].toLowerCase();
    let day = localDay(now.getTime());
    if (/week|semana/.test(token)) {
      day -= ((new Date(day).getUTCDay() + 6) % 7 + 7) * DAY;
      since = boundary(day);
      until = boundary(day + 7 * DAY);
    } else {
      if (token === "yesterday" || token === "ayer") day -= DAY;
      since = boundary(day);
      until = boundary(day + DAY);
    }
    remaining = remaining.replace(relativePattern, " ");
  }
  if (since !== undefined && until !== undefined && since >= until) return fail("Date range must end after it starts.");
  if (since !== undefined) scope.since = new Date(since).toISOString();
  if (until !== undefined) scope.until = new Date(until).toISOString();

  // shortcut: narrow English/Spanish listing grammar; expand only with real phrasing regressions.
  const residue = remaining.normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/\b(?:list|show|find|get|what|are|were|best|top|messages?|posts?|please|do|you|have|something|anything|any|all|of|that|the|date|dates|day|on|in|by|from|to|between|and|since|until|a|an|me|hay|tienes|tenes|algo|algun|alguna|algunos|lista|listar|mostrar|muestra|mensajes?|publicaciones|del|de|el|la|los|las|en|por|favor|desde|hasta|entre|y|fecha|dia)\b/gi, " ")
    .replace(/[\s.,;:!?¿¡()[\]{}'"<>]+/g, "");
  scope.list = !scope.messageId && !residue && Boolean(scope.since || scope.until || scope.channel || scope.author || /\b(?:list|show|messages|mensajes|listar|mostrar)\b/i.test(text));
  return scope;
}
