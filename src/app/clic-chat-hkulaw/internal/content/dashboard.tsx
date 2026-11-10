"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ContentDiff from "./content-diff";
import { z } from "zod";
import { readResponse } from "@/lib/content-admin/response";
import { APP_BASE_PATH } from "@/lib/routes";
import {
  historySchema,
  selection,
  viewJobSchema,
  type ViewJob,
} from "@/lib/content-admin/schema";
import type { readWorkbook } from "@/lib/content-admin/workbook";
const api = APP_BASE_PATH + "/api/internal/content";
type Workbook = Awaited<ReturnType<typeof readWorkbook>>;
type History = z.infer<typeof historySchema>["jobs"];
const field =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base sm:text-sm text-neutral-900 focus:outline-2 focus:outline-offset-2 focus:outline-neutral-800 disabled:opacity-50";
const button =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 hover:bg-neutral-700";
/** Coordinate staff login, workbook selection and resumable imports without storing the shared key. */
export default function ContentDashboard() {
  const [key, setKey] = useState(""),
    [unlocked, setUnlocked] = useState(false),
    [checkingSession, setCheckingSession] = useState(true),
    [history, setHistory] = useState<History>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [workbook, setWorkbook] = useState<Workbook | null>(null),
    [fileName, setFileName] = useState("");
  const [adds, setAdds] = useState(""),
    [updates, setUpdates] = useState(""),
    [deletes, setDeletes] = useState("");
  const [job, setJob] = useState<ViewJob | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("all");
  const active = useRef(false);
  useEffect(() => {
    let cancelled = false;
    /** Restore an existing cookie session and history, ignoring results after unmount. */
    async function restoreSession() {
      try {
        const response = await fetch(api + "/session", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (response.status === 401) return;
        await readResponse(response);
        const historyResponse = await fetch(api, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const data = historySchema.parse(await readResponse(historyResponse));
        if (!cancelled) {
          setHistory(data.jobs);
          setHistoryCursor(data.nextCursor);
          setUnlocked(true);
        }
      } catch (error) {
        if (!cancelled)
          setError(
            error instanceof Error
              ? error.message
              : "Could not restore your session.",
          );
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    }
    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  /** Send a session-authenticated request and clear protected UI when the session is rejected. */
  async function request(path: string, init?: RequestInit) {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.status === 401) {
      setUnlocked(false);
      setJob(null);
      setHistory([]);
      setHistoryCursor(null);
    }
    return readResponse(response);
  }

  /** Track the active operation and display a recoverable error while always releasing the busy state. */
  async function attempt(run: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const data = historySchema.parse(await request(api));
    setHistory(data.jobs);
    setHistoryCursor(data.nextCursor);
  }
  /** Append the next history page so interrupted batches remain reachable after newer previews. */
  async function olderBatches() {
    if (!historyCursor) return;
    const data = historySchema.parse(
      await request(api + "?before=" + historyCursor),
    );
    setHistory((current) => [
      ...new Map(
        [...current, ...data.jobs].map((job) => [job.id, job]),
      ).values(),
    ]);
    setHistoryCursor(data.nextCursor);
  }
  /** Exchange the shared key for a persistent session and immediately clear the key from memory. */
  async function unlock() {
    await attempt(async () => {
      await request(api + "/session", {
        method: "POST",
        headers: { Authorization: "Bearer " + key },
      });
      setKey("");
      await refresh();
      setUnlocked(true);
    });
  }
  /** Parse a bounded workbook locally and discard any preview from the previous file. */
  async function upload(file: File | undefined) {
    if (!file) return;
    await attempt(async () => {
      setWorkbook(null);
      setJob(null);
      if (!file.name.toLowerCase().endsWith(".xlsx") || file.size > 12_000_000)
        throw new Error("Choose an .xlsx content list smaller than 12 MB.");
      const { readWorkbook } = await import("@/lib/content-admin/workbook");
      setWorkbook(await readWorkbook(await file.arrayBuffer()));
      setFileName(file.name);
    });
  }
  /** Send only selected rows and reference mappings after enforcing the hosting request-size limit. */
  async function preview() {
    await attempt(async () => {
      if (!workbook) return;
      const wanted = new Set(
        selection({ adds, updates, deletes }).map((x) => x.secondId),
      );
      const body = JSON.stringify({
        fileName,
        adds,
        updates,
        deletes,
        rows: workbook.rows.filter((r) => wanted.has(r.secondId)),
        links: workbook.links,
      });
      if (new Blob([body]).size > 3_000_000)
        throw new Error("Selected content exceeds 3 MB. Use a smaller batch.");
      setJob(
        viewJobSchema.parse(
          await request(api, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
        ),
      );
      await refresh();
    });
  }
  async function resume(id: string) {
    await attempt(async () => {
      setJob(viewJobSchema.parse(await request(api + "/" + id)));
    });
  }
  /** Advance the saved batch until publication or interruption; the server owns durable progress. */
  async function apply() {
    if (!job || active.current) return;
    active.current = true;
    await attempt(async () => {
      let next = job;
      while (next.status !== "complete" && active.current) {
        next = viewJobSchema.parse(
          await request(api + "/" + next.id, { method: "POST" }),
        );
        setJob(next);
      }
      await refresh();
    });
    active.current = false;
  }
  const counts = job
    ? {
        add: job.changes.filter((c) => c.action === "add" && c.changed).length,
        update: job.changes.filter((c) => c.action === "update" && c.changed)
          .length,
        delete: job.changes.filter((c) => c.action === "delete" && c.changed)
          .length,
        unchanged: job.changes.filter((c) => !c.changed).length,
      }
    : null;
  const changes =
    job?.changes.filter(
      (c) =>
        filter === "all" ||
        (filter === "unchanged"
          ? !c.changed
          : c.action === filter && c.changed),
    ) ?? [];
  return (
    <main
      aria-label="CLIC content dashboard"
      tabIndex={0}
      className="h-[calc(100dvh-37px)] overflow-y-auto overscroll-contain bg-neutral-50 text-neutral-900"
    >
      <div className="mx-auto max-w-6xl px-3 py-6 sm:px-8 sm:py-10">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <Link
              href={APP_BASE_PATH + "/c"}
              className="text-sm text-neutral-600 underline underline-offset-4"
            >
              Back to CLIC Chat
            </Link>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">
              CLIC content
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
              Maintain the English knowledge base from a content list. Review
              each change before publishing it to search.
            </p>
          </div>
          {unlocked && (
            <button
              className="text-sm underline"
              onClick={() =>
                void attempt(async () => {
                  await request(api + "/session", { method: "DELETE" });
                  active.current = false;
                  setKey("");
                  setUnlocked(false);
                  setJob(null);
                  setHistory([]);
                  setHistoryCursor(null);
                  setWorkbook(null);
                  setFileName("");
                  setAdds("");
                  setUpdates("");
                  setDeletes("");
                })
              }
              disabled={busy}
            >
              Lock dashboard
            </button>
          )}
        </div>
        {error && (
          <div
            role="alert"
            className="mb-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900"
          >
            {error}
          </div>
        )}
        {checkingSession ? (
          <p role="status" className="text-sm text-neutral-600">
            Checking your session…
          </p>
        ) : !unlocked ? (
          <form
            className="max-w-md rounded-lg border border-neutral-200 bg-white p-4 sm:p-6"
            onSubmit={(e) => {
              e.preventDefault();
              void unlock();
            }}
          >
            <h2 className="text-lg font-semibold">Staff access</h2>
            <label htmlFor="admin-key" className="mt-5 mb-2 block text-sm">
              Admin access key
            </label>
            <input
              id="admin-key"
              type="password"
              autoComplete="off"
              className={field}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              required
            />
            <p className="mt-2 text-xs text-neutral-500">
              Stay signed in on this browser for 7 days. Lock the dashboard to
              sign out.
            </p>
            <button className={button + " mt-5"} disabled={busy}>
              {busy ? "Checking access…" : "Open dashboard"}
            </button>
          </form>
        ) : (
          <>
            <section className="rounded-lg border border-neutral-200 bg-white p-4 sm:p-6">
              <h2 className="text-lg font-semibold">Prepare a batch</h2>
              <p className="mt-1 text-sm text-neutral-600">
                Numbers refer to column C, <strong>2nd_id</strong>, in the EN
                sheet. Use commas and inclusive ranges, such as 1–2, 11,
                204–223.
              </p>
              <label
                htmlFor="workbook"
                className="mt-5 mb-2 block text-sm font-medium"
              >
                Content list (.xlsx)
              </label>
              <input
                id="workbook"
                type="file"
                accept=".xlsx"
                disabled={busy}
                className={field}
                onChange={(e) => void upload(e.target.files?.[0])}
              />
              {workbook && (
                <p className="mt-2 text-sm text-neutral-600">
                  {fileName} · {workbook.rows.length.toLocaleString()} numbered
                  rows loaded. Nothing has been changed.
                </p>
              )}
              <div className="mt-5 grid gap-5 md:grid-cols-3">
                {[
                  { id: "add", label: "Add pages", value: adds, set: setAdds },
                  {
                    id: "update",
                    label: "Update pages",
                    value: updates,
                    set: setUpdates,
                  },
                  {
                    id: "delete",
                    label: "Delete pages",
                    value: deletes,
                    set: setDeletes,
                  },
                ].map((f) => (
                  <div key={f.id}>
                    <label
                      htmlFor={f.id}
                      className="mb-2 block text-sm font-medium"
                    >
                      {f.label}
                    </label>
                    <textarea
                      id={f.id}
                      rows={3}
                      className={field}
                      placeholder="e.g. 1-2, 11, 14, 204-223"
                      value={f.value}
                      disabled={busy}
                      onChange={(e) => {
                        f.set(e.target.value);
                        setJob(null);
                      }}
                    />
                  </div>
                ))}
              </div>
              <button
                className={button + " mt-5"}
                disabled={!workbook || busy}
                onClick={() => void preview()}
              >
                {busy ? "Working…" : "Preview changes"}
              </button>
              <p className="mt-3 text-xs text-neutral-500">
                Up to 500 pages per batch. Workbook deletion marks are shown as
                warnings for you to review.
              </p>
            </section>
            {job && counts && (
              <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-4 sm:p-6">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {job.status === "complete"
                        ? "Published to search"
                        : "Review changes"}
                    </h2>
                    <p className="mt-1 text-sm text-neutral-500">
                      {job.fileName} · English pages
                    </p>
                  </div>
                  <span className="text-sm text-neutral-600">
                    {job.status === "preview"
                      ? "Preview only"
                      : job.status === "indexing"
                        ? "Preparing search data"
                        : "Complete"}
                  </span>
                </div>
                <div className="my-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {Object.entries(counts).map(([name, count]) => (
                    <button
                      key={name}
                      onClick={() => setFilter(name)}
                      className="border-b-2 border-neutral-200 pb-3 text-left focus:outline-2"
                    >
                      <span className="block text-2xl font-semibold tabular-nums">
                        {count}
                      </span>
                      <span className="mt-1 block text-sm capitalize text-neutral-600">
                        {name === "delete"
                          ? "Delete"
                          : name === "unchanged"
                            ? "No change"
                            : name}
                      </span>
                    </button>
                  ))}
                </div>
                <div
                  className="mb-5 flex h-2 overflow-hidden rounded bg-neutral-100"
                  aria-label={`${counts.add} additions, ${counts.update} updates, ${counts.delete} deletions, ${counts.unchanged} unchanged`}
                >
                  {Object.entries(counts).map(([name, count]) => (
                    <div
                      key={name}
                      title={`${name}: ${count}`}
                      className={
                        name === "add"
                          ? "bg-emerald-600"
                          : name === "update"
                            ? "bg-blue-600"
                            : name === "delete"
                              ? "bg-red-600"
                              : "bg-neutral-300"
                      }
                      style={{
                        width: `${(100 * count) / job.changes.length}%`,
                      }}
                    />
                  ))}
                </div>
                <div className="mb-3 flex items-center justify-between">
                  <label className="text-sm">
                    Show{" "}
                    <select
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      className="ml-2 rounded border p-1"
                    >
                      {["all", "add", "update", "delete", "unchanged"].map(
                        (x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <span className="text-xs text-neutral-500">
                    {changes.length} rows
                  </span>
                </div>
                <div className="min-w-0">
                  <div
                    className="hidden grid-cols-[5rem_5rem_minmax(0,1fr)] gap-3 border-y bg-neutral-50 py-3 text-sm font-medium text-neutral-600 md:grid"
                    aria-hidden="true"
                  >
                    <span>2nd_id</span>
                    <span>Action</span>
                    <span>Article and changes</span>
                  </div>
                  <div
                    role="list"
                    aria-label="Article changes"
                    className="min-w-0 text-sm"
                  >
                    {changes.map((c) => (
                      <div
                        key={c.secondId}
                        role="listitem"
                        className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-2 border-b py-4 md:grid-cols-[5rem_5rem_minmax(0,1fr)]"
                      >
                        <div className="tabular-nums">
                          <span className="md:sr-only">Page </span>
                          {c.secondId}
                        </div>
                        <div className="capitalize text-neutral-600">
                          {c.changed ? c.action : "No change"}
                        </div>
                        <div className="col-span-2 min-w-0 md:col-span-1">
                          <p className="break-words font-medium">
                            {c.after?.title ?? c.before?.title ?? "Page absent"}
                          </p>
                          <p className="mt-1 break-all text-xs text-neutral-500">
                            {c.after?.url ?? c.before?.url}
                          </p>
                          {c.action === "update" &&
                            c.changed &&
                            c.before &&
                            c.after && (
                              <p className="mt-2 text-xs text-neutral-600">
                                Changed:{" "}
                                {(
                                  [
                                    "title",
                                    "url",
                                    "content",
                                    "topic",
                                    "contextualInformation",
                                  ] as const
                                )
                                  .filter(
                                    (field) =>
                                      c.before?.[field] !== c.after?.[field],
                                  )
                                  .map((field) =>
                                    field === "contextualInformation"
                                      ? "context"
                                      : field,
                                  )
                                  .join(", ")}
                              </p>
                            )}
                          {c.warnings.map((w) => (
                            <p key={w} className="mt-2 text-amber-800">
                              {w}
                            </p>
                          ))}
                          {c.changed && <ContentDiff change={c} />}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {job.warnings.length > 0 && (
                  <details className="mt-5 rounded border border-amber-200 bg-amber-50 p-4 text-sm">
                    <summary>{job.warnings.length} reference warnings</summary>
                    <ul className="mt-3 list-disc pl-5">
                      {job.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {job.status !== "complete" && (
                  <div className="mt-6 border-t pt-5">
                    {job.status === "indexing" && (
                      <>
                        <label htmlFor="import-progress" className="text-sm">
                          Search data prepared: {job.processed} / {job.total}{" "}
                          chunks
                        </label>
                        <progress
                          id="import-progress"
                          className="mt-2 block w-full accent-neutral-900"
                          value={job.processed}
                          max={job.total || 1}
                        />
                      </>
                    )}
                    <p className="my-3 text-sm text-neutral-600">
                      {job.status === "preview"
                        ? `Apply ${counts.add} additions, ${counts.update} updates and ${counts.delete} deletions. Deletions remove pages and their search entries.`
                        : "Preparation is saved after each step. If interrupted, reopen this batch and resume. Live content changes only when the whole batch is ready."}
                    </p>
                    <button
                      className={button}
                      disabled={busy || !job.changes.some((c) => c.changed)}
                      onClick={() => void apply()}
                    >
                      {busy
                        ? "Preparing and publishing…"
                        : job.status === "indexing"
                          ? "Resume import"
                          : "Apply reviewed changes"}
                    </button>
                  </div>
                )}
                {job.status === "complete" && (
                  <p
                    role="status"
                    className="mt-5 text-sm font-medium text-emerald-800"
                  >
                    Pages, references and search entries were published
                    together.
                  </p>
                )}
              </section>
            )}
            <section className="mt-8">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Recent batches</h2>
                <button
                  className="text-sm underline"
                  disabled={busy}
                  onClick={() => void attempt(refresh)}
                >
                  Refresh
                </button>
              </div>
              <div className="mt-3 divide-y rounded-lg border border-neutral-200 bg-white">
                {history.length === 0 ? (
                  <p className="p-5 text-sm text-neutral-500">
                    No imports yet.
                  </p>
                ) : (
                  history.map((h) => (
                    <button
                      key={h.id}
                      className="flex w-full flex-wrap items-center justify-between gap-2 p-4 text-left text-sm hover:bg-neutral-50"
                      disabled={busy}
                      onClick={() => void resume(h.id)}
                    >
                      <span className="font-medium">{h.name}</span>
                      <span className="text-neutral-500">
                        {new Date(h.createdAt).toLocaleString()} · {h.status}
                      </span>
                    </button>
                  ))
                )}
              </div>
              {historyCursor && (
                <button
                  className={button + " mt-3"}
                  disabled={busy}
                  onClick={() => void attempt(olderBatches)}
                >
                  Load older batches
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
