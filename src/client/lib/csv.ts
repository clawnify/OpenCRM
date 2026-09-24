import { api } from "@/api";

// A cell a spreadsheet would run as a formula (=, +, -, @, tab, CR) gets a
// leading apostrophe: record data is user input, and an exported CSV is
// opened in Excel or Sheets.
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Downloads rows as a CSV file named `filename`. */
export function downloadCsv(filename: string, header: string[], rows: string[][]): void {
  const text = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** At most this many rows in one export: 100 pages of the list API. */
const MAX_EXPORT_ROWS = 10_000;

/**
 * Downloads a saved view as a CSV: the name column and the view's visible
 * columns, over every record its saved filters and sort select (not what the
 * page shows now, and not unsaved edits). `listPath` is the list API
 * ("/api/contacts"), whose rows come under `rowsKey`.
 */
// shortcut: pages through the list API from the browser; a server-side CSV
// stream if exports outgrow 10k rows.
export async function exportViewCsv<T>(opts: {
  view: { id: string; name: string; filters: unknown[]; sort: string | null; order: "asc" | "desc" | null };
  listPath: string;
  rowsKey: string;
  name: { label: string; text: (row: T) => string };
  columns: { key: string; label: string; text: (row: T) => string }[];
}): Promise<void> {
  const { view, listPath, rowsKey, name, columns } = opts;
  const { fields } = await api<{ fields: { key: string; visible: boolean }[] }>("GET", `/api/views/${view.id}/fields`);
  const hidden = new Set(fields.filter((f) => !f.visible).map((f) => f.key));
  await exportListCsv({
    filename: view.name, listPath, rowsKey, name, columns: columns.filter((c) => !hidden.has(c.key)),
    query: { filters: view.filters, sort: view.sort, order: view.order },
  });
}

/**
 * Downloads every record a list query selects (filters, search, sort), with
 * `columns` after the name: a view as saved, or the list as it is on screen.
 */
export async function exportListCsv<T>(opts: {
  filename: string;
  listPath: string;
  rowsKey: string;
  query: { filters: unknown[]; sort: string | null; order: "asc" | "desc" | null; search?: string };
  name: { label: string; text: (row: T) => string };
  columns: { label: string; text: (row: T) => string }[];
}): Promise<void> {
  const { listPath, rowsKey, query, name, columns } = opts;
  const rows: T[] = [];
  for (let page = 1; rows.length < MAX_EXPORT_ROWS; page++) {
    const q = new URLSearchParams({
      page: String(page), limit: "100", sort: query.sort ?? "created_at", order: query.order ?? "desc",
      tz: String(-new Date().getTimezoneOffset()),
    });
    if (query.filters.length) q.set("filters", JSON.stringify(query.filters));
    if (query.search) q.set("search", query.search);
    const data = await api<Record<string, unknown>>("GET", `${listPath}?${q}`);
    const batch = (data[rowsKey] as T[]) ?? [];
    rows.push(...batch);
    if (!batch.length || rows.length >= Number(data.total)) break;
  }

  const file = `${opts.filename.replace(/[^\w\- ]+/g, "").trim() || "export"}.csv`;
  downloadCsv(file, [name.label, ...columns.map((c) => c.label)], rows.slice(0, MAX_EXPORT_ROWS).map((r) => [name.text(r), ...columns.map((c) => c.text(r))]));
}
