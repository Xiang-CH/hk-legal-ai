import { z } from "zod";
/** Platform failures can be HTML or text; never expose their parser errors. */
export async function readResponse(response: Response): Promise<unknown> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(data);
    throw new Error(
      parsed.success
        ? parsed.data.error
        : `Request failed (${response.status}). Reopen the batch under Recent batches to resume.`,
    );
  }
  if (data === null)
    throw new Error(
      "Invalid server response. Reopen the batch under Recent batches to resume.",
    );
  return data;
}
