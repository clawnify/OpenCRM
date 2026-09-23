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
