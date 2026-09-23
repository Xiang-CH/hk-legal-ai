"use client";

import { useCallback, useEffect, useState } from "react";
import {
  NEW_CONVERSATION_TITLE,
  deleteStoredMessages,
  loadActiveId,
  loadConversationList,
  newConversationId,
  saveActiveId,
  saveConversationList,
  type ConversationMeta,
} from "@/lib/conversations";

export function useConversations() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Hydrate from browser local store once (client-only). This must run in an
  // effect so the first client render matches the server render.
  /* eslint-disable react-hooks/set-state-in-effect -- client-only hydration */
  useEffect(() => {
    const list = loadConversationList();
    if (list.length === 0) {
      const id = newConversationId();
      const now = Date.now();
      const initial: ConversationMeta = {
        id,
        title: NEW_CONVERSATION_TITLE,
        createdAt: now,
        updatedAt: now,
      };
      setConversations([initial]);
      setActiveId(id);
      saveConversationList([initial]);
      saveActiveId(id);
    } else {
      setConversations(list);
      const stored = loadActiveId();
      const valid = stored && list.some((c) => c.id === stored) ? stored : list[0]!.id;
      setActiveId(valid);
      saveActiveId(valid);
    }
    setIsLoaded(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const createConversation = useCallback(() => {
    const id = newConversationId();
    const now = Date.now();
    const meta: ConversationMeta = {
      id,
      title: NEW_CONVERSATION_TITLE,
      createdAt: now,
      updatedAt: now,
    };
    setConversations((prev) => {
      const next = [meta, ...prev];
      saveConversationList(next);
      return next;
    });
    setActiveId(id);
    saveActiveId(id);
    return id;
  }, []);

  const selectConversation = useCallback((id: string) => {
    setActiveId(id);
    saveActiveId(id);
  }, []);

  const deleteConversation = useCallback(
    (id: string) => {
      deleteStoredMessages(id);
      const next = conversations.filter((c) => c.id !== id);
      if (next.length === 0) {
        const freshId = newConversationId();
        const now = Date.now();
        const fresh: ConversationMeta = {
          id: freshId,
          title: NEW_CONVERSATION_TITLE,
          createdAt: now,
          updatedAt: now,
        };
        setConversations([fresh]);
        setActiveId(freshId);
        saveConversationList([fresh]);
        saveActiveId(freshId);
        return;
      }
      setConversations(next);
      saveConversationList(next);
      if (activeId === id) {
        const fallback = next[0]!.id;
        setActiveId(fallback);
        saveActiveId(fallback);
      }
    },
    [conversations, activeId],
  );

  /** Bump updatedAt and optionally refresh an untitled conversation's title. */
  const touchConversation = useCallback((id: string, title: string | null) => {
    setConversations((prev) => {
      let changed = false;
      const next = prev.map((c) => {
        if (c.id !== id) return c;
        const nextTitle = title && c.title === NEW_CONVERSATION_TITLE ? title : c.title;
        if (nextTitle === c.title) {
          // Still refresh recency, but skip the write if nothing changed.
          if (Date.now() - c.updatedAt < 1000) return c;
        }
        changed = true;
        return { ...c, title: nextTitle, updatedAt: Date.now() };
      });
      if (changed) {
        const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
        saveConversationList(sorted);
        return sorted;
      }
      return prev;
    });
  }, []);

  return {
    conversations,
    activeId,
    activeConversation: conversations.find((c) => c.id === activeId) ?? null,
    isLoaded,
    createConversation,
    selectConversation,
    deleteConversation,
    touchConversation,
  };
}
