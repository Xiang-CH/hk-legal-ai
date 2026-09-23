"use client";

import { PreviewMessage, ThinkingMessage } from "@/components/message";
import { MultimodalInput } from "@/components/multimodal-input";
import { Overview } from "@/components/overview";
import { useScroll } from "@/hooks/use-scroll-to-bottom";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useChat } from '@ai-sdk/react'
import { lastAssistantMessageIsCompleteWithToolCalls } from 'ai'
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GroundingsDisplay } from "./groundings-display";
import { MyUIMessage } from "@/lib/types";
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch";

export function Chat({ defaultAgenticSearchEnabled }: { defaultAgenticSearchEnabled: boolean }) {
  const chatId = "001";
  const [sessionId] = useState(() => crypto.randomUUID());

  const [input, setInput] = useState('');
  const [maxSteps, setMaxSteps] = useState(5);
  const [agenticSearchEnabled, setAgenticSearchEnabled] = useState(defaultAgenticSearchEnabled);
  const { isDevMode } = useDevMode();

  const messageRefs = useRef<Map<string, HTMLElement>>(new Map());

  const handleSubmit = (e?: { preventDefault?: (() => void) }): void => {
    if (e && e.preventDefault) {
      e.preventDefault();
    }
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
    <div className={cn("flex h-[calc(100dvh-52px)] max-h-[calc(100dvh-52px)]", "justify-center")}>

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


      <div className={cn("flex flex-col min-w-0 bg-background w-full h-full overflow-y-auto", "max-w-3xl")}>
        <div
          ref={messagesContainerRef}
          className="flex flex-col min-w-0 gap-6 flex-1 overflow-y-auto pt-4 pb-36"
        >
          {messages.length === 0 && <Overview />}

          {messages.map((message) => (
            <PreviewMessage
              key={message.id}
              message={message}
              onAnswerQuestion={(toolCallId, output) =>
                addToolResult({ tool: "ask_question", toolCallId, output })
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

        <form className="flex mx-auto px-4 bg-background pb-4 md:pb-6 gap-2 w-full max-w-3xl">
          <MultimodalInput
            chatId={chatId}
            input={input}
            setInput={setInput}
            handleSubmit={handleSubmit}
            isLoading={(status === "submitted" || status === "streaming")}
            stop={stop}
            messages={messages}
            setMessages={setMessages}
            sendMessage={(message) =>
              sendMessage(
                { text: message },
                { body: { maxSteps, sessionId, agenticSearchEnabled } },
              )
            }
          />
        </form>
      </div>

    </div>
  );
}
