"use client";

import { MessageSquareText, PanelLeftClose, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationMeta } from "@/lib/conversations";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onCollapse,
  disabled,
}: {
  conversations: ConversationMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onCollapse: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-background">
      <div className="flex items-center gap-1 p-3">
        <Button
          variant="outline"
          className="min-w-0 flex-1 justify-start gap-2"
          onClick={onNew}
          disabled={disabled}
        >
          <Plus size={16} />
          New chat
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onCollapse}
          aria-label="Collapse conversation history"
        >
          <PanelLeftClose size={17} />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
        <div className="flex flex-col gap-0.5">
          {conversations.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No conversations yet.
            </p>
          )}
          {conversations.map((c) => {
            const isActive = c.id === activeId;
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-current={isActive ? "true" : undefined}
                onClick={() => {
                  if (!disabled && !isActive) onSelect(c.id);
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !disabled && !isActive) {
                    e.preventDefault();
                    onSelect(c.id);
                  }
                }}
                className={cn(
                  "group relative grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-2 overflow-hidden rounded-lg px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50 text-foreground",
                  disabled && "pointer-events-none opacity-60",
                )}
              >
                <MessageSquareText
                  size={15}
                  className="shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 overflow-hidden">
                  <p className="block truncate font-medium leading-5">{c.title}</p>
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    {formatDate(c.updatedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`Delete "${c.title}"`}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-background p-1 text-muted-foreground opacity-0 shadow-sm ring-1 ring-border transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(c.id);
                  }}
                  disabled={disabled}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      <p className="border-t border-border px-3 py-2 text-[11px] leading-4 text-muted-foreground">
        Stored only in this browser.
      </p>
    </div>
  );
}
