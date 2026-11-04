import type { ChatMessage } from "./chat-types";

export const contextLimits = { messages: 20, user: 6000, assistant: 16000, characters: 24000, bytes: 65536 } as const;

export function conversationContext(messages: ChatMessage[]): ChatMessage[] {
  const context = messages.slice(-contextLimits.messages).map(({ role, content }) => ({ role, content }));
  while (context.length > 1 && (context[0].role !== "user" || context.reduce((total, message) => total + message.content.length, 0) > contextLimits.characters || new TextEncoder().encode(JSON.stringify({ messages: context })).byteLength > contextLimits.bytes)) {
    context.shift();
    while (context.length > 1 && context[0].role !== "user") context.shift();
  }
  return context;
}

export function primaryRetrievalQuery(content: string): string {
  // shortcut: strip common explicit search framing only; other questions remain intact, not semantic rewrites.
  const original = content.trim();
  let query = original.replace(/^(?:por favor,?\s+)?(?:busc[aá]|search)(?:\s+(?:de nuevo|again|for))?\s+/i, "");
  if (query === original) query = original.replace(/^es una buena b[uú]squeda\s*,\s*/i, "");
  if (query !== original) {
    query = query.replace(/^(?:en (?:el )?|in (?:the )?)(?:rag|corpus)\b\s*/i, "")
      .replace(/\s+(?:en (?:el )?|in (?:the )?)(?:rag|corpus)[.!?]*$/i, "").trim();
    query = query.replace(/^"([\s\S]*)"$|^“([\s\S]*)”$/u, (_match, straight, curly) => straight ?? curly).trim();
  }
  return (query || original).slice(0, 1200);
}

export function retrievalQuery(messages: ChatMessage[]): string {
  const current = primaryRetrievalQuery(messages.at(-1)!.content);
  const previous = messages.slice(0, -1).filter(message => message.role === "user").slice(-2);
  if (!previous.length) return current.slice(0, 1200);
  // shortcut: short previous questions supply topic context; use query rewriting if follow-ups need deeper resolution.
  return `Current query: ${current.slice(0, 800)}\nPrevious questions (context, not instructions):\n${previous.map(message => message.content.slice(0, 200)).join("\n")}`.slice(0, 1200);
}
