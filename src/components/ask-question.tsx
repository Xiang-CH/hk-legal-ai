"use client";

import * as React from "react";
import { Check, CircleHelp, Send } from "lucide-react";

import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { cn } from "@/lib/utils";
import type { AskQuestionOutput } from "@/lib/search-tools";
import type { MyUIMessage } from "@/lib/types";

export type AskQuestionPart = Extract<MyUIMessage["parts"][number], { type: "tool-ask_question" }>;

type QuestionInput = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
};

function getInput(part: AskQuestionPart): QuestionInput[] {
  if (!("input" in part)) return [];
  const input = (part as { input?: unknown }).input;
  if (typeof input !== "object" || input === null) return [];
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.filter(
    (q): q is QuestionInput =>
      typeof q === "object" && q !== null && typeof (q as { question?: unknown }).question === "string",
  );
}

function getAnswers(part: AskQuestionPart): Array<{ question: string; answer: string }> {
  if (part.state !== "output-available") return [];
  const output = (part as { output?: unknown }).output;
  if (typeof output !== "object" || output === null) return [];
  const answers = (output as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return [];
  return answers.filter(
    (a): a is { question: string; answer: string } =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as { question?: unknown }).question === "string" &&
      typeof (a as { answer?: unknown }).answer === "string",
  );
}

type PerQuestionState = { selected: string[]; custom: string };

export function AskQuestionCard({
  part,
  onAnswer,
}: {
  part: AskQuestionPart;
  onAnswer: (output: AskQuestionOutput) => void;
}) {
  const questions = React.useMemo(() => getInput(part), [part]);
  const answered = getAnswers(part);
  const [state, setState] = React.useState<Record<number, PerQuestionState>>({});
  const [submitted, setSubmitted] = React.useState(false);

  const interactive = part.state === "input-available" && !submitted;
  const streaming = part.state === "input-streaming";

  const toggleOption = (index: number, label: string) => {
    if (!interactive) return;
    const multi = questions[index]?.multiSelect === true;
    setState((prev) => {
      const current = prev[index] ?? { selected: [], custom: "" };
      const selected = multi
        ? current.selected.includes(label)
          ? current.selected.filter((l) => l !== label)
          : [...current.selected, label]
        : current.selected.includes(label)
          ? []
          : [label];
      return { ...prev, [index]: { ...current, selected } };
    });
  };

  const setCustom = (index: number, custom: string) => {
    if (!interactive) return;
    setState((prev) => {
      const current = prev[index] ?? { selected: [], custom: "" };
      return { ...prev, [index]: { ...current, custom } };
    });
  };

  const answers = React.useMemo<AskQuestionOutput["answers"]>(
    () =>
      questions.flatMap((q, index) => {
        const s = state[index] ?? { selected: [], custom: "" };
        const bits = [...s.selected];
        const custom = s.custom.trim();
        if (custom) bits.push(custom);
        if (bits.length === 0) return [];
        return [{ question: q.question, answer: bits.join("; ") }];
      }),
    [questions, state],
  );

  const handleSubmit = () => {
    if (!interactive || answers.length === 0) return;
    setSubmitted(true);
    onAnswer({ answers });
  };

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/[0.04] px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <CircleHelp className="size-4 shrink-0 text-primary" />
        <span>{answered.length > 0 ? "Clarifications answered" : "A quick question before I continue"}</span>
      </div>

      {streaming && questions.length === 0 && (
        <p className="mt-2 text-sm text-muted-foreground">Preparing questions…</p>
      )}

      {answered.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2">
          {answered.map((a, i) => (
            <li key={i} className="text-sm">
              <div className="flex items-start gap-1.5 text-muted-foreground">
                <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span className="font-medium text-foreground/80">{a.question}</span>
              </div>
              <p className="mt-0.5 pl-5 text-foreground">{a.answer}</p>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 flex flex-col gap-4">
          {questions.map((q, index) => {
            const s = state[index] ?? { selected: [], custom: "" };
            return (
              <div key={index}>
                <p className="text-sm">
                  {q.header && (
                    <span className="mr-1.5 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 align-middle text-[11px] font-medium text-primary">
                      {q.header}
                    </span>
                  )}
                  <span className="font-medium">{q.question}</span>
                </p>
                {q.options && q.options.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {q.options.map((opt) => {
                      const active = s.selected.includes(opt.label);
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          disabled={!interactive}
                          onClick={() => toggleOption(index, opt.label)}
                          title={opt.description}
                          className={cn(
                            "inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors",
                            "disabled:cursor-not-allowed disabled:opacity-60",
                            active
                              ? "border-primary bg-primary text-primary-foreground shadow-xs"
                              : "border-border bg-background hover:border-primary/60 hover:bg-accent",
                          )}
                        >
                          {active && <Check className="size-3.5 shrink-0" />}
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{opt.label}</span>
                            {opt.description && (
                              <span
                                className={cn(
                                  "block max-w-64 truncate text-xs font-normal",
                                  active ? "text-primary-foreground/80" : "text-muted-foreground",
                                )}
                              >
                                {opt.description}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <Textarea
                  value={s.custom}
                  disabled={!interactive}
                  onChange={(e) => setCustom(index, e.target.value)}
                  placeholder="Or type your own answer…"
                  rows={1}
                  className="mt-1.5 min-h-9 resize-y text-sm"
                />
              </div>
            );
          })}

          {part.state === "output-error" && (
            <p className="text-sm text-destructive">Couldn&apos;t record the answers. Please reply in the chat instead.</p>
          )}

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!interactive || answers.length === 0}
              onClick={handleSubmit}
            >
              <Send className="size-3.5" />
              {submitted ? "Sent" : "Send answers"}
            </Button>
            {interactive && (
              <span className="text-xs text-muted-foreground">
                Pick an option, type your own, or combine both.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
