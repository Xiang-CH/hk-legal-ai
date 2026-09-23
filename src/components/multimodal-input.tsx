"use client";

import { motion } from "framer-motion";
import type React from "react";
import {
  useRef,
  useEffect,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import { useLocalStorage, useWindowSize } from "usehooks-ts";

import { cn } from "@/lib/utils";

import { ArrowUpIcon, StopIcon } from "./icons";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { MyUIMessage } from "@/lib/types";

const suggestedActionsChat = [
  {
    title: "Punishment for copyright infringement",
    label: "in Hong Kong",
    action: "What is the punishment for copyright infringement?",
  },
  {
    title: "Definition of illegal importation",
    label: "of foreign goods",
    action: "What count as illegal importation of foreign goods?",
  },
];

const suggestedActionsConsult = [
  {
    title: "Consult on rent disputes",
    label: "in Hong Kong",
    action: "I want to consult on rent disputes between tenants and landlords.",
  },
  {
    title: "Consult on employment disputes",
    label: "in Hong Kong",
    action: "I want to consult on employment disputes between employers and employees.",
  },
]

export function MultimodalInput({
  chatId,
  draftId,
  input,
  setInput,
  isLoading,
  stop,
  messages,
  setMessages,
  sendMessage,
  handleSubmit,
  className,
}: {
  chatId: string;
  draftId?: string;
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  stop: () => void;
  messages: Array<MyUIMessage>;
  setMessages: Dispatch<SetStateAction<Array<MyUIMessage>>>;
  sendMessage: (message: string) => void;
  handleSubmit: (
    event?: {
      preventDefault?: () => void;
    },
  ) => void;
  className?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestedActions = chatId === "001" ? suggestedActionsChat : suggestedActionsConsult;
  const { width } = useWindowSize();

  useEffect(() => {
    if (textareaRef.current) {
      adjustHeight();
    }
  }, []);

  const adjustHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`;
    }
  };

  // Drafts are namespaced per conversation so switching chats restores each draft.
  const storageKey = draftId ? `clic-chat:draft:${draftId}` : "input";
  const [localStorageInput, setLocalStorageInput] = useLocalStorage(
    storageKey,
    "",
  );
  const activeDraftKey = useRef<string | null>(null);

  useEffect(() => {
    if (textareaRef.current) {
      const domValue = textareaRef.current.value;
      // Prefer DOM value over localStorage to handle hydration
      const finalValue = domValue || localStorageInput || "";
      setInput(finalValue);
      adjustHeight();
    }
    activeDraftKey.current = storageKey;
    // Only run once after hydration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the active conversation changes, load its draft. Read straight from
  // the browser store: the useLocalStorage state still holds the previous
  // key's value during this commit, so it would load a stale draft.
  useEffect(() => {
    if (activeDraftKey.current === storageKey) return;
    activeDraftKey.current = storageKey;
    let draft = "";
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) draft = (JSON.parse(raw) as string) || "";
    } catch {
      draft = "";
    }
    setInput(draft);
    adjustHeight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    setLocalStorageInput(input);
  }, [input, setLocalStorageInput]);

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
    adjustHeight();
  };

  const submitForm = useCallback(() => {
    handleSubmit();
    setLocalStorageInput("");

    if (width && width > 768) {
      textareaRef.current?.focus();
    }
  }, [handleSubmit, setLocalStorageInput, width]);

  return (
    <div className="relative w-full flex flex-col gap-4">
      {messages.length === 0 && (
        <div className="grid sm:grid-cols-2 gap-2 w-full max-w-full relative">
          {suggestedActions.map((suggestedAction, index) => (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ delay: 0.05 * index }}
              key={`suggested-action-${suggestedAction.title}-${index}`}
              className={index > 1 ? "hidden sm:block max-w-full" : "block max-w-full"}
            >
              <Button
                variant="ghost"
                onClick={async () => {
                  sendMessage(suggestedAction.action);
                }}
                className="text-left border rounded-xl px-4 py-3.5 text-sm flex-1 gap-0 md:gap-1 flex-col w-full h-auto justify-start items-start break-words"
              >
                <span className="font-medium">{suggestedAction.title}</span>
                <span className="text-muted-foreground whitespace-normal">
                  {suggestedAction.label}
                </span>
              </Button>
            </motion.div>
          ))}
        </div>
      )}

      <Textarea
        ref={textareaRef}
        placeholder="Send a message..."
        value={input}
        onChange={handleInput}
        className={cn(
          "min-h-[24px] max-h-[calc(75dvh)] overflow-hidden resize-none rounded-xl !text-base bg-muted",
          className,
        )}
        rows={3}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();

            if (isLoading) {
              toast.error("Please wait for the model to finish its response!");
            } else {
              submitForm();
            }
          }
        }}
      />

      {isLoading ? (
        <Button
          className="rounded-full p-1.5 h-fit absolute bottom-1 right-2 m-0.5 border dark:border-zinc-600"
          onClick={(event) => {
            event.preventDefault();
            stop();
            // setMessages((messages) => sanitizeUIMessages(messages));
            setMessages(messages);
          }}
        >
          <StopIcon size={14} />
        </Button>
      ) : (
        <Button
          className="rounded-full p-1.5 h-fit absolute bottom-1 right-2 m-0.5 border dark:border-zinc-600"
          onClick={(event) => {
            event.preventDefault();
            submitForm();
          }}
          disabled={input.length === 0}
        >
          <ArrowUpIcon size={14} />
        </Button>
      )}
    </div>
  );
}
