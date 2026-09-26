"use client";

import { PreviewMessage, ThinkingMessage } from "@/components/message";
import { MultimodalInput } from "@/components/multimodal-input";
import { Overview } from "@/components/overview";
import { ConversationSidebar } from "@/components/conversation-sidebar";
import { useScroll } from "@/hooks/use-scroll-to-bottom";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useConversations } from "@/hooks/use-conversations";
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai'
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelLeftOpen, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { deriveTitle, loadMessages, saveMessages } from "@/lib/conversations";
import { GroundingsDisplay } from "./groundings-display";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { MyUIMessage } from "@/lib/types";
import { routes } from "@/lib/routes";
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch";

export function Chat({ defaultAgenticSearchEnabled }: { defaultAgenticSearchEnabled: boolean }) {
  const chatId = "001";
  const {
    conversations,
    activeId,
    activeConversation,
    isLoaded: conversationsLoaded,
    createConversation,
    selectConversation,
    deleteConversation,
    touchConversation,
  } = useConversations();
  // The conversation id doubles as the backend session id, so a resumed
  // conversation continues the same server-side trace.
  const sessionId = activeId ?? "pending";

  const [input, setInput] = useState('');
  const [maxSteps, setMaxSteps] = useState(5);
  const [agenticSearchEnabled, setAgenticSearchEnabled] = useState(defaultAgenticSearchEnabled);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Collapse the history sidebar on small screens (and keep it in sync on
  // rotation/resize). A mount effect keeps the first client render identical
  // to the server render; state updates happen only in the media-query
  // subscription callback, never synchronously in the effect body.
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)');
    const syncFromViewport = () => {
      if (!mql.matches) setSidebarOpen(false);
    };
    syncFromViewport();
    mql.addEventListener('change', syncFromViewport);
    return () => mql.removeEventListener('change', syncFromViewport);
  }, []);
  const { isDevMode } = useDevMode();

  const messageRefs = useRef<Map<string, HTMLElement>>(new Map());
  const hydratedConversation = useRef<string | null>(null);
  // Message count at hydration time. The thread only counts as edited when it
  // grows past this (user submitted a new message) — merely opening it must
  // not reorder the list.
  const baselineCount = useRef(0);
  // Set in the commit where hydration swaps conversations: messages in that
  // commit still belongs to the previous conversation, so skip persisting it.
  const skipPersist = useRef(false);

  const handleSubmit = (e?: { preventDefault?: (() => void) }): void => {
    if (e && e.preventDefault) {
      e.preventDefault();
    }
    if (!activeId || input.trim().length === 0) return;
    sendMessage(
      { text: input },
      { body: { maxSteps, sessionId, agenticSearchEnabled } },
    );
    setInput('');

  };

  const {
    messages,
    setMessages,
    sendMessage,
    addToolResult,
    status,
    stop
  } = useChat<MyUIMessage>({
    transport: new DefaultChatTransport({ api: routes.apiChat }),
    throttle: 50,
    // Resumes the agent after the user answers an ask_question tool call.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onError: (error) => {
      if (error.message.includes("Too many requests")) {
        toast.error(
          "You are sending too many messages. Please try again later.",
        );
      } else {
        toast.error(`Error: ${error.message}`);
      }
    },
  });

  const isBusy = status === "submitted" || status === "streaming";

  // Load the active conversation's messages from the browser store on switch.
  useEffect(() => {
    if (!conversationsLoaded || !activeId) return;
    if (hydratedConversation.current === activeId) return;
    const isFirstHydration = hydratedConversation.current === null;
    hydratedConversation.current = activeId;
    messageRefs.current.clear();
    // The input draft is owned by MultimodalInput (per-conversation key);
    // clearing here would wipe the restored draft (parent effects run last).
    const stored = loadMessages(activeId);
    baselineCount.current = stored.length;
    // Keep in-flight messages only on the first hydration after mount; later
    // switches always load the selected conversation, even when empty.
    if (!isFirstHydration || stored.length > 0 || messages.length === 0) {
      setMessages(stored);
    }
    // messages in this commit still belongs to the previous conversation.
    skipPersist.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationsLoaded, activeId, setMessages]);

  // Persist messages to the browser store; refresh title/recency only when
  // the thread actually grew (a new message was submitted in it).
  useEffect(() => {
    if (!conversationsLoaded || !activeId) return;
    if (hydratedConversation.current !== activeId) return;
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    saveMessages(activeId, messages);
    if (messages.length > baselineCount.current) {
      baselineCount.current = messages.length;
      touchConversation(activeId, deriveTitle(messages));
    }
  }, [messages, activeId, conversationsLoaded, touchConversation]);

  const handleNewConversation = () => {
    if (isBusy) stop();
    messageRefs.current.clear();
    setInput("");
    setMessages([]);
    createConversation();
  };

  const handleSelectConversation = (id: string) => {
    if (id === activeId) return;
    if (isBusy) stop();
    selectConversation(id);
  };

  const handleDeleteConversation = (id: string) => {
    if (isBusy && id === activeId) stop();
    deleteConversation(id);
  };

  const [messagesContainerRef, scrollToElement] =
    useScroll<HTMLDivElement>();

  const lastMessage = messages[messages.length - 1];
  const lastAssistantMessage = lastMessage?.role === "assistant" ? lastMessage : undefined;
  const lastAssistantHasVisibleContent = lastAssistantMessage?.parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return part.text.trim().length > 0;
    }

    return part.type === "tool-search_clic" ||
      part.type === "tool-search_judgments" ||
      part.type === "tool-search_legislation" ||
      part.type === "tool-get_ordinance_section" ||
      part.type === "tool-get_case" ||
      part.type === "tool-full_search" ||
      part.type === "tool-ask_question";
  }) ?? false;

  useEffect(() => {
    if (messages.length === 0) return;

    // console.log(messages)

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role === "user") {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.style.paddingBottom = "82%";
      }

      const element = messageRefs.current.get(lastMessage.id);
      if (element) {
        scrollToElement(element);
      }
    }
  }, [messages, scrollToElement, messagesContainerRef]);

  return (
    <div className="flex h-[calc(100dvh-52px)] max-h-[calc(100dvh-52px)] w-full">

      {/* History sidebar (desktop) */}
      {sidebarOpen && (
        <div className="hidden h-full md:block">
          <ConversationSidebar
            conversations={conversations}
            activeId={activeId}
            onSelect={handleSelectConversation}
            onNew={handleNewConversation}
            onDelete={handleDeleteConversation}
            onCollapse={() => setSidebarOpen(false)}
            disabled={isBusy}
          />
        </div>
      )}

      {/* History sidebar (mobile overlay) */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 h-full">
            <ConversationSidebar
              conversations={conversations}
              activeId={activeId}
              onSelect={(id) => {
                handleSelectConversation(id);
                setSidebarOpen(false);
              }}
              onNew={() => {
                handleNewConversation();
                setSidebarOpen(false);
              }}
              onDelete={handleDeleteConversation}
              onCollapse={() => setSidebarOpen(false)}
              disabled={isBusy}
            />
          </div>
        </div>
      )}

      {/* Centers the dev panel + chat column in the space beside the sidebar. */}
      <div className="flex min-w-0 flex-1 justify-center overflow-hidden">
      {isDevMode && (
        <div className="col-span-1 p-4 border-r border-border overflow-y-auto h-full min-w-2xs flex-1/2 max-w-[50rem]">

          <div className="mb-4">
            <h3 className="font-semibold mb-2">Settings</h3>
            <div className="mb-3 ml-2 flex items-center justify-between gap-4">
              <label className="text-xs" htmlFor="agentic-search-enabled">
                Agentic search
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {agenticSearchEnabled ? "Enabled" : "Disabled"}
                </span>
                <Switch
                  id="agentic-search-enabled"
                  checked={agenticSearchEnabled}
                  onCheckedChange={setAgenticSearchEnabled}
                />
              </div>
            </div>
            <div className="flex gap-2 items-center ml-2">
              <span className="text-xs">Max Steps: </span>
              <Slider
                className="max-w-64"
                value={[maxSteps]}
                max={8}
                min={1}
                step={1}
                onValueChange={(value) => {
                  setMaxSteps(value[0] ?? 5);
                }}
              />
              <span className="text-xs">{maxSteps}</span>
            </div>
          </div>

          {messages[messages.length - 1]?.metadata?.searchMode && status !== "submitted" && (
            <div className="mb-4">
              <h3 className="font-semibold mb-2">Agent Run</h3>
              <div className="text-xs text-muted-foreground">
                {messages[messages.length - 1]?.metadata?.searchMode === "agent" ? "Agentic search" : "Legacy fan-out"} ·{" "}
                {messages[messages.length - 1]?.metadata?.stepCount ?? 0} steps ·{" "}
                {messages[messages.length - 1]?.metadata?.toolCallCount ?? 0} tools
              </div>
            </div>
          )}

          {(messages[messages.length - 1]?.metadata?.searchQuery || messages[messages.length - 1]?.metadata?.searchQueries) && status !== "submitted" && (
            <div className="mb-4">
              <h3 className="font-semibold mb-2">Search Query</h3>
              <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-x-auto">{messages[messages.length - 1]?.metadata?.searchQuery}</pre>
            </div>
          )}

          {status !== "submitted" && (
            <div>
              <h3 className="font-semibold mb-2">Groundings</h3>
              <GroundingsDisplay groundings={messages[messages.length - 1]?.parts.filter((part) => part.type === "source-url")} />
            </div>
          )}
        </div>
      )}


      <div className={cn("flex flex-col min-w-0 bg-background w-full h-full overflow-hidden", "max-w-3xl")}>
        <div className="flex items-center gap-1 px-3 pt-2">
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setSidebarOpen(true)}
              aria-label="Show conversation history"
            >
              <PanelLeftOpen size={17} />
            </Button>
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {activeConversation?.title ?? "New conversation"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleNewConversation}
            disabled={isBusy}
            aria-label="Start a new conversation"
          >
            <Plus size={17} />
          </Button>
        </div>
        <ScrollArea
          viewportRef={messagesContainerRef}
          className="min-w-0 min-h-0 flex-1"
        >
          <div className="flex min-w-0 flex-col gap-6 pt-4 pb-36">
            {messages.length === 0 && <Overview />}

            {messages.map((message) => (
              <PreviewMessage
                key={message.id}
                message={message}
                onAnswerQuestion={(toolCallId, output) =>
                  addToolResult({
                    tool: "ask_question",
                    toolCallId,
                    output,
                    // The auto-resubmit must carry the same request settings,
                    // or the route falls back to defaults and can switch mode mid-run.
                    options: { body: { maxSteps, sessionId, agenticSearchEnabled } },
                  })
                }
                // groundings={messages[messages.length - 1]?.metadata?.groundings}
                ref={(node: HTMLElement | null) => {
                  if (node) {
                    messageRefs.current.set(message.id, node);
                  } else {
                    messageRefs.current.delete(message.id);
                  }
                }}
              />
            ))}

            {(status === "submitted" || (status === "streaming" &&
              lastAssistantMessage &&
              !lastAssistantHasVisibleContent)) && (
              <ThinkingMessage query={lastMessage?.metadata?.searchQuery} />
            )}
          </div>
        </ScrollArea>

        <form className="flex mx-auto px-4 bg-background pb-4 md:pb-6 gap-2 w-full max-w-3xl">
          <MultimodalInput
            chatId={chatId}
            draftId={activeId ?? undefined}
            input={input}
            setInput={setInput}
            handleSubmit={handleSubmit}
            isLoading={isBusy}
            stop={stop}
            messages={messages}
            setMessages={setMessages}
            sendMessage={(message) => {
              // Suggested actions render before the store hydrates; never
              // send with the placeholder session id.
              if (!activeId) return;
              sendMessage(
                { text: message },
                { body: { maxSteps, sessionId, agenticSearchEnabled } },
              );
            }}
          />
        </form>
      </div>
      </div>

    </div>
  );
}
