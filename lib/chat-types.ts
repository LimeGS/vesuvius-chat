export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatSource = { id: string; title: string; url?: string; date?: string; timestamp?: string; messageId?: string; channel?: string; author?: string };
export type ChatStatus = {
  mode: "demo" | "live";
  /** Configuration indicator, not a health check. */
  rag: boolean;
};
export type ChatResearch = {
  now: string; timeZone: string; timezoneFallback: boolean; notice: string;
  since?: string; until?: string; channel?: string; author?: string;
  backend?: string; snapshot?: string; coverageStart?: string | null; coverageEnd?: string | null;
  updatedAt?: string | null; latestMessageAt?: string | null; messageCount?: number | null;
  state?: "partial" | "complete" | "outside_coverage" | "budget_exhausted" | "unsupported" | "clarification";
  complete?: boolean; absenceVerified?: boolean; stale?: boolean; hasMore?: boolean;
  calls?: number; reviewed?: number; modelCalls?: number;
};
export type ChatResponse = ChatStatus & { message: string; sources: ChatSource[]; truncated?: boolean; research?: ChatResearch };
