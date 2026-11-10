"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { ViewJob } from "@/lib/content-admin/schema";

const DiffViewer = dynamic(() => import("react-diff-viewer-continued"), {
  ssr: false,
  loading: () => (
    <p role="status" className="p-4 text-sm">
      Loading diff…
    </p>
  ),
});

type Change = ViewJob["changes"][number];

function documentText(page: Change["before"] | Change["after"]): string {
  if (!page) return "";
  return [
    `Title: ${page.title}`,
    `URL: ${page.url}`,
    `Topic: ${page.topic}`,
    `Context: ${page.contextualInformation}`,
    "",
    page.content,
  ].join("\n");
}

export default function ContentDiff({ change }: { change: Change }) {
  const [open, setOpen] = useState(false);
  const [split, setSplit] = useState(false);
  return (
    <details
      className="mt-3 min-w-0"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer py-2 underline underline-offset-4">
        Compare changes
      </summary>
      {open && (
        <div className="mt-3 min-w-0 rounded border border-neutral-200">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-neutral-50 p-3">
            <p className="text-xs text-neutral-600">
              <span className="text-red-800">− Removed</span>
              {" · "}
              <span className="text-emerald-800">+ Added</span>
            </p>
            <label className="text-xs">
              Diff view{" "}
              <select
                className="ml-1 rounded border bg-white p-1"
                value={split ? "split" : "unified"}
                onChange={(event) => setSplit(event.target.value === "split")}
              >
                <option value="unified">Unified</option>
                <option value="split">Side by side</option>
              </select>
            </label>
          </div>
          <div
            role="region"
            aria-label={`Changes for page ${change.secondId}`}
            tabIndex={0}
            className="max-h-[36rem] overflow-auto text-xs"
          >
            <DiffViewer
              oldValue={documentText(change.before)}
              newValue={documentText(change.after)}
              splitView={split}
              leftTitle={split ? "Before" : "Before → After"}
              rightTitle="After"
              hideSummary
              styles={{
                diffContainer: {
                  minWidth: split ? "640px" : "0",
                  "@media (max-width: 768px)": {
                    minWidth: split ? "640px" : "0",
                  },
                  pre: { width: "auto" },
                  "& col[width='50px']": { width: "32px" },
                  "& col[width='28px']": { width: "20px" },
                },
                gutter: { minWidth: 32, width: 32, padding: "0 4px" },
                codeFoldGutter: { minWidth: 32, width: 32 },
                marker: { minWidth: 20, width: 20, padding: 0 },
                contentText: {
                  lineBreak: "normal",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                },
              }}
            />
          </div>
        </div>
      )}
    </details>
  );
}
