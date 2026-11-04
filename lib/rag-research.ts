// Server-only. Corpus, tool results and model arguments are untrusted data.
import type { Client } from "@modelcontextprotocol/client";
import type { TemporalScope } from "./chat-time";
import { withRagClient, type RetrievedDocument } from "./rag";

export const researchLimits = Object.freeze({ calls: 8, results: 100, milliseconds: 90_000, modelCalls: 3, outputTokens: 3200, inputBytes: 65_536 });

export class ResearchUnsupportedError extends Error {
  constructor() { super("Structured research is unavailable for this corpus"); this.name = "ResearchUnsupportedError"; }
}
export class ResearchBudgetError extends Error {
  constructor() { super("Research budget exhausted; results are partial"); this.name = "ResearchBudgetError"; }
}

export type CorpusInfo = {
  version: 1; snapshot: string; backend: "cpu" | "gpu";
  coverageStart: string | null; coverageEnd: string | null; updatedAt: string | null;
  latestMessageAt: string | null; messageCount: number | null; capabilities: { structured: boolean };
};
type Message = {
  messageId: string; timestamp: string; channelId: string; channel: string;
  authorId: string; author: string; threadId: string | null; text: string; url: string;
  username?: string; globalName?: string;
};
type Page = { version: 1; snapshot: string; messages: Message[]; nextCursor: string | null; exhaustive: boolean };
type Budget = { calls: number; reviewed: number; deadline: number };
type Chain = { next: string | null; cursors: Set<string>; last?: Message; finished: boolean };
type ResearchConfig = { ragUrl: string; ragPrimaryUrl?: string; ragToken: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new Error("Invalid structured research response"); }
function badArguments(): never { throw new Error("Invalid research tool arguments"); }
function numeric(value: unknown): value is string { return typeof value === "string" && /^\d{1,32}$/.test(value); }
function boundedString(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }

// Validate the local calendar as well as the offset: Date.parse normalizes February 30.
function iso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const day = new Date(`${match[1]}T00:00:00Z`);
  return day.toISOString().slice(0, 10) === match[1] && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60 && (!match[6] || (Number(match[6]) < 24 && Number(match[7]) < 60));
}

function micros(value: string): bigint {
  const fraction = value.match(/\.(\d{1,6})(?:Z|[+-])/)?.[1] ?? "";
  return BigInt(Date.parse(value)) * BigInt(1000) + BigInt(fraction.padEnd(6, "0").slice(3));
}

function parseInfo(value: unknown): CorpusInfo {
  if (!object(value) || value.version !== 1 || !boundedString(value.snapshot, 128) || (value.backend !== "cpu" && value.backend !== "gpu") ||
      !object(value.capabilities) || typeof value.capabilities.structured !== "boolean") invalid();
  if ((!Number.isSafeInteger(value.messageCount) || Number(value.messageCount) < 0) && !(value.messageCount === null && !value.capabilities.structured)) invalid();
  for (const field of ["coverageStart", "coverageEnd", "updatedAt", "latestMessageAt"]) if (value[field] !== null && !iso(value[field])) invalid();
  if ((value.coverageStart === null) !== (value.coverageEnd === null) || (value.coverageStart && value.coverageEnd && micros(String(value.coverageStart)) > micros(String(value.coverageEnd)))) invalid();
  if (Number(value.messageCount) > 0 && (value.coverageStart === null || value.latestMessageAt === null)) invalid();
  return { version: 1, snapshot: value.snapshot, backend: value.backend as "cpu" | "gpu", coverageStart: value.coverageStart as string | null, coverageEnd: value.coverageEnd as string | null, updatedAt: value.updatedAt as string | null, latestMessageAt: value.latestMessageAt as string | null, messageCount: value.messageCount as number | null, capabilities: { structured: value.capabilities.structured } };
}

const filterSchema = { since: "string", until: "string", channel: "string", author: "string" };
const toolSchemas: Record<string, Record<string, string>> = {
  corpus_info: {}, search_messages: { query: "string", ...filterSchema, limit: "integer" },
  list_messages: { ...filterSchema, limit: "integer", cursor: "string" },
  get_message: { message_id: "string", ...filterSchema },
  get_thread: { message_id: "string", ...filterSchema, limit: "integer", cursor: "string" },
};

function validateCatalog(tools: unknown[]) {
  for (const [name, expected] of Object.entries(toolSchemas)) {
    const matches = tools.filter(tool => object(tool) && tool.name === name);
    if (matches.length !== 1) throw new ResearchUnsupportedError();
    const tool = matches[0] as Record<string, unknown>;
    const schema = tool.inputSchema;
    if (!object(tool.annotations) || tool.annotations.readOnlyHint !== true || tool.annotations.destructiveHint === true || !object(schema) || schema.type !== "object" || !object(schema.properties)) throw new ResearchUnsupportedError();
    for (const [key, type] of Object.entries(expected)) {
      const property = schema.properties[key];
      if (!object(property)) throw new ResearchUnsupportedError();
      const nullable = ["since", "until", "channel", "author", "cursor"].includes(key) && Array.isArray(property.anyOf) && property.anyOf.length === 2 &&
        property.anyOf.every(branch => object(branch) && (branch.type === type || branch.type === "null")) &&
        property.anyOf.some(branch => object(branch) && branch.type === type) && property.anyOf.some(branch => object(branch) && branch.type === "null");
      if (property.type !== type && !nullable) throw new ResearchUnsupportedError();
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string" || !Object.hasOwn(expected, key)))) throw new ResearchUnsupportedError();
    const required = name === "search_messages" ? "query" : name === "get_message" || name === "get_thread" ? "message_id" : undefined;
    if (required && (!Array.isArray(schema.required) || !schema.required.includes(required))) throw new ResearchUnsupportedError();
  }
}

function matchesFilter(filter: string | undefined, id: string, ...names: string[]): boolean {
  return filter === undefined || (/^\d+$/.test(filter) ? filter === id : names.some(name => filter.toLowerCase() === name.toLowerCase()));
}
function parsePage(value: unknown, info: CorpusInfo, scope: TemporalScope, limit: number): Page {
  if (!object(value) || value.version !== 1 || value.snapshot !== info.snapshot || !Array.isArray(value.messages) || value.messages.length > Math.min(20, limit) ||
      (value.nextCursor !== null && !boundedString(value.nextCursor, 4096)) || typeof value.exhaustive !== "boolean") invalid();
  if (value.nextCursor !== null && value.exhaustive) invalid();
  const messages = value.messages.map((item): Message => {
    if (!object(item) || !numeric(item.messageId) || !iso(item.timestamp) || !numeric(item.channelId) || !numeric(item.authorId) ||
        !boundedString(item.channel, 180) || !boundedString(item.author, 180) || (item.threadId !== null && !numeric(item.threadId)) ||
        typeof item.text !== "string" || item.text.length > 4000 || !boundedString(item.url, 2000)) invalid();
    for (const key of ["username", "globalName"]) if (item[key] !== undefined && !boundedString(item[key], 180)) invalid();
    const aliases = { ...(typeof item.username === "string" ? { username: item.username } : {}), ...(typeof item.globalName === "string" ? { globalName: item.globalName } : {}) };
    const link = /^https:\/\/discord\.com\/channels\/\d{1,32}\/(\d{1,32})\/(\d{1,32})$/.exec(item.url);
    const time = micros(item.timestamp);
    if (!link || link[1] !== item.channelId || link[2] !== item.messageId || (scope.since && time < micros(scope.since)) || (scope.until && time >= micros(scope.until)) ||
        !matchesFilter(scope.channel, item.channelId, item.channel) || !matchesFilter(scope.author, item.authorId, item.author, ...Object.values(aliases))) invalid();
    return { messageId: item.messageId, timestamp: item.timestamp, channelId: item.channelId, channel: item.channel, authorId: item.authorId, author: item.author, threadId: item.threadId as string | null, text: item.text, url: item.url, ...aliases };
  });
  return { version: 1, snapshot: info.snapshot, messages, nextCursor: value.nextCursor as string | null, exhaustive: value.exhaustive };
}

async function invoke(client: Client, name: string, args: Record<string, unknown>, signal: AbortSignal, budget: Budget): Promise<unknown> {
  signal.throwIfAborted();
  const remaining = budget.deadline - Date.now();
  if (budget.calls >= researchLimits.calls || budget.reviewed >= researchLimits.results || remaining <= 0) throw new ResearchBudgetError();
  budget.calls++;
  try {
    const result = await client.callTool({ name, arguments: args }, { signal, timeout: remaining, maxTotalTimeout: remaining });
    if (result.isError) invalid();
    // FastMCP wraps a typed dictionary result in `result` on some versions.
    const content = result.structuredContent;
    return object(content) && content.version === undefined && object(content.result) ? content.result : content;
  } catch {
    signal.throwIfAborted();
    throw new Error("Research tool failed");
  }
}

export class ResearchSession {
  documents: RetrievedDocument[] = [];
  hasMore = false;
  exhausted = false;
  private broken = false;
  private started = false;
  private initializing = false;
  private pending = false;
  private listFinished = false;
  private seen = new Set<string>();
  private chains = new Map<string, Chain>();
  private evidence: Message[] = [];
  private readonly scope: TemporalScope;

  constructor(readonly info: CorpusInfo, scope: TemporalScope, private client: Client, private signal: AbortSignal, private callerSignal: AbortSignal, private budget: Budget) {
    this.scope = Object.freeze({ ...scope });
    Object.freeze(info.capabilities); Object.freeze(info);
  }
  get calls() { return this.budget.calls; }
  get reviewed() { return this.budget.reviewed; }
  get stale() { return this.info.updatedAt === null || Date.parse(this.scope.now) - Date.parse(this.info.updatedAt) > 2 * 60 * 60 * 1000; }
  private get inCoverage() {
    return Boolean(this.scope.since && this.scope.until && this.info.coverageStart && this.info.coverageEnd && micros(this.scope.since) >= micros(this.info.coverageStart) && micros(this.scope.until) <= micros(this.info.coverageEnd));
  }
  private get outsideCoverage() {
    return Boolean((this.scope.since && this.info.coverageEnd && micros(this.scope.since) >= micros(this.info.coverageEnd)) || (this.scope.until && this.info.coverageStart && micros(this.scope.until) <= micros(this.info.coverageStart)));
  }
  get complete() { return this.scope.list && this.inCoverage && this.listFinished && !this.broken && !this.exhausted; }
  get absenceVerified() { return this.complete && this.reviewed === 0 && !this.stale; }

  summary() {
    const state: "partial" | "complete" | "outside_coverage" | "budget_exhausted" = this.outsideCoverage ? "outside_coverage" : this.exhausted ? "budget_exhausted" : this.complete ? "complete" : "partial";
    const notice = state === "outside_coverage" ? "The requested interval is outside this snapshot's coverage; no absence can be inferred."
      : state === "budget_exhausted" ? "Research budget exhausted; results are partial and do not verify absence."
      : this.stale ? "Snapshot freshness is unknown or older than two hours; this does not describe sync health or verify absence."
      : this.absenceVerified ? "The full requested interval was enumerated in this snapshot with no matching messages."
      : this.complete ? "The full requested interval was enumerated in this snapshot."
      : "Research is partial or sampled; missing results do not verify absence.";
    return { backend: this.info.backend, snapshot: this.info.snapshot, coverageStart: this.info.coverageStart, coverageEnd: this.info.coverageEnd, updatedAt: this.info.updatedAt, latestMessageAt: this.info.latestMessageAt, messageCount: this.info.messageCount, complete: this.complete, absenceVerified: this.absenceVerified, stale: this.stale, hasMore: this.hasMore, calls: this.calls, reviewed: this.reviewed, exhausted: this.exhausted, state, notice };
  }
  context(): string { return JSON.stringify({ summary: this.summary(), documents: this.documents }); }

  async initial(query: string): Promise<void> {
    if (this.started) badArguments();
    this.started = true;
    if (this.outsideCoverage) return;
    this.initializing = true;
    try {
      if (this.scope.messageId) await this.call("get_message", { message_id: this.scope.messageId });
      else if (!this.scope.list) await this.call("search_messages", { query });
      else {
        let cursor: string | undefined;
        do {
          const result = await this.call("list_messages", { ...(cursor ? { cursor } : {}) }) as Page;
          cursor = result.nextCursor ?? undefined;
        } while (cursor);
      }
    } catch (error) {
      if (!(error instanceof ResearchBudgetError)) throw error;
    } finally { this.initializing = false; }
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.broken) throw new Error("Research tool failed");
    if (!Object.hasOwn(toolSchemas, name) || name === "corpus_info" || !object(args) || this.pending) badArguments();
    const allowed = name === "search_messages" ? ["query", "limit"] : name === "list_messages" ? ["cursor", "limit"] : name === "get_message" ? ["message_id"] : ["message_id", "cursor", "limit"];
    if (Object.keys(args).some(key => !allowed.includes(key))) badArguments();
    if (name === "search_messages" && (!boundedString(args.query, 1200) || !args.query.trim())) badArguments();
    if (name === "get_message" || name === "get_thread") {
      if (!numeric(args.message_id) || (!this.seen.has(args.message_id) && args.message_id !== this.scope.messageId)) badArguments();
    }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20)) badArguments();
    if (args.cursor !== undefined && !boundedString(args.cursor, 4096)) badArguments();
    const chainKey = name === "get_thread" ? `${name}:${args.message_id}` : name;
    const previous = this.chains.get(chainKey);
    if (args.cursor !== undefined && (!previous || previous.next !== args.cursor || previous.finished)) badArguments();
    // A list is one immutable chain from its first page, never a model-selected cursor.
    if (name === "list_messages" && previous && args.cursor === undefined) badArguments();
    const requested = name === "get_message" ? 1 : Number(args.limit ?? (name === "search_messages" ? 10 : 20));
    const remaining = researchLimits.results - this.reviewed;
    this.checkBudget();
    if (this.outsideCoverage) badArguments();
    const limit = Math.min(requested, remaining);
    const parameters: Record<string, unknown> = { ...args, ...(name === "get_message" ? {} : { limit }) };
    for (const key of ["since", "until", "channel", "author"] as const) if (this.scope[key] !== undefined) parameters[key] = this.scope[key];
    this.pending = true;
    try {
      const result = parsePage(await invoke(this.client, name, parameters, this.signal, this.budget), this.info, this.scope, limit);
      if (name === "get_message" && (result.nextCursor !== null || result.messages.some(message => message.messageId !== args.message_id))) invalid();
      this.budget.reviewed += result.messages.length;
      const chain = args.cursor === undefined ? { next: null, cursors: new Set<string>(), finished: false } : previous!;
      if (result.nextCursor && (chain.cursors.has(result.nextCursor) || result.nextCursor === args.cursor)) invalid();
      if (name === "list_messages") {
        // Chronological order is part of the contract; equal IDs may be duplicated but still count.
        let last = chain.last;
        for (const item of result.messages) {
          if (last && (micros(item.timestamp) < micros(last.timestamp) || (micros(item.timestamp) === micros(last.timestamp) && item.messageId < last.messageId))) invalid();
          last = item;
        }
        chain.last = last;
        this.listFinished = result.nextCursor === null && result.exhaustive;
      }
      if (result.nextCursor) chain.cursors.add(result.nextCursor);
      chain.next = result.nextCursor; chain.finished = result.nextCursor === null;
      this.chains.set(chainKey, chain);
      this.hasMore = [...this.chains.values()].some(chain => chain.next !== null);
      for (const item of result.messages) this.seen.add(item.messageId);
      this.retain(result.messages);
      if (this.reviewed >= researchLimits.results || this.calls >= researchLimits.calls) this.exhausted = !this.complete || this.hasMore;
      return { version: 1, snapshot: result.snapshot, messages: result.messages.map(message => ({ ...message, text: message.text.slice(0, 400) })), nextCursor: result.nextCursor, exhaustive: name === "search_messages" ? false : result.exhaustive };
    } catch (error) {
      this.broken = this.callerSignal.aborted;
      this.callerSignal.throwIfAborted();
      if (error instanceof ResearchBudgetError || this.signal.aborted || Date.now() >= this.budget.deadline) { this.exhausted = true; throw new ResearchBudgetError(); }
      this.broken = true;
      throw new Error("Research tool failed");
    } finally { this.pending = false; }
  }

  private checkBudget() {
    this.callerSignal.throwIfAborted();
    if (this.exhausted || this.calls >= researchLimits.calls || this.reviewed >= researchLimits.results || this.signal.aborted || Date.now() >= this.budget.deadline) {
      this.exhausted = true; throw new ResearchBudgetError();
    }
  }
  private retain(messages: Message[]) {
    const candidates = this.initializing ? [...this.evidence, ...messages] : [...messages, ...this.evidence];
    const seen = new Set<string>();
    const evidence: Message[] = [], documents: RetrievedDocument[] = [];
    let remaining = 16_000;
    for (const message of candidates) {
      if (seen.has(message.messageId)) continue;
      if (documents.length >= 5 || remaining <= 0) break;
      seen.add(message.messageId);
      const text = `Author: ${message.author} (${message.authorId}) | Timestamp: ${message.timestamp} | Channel: ${message.channel} (${message.channelId}) | Message: ${message.messageId}\n${message.text}`.slice(0, Math.min(4000, remaining));
      documents.push({ id: String(documents.length + 1), title: `${message.author} · #${message.channel}`.slice(0, 180), text, url: message.url, date: message.timestamp.slice(0, 10), timestamp: message.timestamp, messageId: message.messageId, channel: message.channel, author: message.author });
      evidence.push(message); remaining -= text.length;
    }
    this.evidence = evidence; this.documents = documents;
  }
}

export async function withResearch<T>(config: ResearchConfig, scope: TemporalScope, signal: AbortSignal, run: (session: ResearchSession) => Promise<T>): Promise<T> {
  const frozenScope = Object.freeze({ ...scope });
  if (!iso(scope.now) || (scope.since !== undefined && !iso(scope.since)) || (scope.until !== undefined && !iso(scope.until)) || (scope.since && scope.until && Date.parse(scope.since) >= Date.parse(scope.until)) || (scope.messageId !== undefined && !numeric(scope.messageId)) || scope.ambiguous) badArguments();
  for (const filter of [scope.channel, scope.author]) if (filter !== undefined && (!boundedString(filter, 180) || !filter.trim() || /\p{Cc}/u.test(filter))) badArguments();
  const timerController = new AbortController();
  const timer = setTimeout(() => timerController.abort(new ResearchBudgetError()), researchLimits.milliseconds);
  const toolSignal = AbortSignal.any([signal, timerController.signal]);
  const budget = { calls: 0, reviewed: 0, deadline: Date.now() + researchLimits.milliseconds };
  let pinned = false;
  const attempt = async (url: string, primary: boolean): Promise<T> => {
    const connection = new AbortController();
    const connectionTimer = primary ? setTimeout(() => connection.abort(new Error("Research primary timed out")), 15_000) : undefined;
    const attemptSignal = AbortSignal.any([toolSignal, connection.signal]);
    try {
      return await withRagClient({ url, token: config.ragToken, tool: "corpus_info" }, attemptSignal, async client => {
        const catalog = await client.listTools({}, { signal: attemptSignal, timeout: Math.min(10_000, Math.max(1, budget.deadline - Date.now())) });
        validateCatalog(catalog.tools);
        const info = parseInfo(await invoke(client, "corpus_info", {}, attemptSignal, budget));
        pinned = true;
        clearTimeout(connectionTimer);
        if (!info.capabilities.structured) throw new ResearchUnsupportedError();
        if (!primary && config.ragPrimaryUrl && config.ragPrimaryUrl !== config.ragUrl && info.backend !== "cpu") throw new ResearchUnsupportedError();
        return run(new ResearchSession(info, frozenScope, client, attemptSignal, signal, budget));
      });
    } finally { clearTimeout(connectionTimer); }
  };
  try {
    if (config.ragPrimaryUrl && config.ragPrimaryUrl !== config.ragUrl) {
      try { return await attempt(config.ragPrimaryUrl, true); }
      catch (error) {
        signal.throwIfAborted();
        if (pinned || toolSignal.aborted || budget.calls >= researchLimits.calls) throw error;
      }
    }
    try { return await attempt(config.ragUrl, false); }
    catch (error) {
      signal.throwIfAborted();
      if (pinned || error instanceof ResearchUnsupportedError || error instanceof ResearchBudgetError) throw error;
      if (toolSignal.aborted) throw new ResearchBudgetError();
      throw new Error("Research unavailable");
    }
  } finally { clearTimeout(timer); }
}
