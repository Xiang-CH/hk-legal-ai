import type { MyUIMessage } from "./types";

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

const LIST_KEY = "clic-chat:conversations:v1";
const ACTIVE_KEY = "clic-chat:active-id:v1";
export const MAX_CONVERSATIONS = 50;
const TITLE_MAX_LENGTH = 30;

const msgKey = (id: string) => `clic-chat:messages:${id}:v1`;

function isBrowser(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function safeGet(key: string): string | null {
  if (!isBrowser()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function newConversationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Sorted newest-first. Returns [] outside the browser. */
export function loadConversationList(): ConversationMeta[] {
  if (!isBrowser()) return [];
  const list = safeParse<ConversationMeta[]>(safeGet(LIST_KEY), []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && typeof c.id === "string")
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function saveConversationList(list: ConversationMeta[]): void {
  if (!isBrowser()) return;
  // Drop message/draft keys of conversations that fall beyond the cap so
  // repeated creation cannot leak stale keys into the store.
  for (const dropped of list.slice(MAX_CONVERSATIONS)) {
    deleteStoredMessages(dropped.id);
  }
  try {
    window.localStorage.setItem(LIST_KEY, JSON.stringify(list.slice(0, MAX_CONVERSATIONS)));
  } catch {
    // Quota exceeded or unavailable — chat still works in memory.
  }
}

export function loadActiveId(): string | null {
  if (!isBrowser()) return null;
  const id = safeGet(ACTIVE_KEY);
  return id && id.length > 0 ? id : null;
}

export function saveActiveId(id: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // ignore
  }
}

export function loadMessages(id: string): MyUIMessage[] {
  if (!isBrowser()) return [];
  const list = safeParse<MyUIMessage[]>(safeGet(msgKey(id)), []);
  return Array.isArray(list) ? list : [];
}

export function saveMessages(id: string, messages: MyUIMessage[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(msgKey(id), JSON.stringify(messages));
  } catch {
    // Quota exceeded — keep the session in memory.
  }
}

export function deleteStoredMessages(id: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(msgKey(id));
    window.localStorage.removeItem(`clic-chat:draft:${id}`);
  } catch {
    // ignore
  }
}

/** Derive a title from the first user message, if any. */
export function deriveTitle(messages: MyUIMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text.trim())
      .join(" ")
      .trim();
    if (text.length > 0) {
      return text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH - 1)}…` : text;
    }
  }
  return null;
}

export const NEW_CONVERSATION_TITLE = "New conversation";
