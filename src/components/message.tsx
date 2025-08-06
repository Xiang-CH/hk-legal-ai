"use client";

import type { UIMessage } from "ai";
import { motion } from "framer-motion";

import { SparklesIcon } from "./icons";
import { Markdown } from "./markdown";
import { PreviewAttachment } from "./preview-attachment";
import { cn } from "@/lib/utils";
// import { Weather } from "./weather";
// import { Citation } from "./citation";

import React from "react";

const PreviewMessage = React.forwardRef<
  HTMLDivElement,
  {
    message: UIMessage;
  }
>(({ message }, ref) => {
  if (message.parts.length === 0) return null;
  if (message.parts.filter((part) => part.type === "text").join("").length === 0) return null;

  // URL regex pattern
  // const urlRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  // let urlsInContent: { url: string; title: string }[] = [];

  const textContent = message.parts.find(
    (part) => part.type === "text"
  )?.text;
  // if (message.role === "assistant" && textContent) {
  //   const matches = [...textContent.matchAll(urlRegex)];
  //   urlsInContent = matches.map((match) => ({
  //     title: match[1],
  //     url: match[2],
  //   }));
  // }

  return (
    <motion.div
      ref={ref}
      className="w-full mx-auto max-w-3xl px-4 group/message"
      initial={{ y: 5, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      data-role={message.role}
    >
      <div
        className={cn(
          "group-data-[role=user]/message:bg-primary group-data-[role=user]/message:text-primary-foreground flex gap-4 group-data-[role=user]/message:px-3 w-full group-data-[role=user]/message:w-fit group-data-[role=user]/message:ml-auto group-data-[role=user]/message:max-w-2xl group-data-[role=user]/message:py-2 rounded-xl"
        )}
      >
        {message.role === "assistant" && textContent && (
          <div className="size-8 flex items-center rounded-full justify-center ring-1 shrink-0 ring-border">
            <SparklesIcon size={14} />
          </div>
        )}

        <div className="flex flex-col gap-2 w-full">
          {message.role === "user" && textContent && (
            <div className="flex flex-col gap-4">
              <Markdown>{textContent}</Markdown>
            </div>
          )}

          {message.role === "assistant" &&
            message.parts?.map((part, index) => {
              if (part.type === "text") {
                return (
                  <Markdown key={index}>{part.text}</Markdown>
                );
              }
              // else if (part.type === "source") {
              //   return <Citation key={index} title={part.title || ""} url={part.url} />;
              // }
              else if (part.type === "file") {
                return (
                  <PreviewAttachment
                    key={part.url}
                    attachment={part}
                  />
                );
              }
              return null;
            })}

          {/* {message.role === "assistant" && urlsInContent && (
            <div className="flex gap-2 w-full max-w-full flex-wrap">
              {urlsInContent.map((citation, index) => (
                <Citation
                  key={index}
                  title={citation.title}
                  url={citation.url}
                />
              ))}
            </div>
          )} */}

        </div>
      </div>
    </motion.div>
  );
});
PreviewMessage.displayName = "PreviewMessage";

export { PreviewMessage };

export const ThinkingMessage = ({
  query,
}: {
  query: string | null | undefined;
}) => {
  const role = "assistant";

  return (
    <motion.div
      className="w-full mx-auto max-w-3xl px-4 group/message "
      initial={{ y: 5, opacity: 0 }}
      animate={{ y: 0, opacity: 1, transition: { delay: 1 } }}
      data-role={role}
    >
      <div
        className={cn(
          "flex gap-4 group-data-[role=user]/message:px-3 w-full group-data-[role=user]/message:w-fit group-data-[role=user]/message:ml-auto group-data-[role=user]/message:max-w-2xl group-data-[role=user]/message:py-2 rounded-xl",
          {
            "group-data-[role=user]/message:bg-muted": true,
          }
        )}
      >
        <div className="size-8 flex items-center rounded-full justify-center ring-1 shrink-0 ring-border">
          <SparklesIcon size={14} />
        </div>

        <div className="flex flex-col gap-2 w-full">
          <div className="flex flex-col text-muted-foreground">
            {query ? (
              <motion.span
                initial={{ opacity: 0.2 }}
                animate={{ opacity: [0.2, 1, 0.2] }}
                transition={{ duration: 1, repeat: Infinity }}
              >
                Searching for: {query}
              </motion.span>
            ) : (
              <motion.span
                initial={{ opacity: 0.2 }}
                animate={{ opacity: [0.2, 1, 0.2] }}
                transition={{ duration: 1, repeat: Infinity }}
              >
                Thinking...
              </motion.span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
};
