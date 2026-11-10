import type { SheetRow } from "./schema";

/** Reads EN identifiers by header; column C must be 2nd_id. Formula cells are never executed. */
export async function readWorkbook(data: ArrayBuffer) {
  if (data.byteLength > 12_000_000) throw new Error("Workbook exceeds 12 MB.");
  const { unzipSync } = await import("fflate");
  let expanded = 0,
    entries = 0;
  unzipSync(new Uint8Array(data), {
    filter(entry) {
      expanded += entry.originalSize;
      entries++;
      if (expanded > 128_000_000 || entries > 500)
        throw new Error("Workbook expands beyond the supported size.");
      return false;
    },
  });
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  const sheet = workbook.getWorksheet("EN");
  if (!sheet || sheet.rowCount > 15000)
    throw new Error(
      "Use a content list with an EN sheet of at most 15,000 rows.",
    );
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => headers.set(cell.text.trim(), col));
  for (const name of [
    "2nd_id",
    "nid",
    "title",
    "full_path",
    "topic",
    "content",
  ])
    if (!headers.has(name)) throw new Error(`Missing column: ${name}`);
  if (headers.get("2nd_id") !== 3) throw new Error("Column C must be 2nd_id.");
  const rows: SheetRow[] = [],
    links: { nid: number; url: string }[] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    const text = (name: string) => {
      const col = headers.get(name);
      return col ? row.getCell(col).text.trim() : "";
    };
    const secondId = Number(text("2nd_id")),
      rawNid = text("nid"),
      n = Number(rawNid);
    const nid = rawNid && Number.isSafeInteger(n) && n > 0 ? n : null;
    const url = text("full_path");
    if (nid && url) links.push({ nid, url });
    if (!Number.isSafeInteger(secondId) || secondId < 1) continue;
    let struck = false;
    row.eachCell((cell) => {
      if (cell.font?.strike) struck = true;
    });
    rows.push({
      secondId,
      nid,
      url,
      title: text("title"),
      topic: text("topic"),
      html: text("content"),
      excluded: struck || text("Result").toLowerCase() === "delete",
    });
  }
  return { rows, links };
}
