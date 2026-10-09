"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  MAX_CONVERSATIONS,
  NEW_CONVERSATION_TITLE,
  deleteStoredMessages,
  loadConversationList,
  newConversationId,
  saveConversationList,
  type ConversationMeta,
} from "@/lib/conversations";

function updateSessionUrl(id: string, replace = false) {
  const url = new URL(window.location.href);
  url.searchParams.set("sessionId", id);
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

export function useConversations() {
  const requestedId = useSearchParams().get("sessionId");
  const hydratedRequest = useRef<string | null | undefined>(undefined);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // The URL owns selection, including browser Back/Forward. A bare or unknown
  // session URL starts a new chat instead of resuming the last browser session.
  /* eslint-disable react-hooks/set-state-in-effect -- client-only hydration */
  useEffect(() => {
    if (hydratedRequest.current === requestedId) return;
    hydratedRequest.current = requestedId;
    const list = loadConversationList();
    if (!requestedId || !list.some((c) => c.id === requestedId)) {
      const id = newConversationId();
      const now = Date.now();
      const initial: ConversationMeta = {
        id,
        title: NEW_CONVERSATION_TITLE,
        createdAt: now,
        updatedAt: now,
      };
      const next = [initial, ...list];
      setConversations(next.slice(0, MAX_CONVERSATIONS));
      setActiveId(id);
      saveConversationList(next);
      hydratedRequest.current = id;
      updateSessionUrl(id, true);
    } else {
      setConversations(list);
      setActiveId(requestedId);
    }
    setIsLoaded(true);
  }, [requestedId]);
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
    const next = [meta, ...conversations];
    saveConversationList(next);
    setConversations(next.slice(0, MAX_CONVERSATIONS));
    setActiveId(id);
    hydratedRequest.current = id;
    updateSessionUrl(id);
    return id;
  }, [conversations]);

  const selectConversation = useCallback((id: string) => {
    if (id === activeId || !conversations.some((c) => c.id === id)) return;
    setActiveId(id);
    hydratedRequest.current = id;
    updateSessionUrl(id);
  }, [activeId, conversations]);

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
        hydratedRequest.current = freshId;
        updateSessionUrl(freshId, true);
        return;
      }
      setConversations(next);
      saveConversationList(next);
      if (activeId === id) {
        const fallback = next[0];
        if (fallback) {
          setActiveId(fallback.id);
          hydratedRequest.current = fallback.id;
          updateSessionUrl(fallback.id, true);
        }
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
