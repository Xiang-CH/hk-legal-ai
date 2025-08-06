"use client";

import { PreviewMessage, ThinkingMessage } from "@/components/message";
import { MultimodalInput } from "@/components/multimodal-input";
import { Overview } from "@/components/overview";
import { useScroll } from "@/hooks/use-scroll-to-bottom";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useChat } from '@ai-sdk/react'
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GroundingsDisplay } from "./groundings-display";
import { MyUIMessage } from "@/lib/types";

export function Chat() {
  const chatId = "001";

  const [input, setInput] = useState('');
  const { isDevMode } = useDevMode();

  const messageRefs = useRef<Map<string, HTMLElement>>(new Map());

  const handleSubmit = (e?: { preventDefault?: (() => void) }): void => {
    if (e && e.preventDefault) {
      e.preventDefault();
    }
    sendMessage({ text: input });
    setInput('');

  };

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
  } = useChat<MyUIMessage>({
    onError: (error) => {
      if (error.message.includes("Too many requests")) {
        toast.error(
          "You are sending too many messages. Please try again later.",
        );
      }
    },
  });

  const [messagesContainerRef, scrollToElement] =
    useScroll<HTMLDivElement>();

  useEffect(() => {
    if (messages.length === 0) return;

    console.log(messages)

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role === "user") {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.style.paddingBottom = "86%";
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
          {(messages[messages.length - 1]?.metadata?.searchQuery || messages[messages.length - 1]?.metadata?.searchQueries) && status !== "submitted" && (
            <div className="mb-4">
              <h3 className="font-semibold mb-2">Search Query</h3>
              <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-x-auto">{messages[messages.length - 1]?.metadata?.searchQuery}</pre>
            </div>
          )}
          {isDevMode && status !== "submitted" && (
            <div>
              <h3 className="font-semibold mb-2">Groundings</h3>
              <GroundingsDisplay groundings={messages[messages.length - 1]?.parts.filter((part) => part.type === "source-url")} />
            </div>
          )}
        </div>
      )}


      <div className={cn("flex flex-col min-w-0 bg-background scrollbar w-full h-full overflow-y-auto", "max-w-3xl")}>
        <div
          ref={messagesContainerRef}
          className="flex flex-col min-w-0 gap-6 flex-1 overflow-y-scroll pt-4 pb-36"
        >
          {messages.length === 0 && <Overview />}

          {messages.map((message) => (
            <PreviewMessage
              key={message.id}
              message={message}
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

          {status === "submitted" || (status === "streaming" &&
            messages.length > 0 && messages[messages.length - 1].role === "assistant" &&
            (messages[messages.length - 1].parts.filter((part) => part.type === "text").join("").length < 1)) && <ThinkingMessage query={messages[messages.length - 1]?.metadata?.searchQuery} />}


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
            sendMessage={(message) => sendMessage({ text: message })}
          />
        </form>
      </div>

    </div>
  );
}
