import { z } from "zod";
export const actionSchema = z.enum(["add", "update", "delete"]);
export const rowSchema = z.object({
  secondId: z.number().int().positive(),
  nid: z.number().int().positive().nullable(),
  title: z.string().max(2000),
  url: z.string().max(4000),
  topic: z.string().max(2000),
  html: z.string().max(250000),
  excluded: z.boolean(),
});
export const requestSchema = z.object({
  fileName: z.string().max(255),
  adds: z.string().max(4000),
  updates: z.string().max(4000),
  deletes: z.string().max(4000),
  rows: z.array(rowSchema).max(500),
  links: z
    .array(
      z.object({ nid: z.number().int().positive(), url: z.string().max(4000) }),
    )
    .max(15000),
});
export type SheetRow = z.infer<typeof rowSchema>;
export type Action = z.infer<typeof actionSchema>;
export function parseIds(value: string): number[] {
  const result = new Set<number>();
  if (!value.trim()) return [];
  for (const token of value
    .replace(/[–—]/g, "-")
    .split(/[,;\s]+/)
    .filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) throw new Error(`Invalid page range: ${token}`);
    const lo = Number(match[1]),
      hi = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(lo) ||
      !Number.isSafeInteger(hi) ||
      lo < 1 ||
      hi < lo ||
      hi - lo > 499
    )
      throw new Error(`Invalid page range: ${token}`);
    for (let n = lo; n <= hi; n++) result.add(n);
    if (result.size > 500)
      throw new Error("A batch can contain at most 500 pages.");
  }
  return [...result].sort((a, b) => a - b);
}
export function selection(input: {
  adds: string;
  updates: string;
  deletes: string;
}) {
  const entries: { secondId: number; action: Action }[] = [];
  const seen = new Set<number>();
  for (const [value, action] of [
    [input.adds, "add"],
    [input.updates, "update"],
    [input.deletes, "delete"],
  ] satisfies [string, Action][]) {
    for (const secondId of parseIds(value)) {
      if (seen.has(secondId))
        throw new Error(`Page ${secondId} appears in more than one action.`);
      seen.add(secondId);
      entries.push({ secondId, action });
    }
  }
  if (!entries.length || entries.length > 500)
    throw new Error("Choose between 1 and 500 pages.");
  return entries;
}
export const pageSchema = z.object({
  id: z.number(),
  nid: z.number(),
  title: z.string(),
  content: z.string(),
  topic: z.string(),
  url: z.string(),
  path: z.string(),
  contextualInformation: z.string(),
});
export const changeSchema = z.object({
  secondId: z.number(),
  action: actionSchema,
  nid: z.number().nullable(),
  before: pageSchema.nullable(),
  after: pageSchema.omit({ id: true }).nullable(),
  changed: z.boolean(),
  warnings: z.array(z.string()),
  refs: z.array(z.string()),
});
export const jobSchema = z.object({
  fileName: z.string(),
  status: z.enum(["preview", "indexing", "complete"]),
  changes: z.array(changeSchema),
  warnings: z.array(z.string()),
  links: z.array(z.object({ nid: z.number(), url: z.string() })),
  createdAt: z.string(),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type Job = z.infer<typeof jobSchema>;
export type Change = z.infer<typeof changeSchema>;
export const viewJobSchema = jobSchema
  .omit({ links: true, changes: true })
  .extend({
    id: z.uuid(),
    processed: z.number(),
    total: z.number(),
    changes: z.array(changeSchema.omit({ refs: true })),
  });
export type ViewJob = z.infer<typeof viewJobSchema>;
export const historySchema = z.object({
  jobs: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
});
