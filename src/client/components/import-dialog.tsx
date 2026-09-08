import { useMemo, useState } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, ArrowLeft } from "lucide-react";
import { useCrm } from "@/context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
} from "@/components/ui/select";
import type { EntityImportConfig } from "@/lib/import-config";
import type { ImportResult, ImportRow } from "@/types";

type Step = "upload" | "map" | "done";

interface Parsed {
  headers: string[];
  rows: string[][];
}

// Radix Select items cannot use an empty-string value, so "Skip" uses this
// sentinel and is treated as "" everywhere in the mapping logic. Custom-field
// targets are prefixed so they're distinguishable from built-in payload keys.
const SKIP = "__skip__";
const CUSTOM_PREFIX = "custom:";

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

function autoMap(
  headers: string[],
  config: EntityImportConfig,
  customFields: { key: string; label: string }[],
): string[] {
  const result: string[] = headers.map(() => "");
  const used = new Set<string>();
  // 1. exact built-in header match
  headers.forEach((h, i) => {
    const f = config.exact[norm(h)];
    if (f && !used.has(f)) {
      result[i] = f;
      used.add(f);
    }
  });
  // 2. custom field whose key or label matches the header
  headers.forEach((h, i) => {
    if (result[i]) return;
    const n = norm(h);
    for (const d of customFields) {
      const target = CUSTOM_PREFIX + d.key;
      if (used.has(target)) continue;
      if (n === norm(d.key) || n === norm(d.label)) {
        result[i] = target;
        used.add(target);
        break;
      }
    }
  });
  // 3. fuzzy built-in fallback
  headers.forEach((h, i) => {
    if (result[i]) return;
    const n = norm(h);
    for (const [re, f] of config.fuzzy) {
      if (re.test(n) && !used.has(f)) {
        result[i] = f;
        used.add(f);
        break;
      }
    }
  });
  return result;
}

export function ImportDialog({
  open,
  onOpenChange,
  config,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  config: EntityImportConfig;
}) {
  const { importEntity, setError, customFields } = useCrm();
  const entityDefs = useMemo(
    () => customFields.filter((d) => d.entity_type === config.entity),
    [customFields, config.entity],
  );

  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [inferCompanies, setInferCompanies] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setStep("upload");
    setBusy(false);
    setFileName("");
    setParsed(null);
    setMapping([]);
    setInferCompanies(false);
    setResult(null);
  }

  function handleOpenChange(o: boolean) {
    if (!o) reset();
    onOpenChange(o);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
      const nonEmpty = grid.filter((r) => r.some((cell) => String(cell).trim() !== ""));
      if (nonEmpty.length < 2) throw new Error("File needs a header row and at least one data row");
      const headers = nonEmpty[0].map((h) => String(h).trim());
      const rows = nonEmpty.slice(1).map((r) => headers.map((_, i) => String(r[i] ?? "")));
      setParsed({ headers, rows });
      setMapping(autoMap(headers, config, entityDefs));
      setStep("map");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the file");
      setFileName("");
    } finally {
      setBusy(false);
    }
  }

  function backToUpload() {
    setParsed(null);
    setMapping([]);
    setFileName("");
    setStep("upload");
  }

  const hasRequired = config.hasRequired(mapping);
  // Company inference needs an email column but no explicit company mapping to
  // be useful (a mapped Company column already resolves those rows).
  const canInfer =
    config.supportsCompanyInference === true &&
    mapping.some((f) => f === "email") &&
    !mapping.some((f) => f === "company");

  async function onImport() {
    if (!parsed) return;
    setBusy(true);
    try {
      const rows: ImportRow[] = parsed.rows.map((row) => {
        const out: ImportRow = {};
        const custom: Record<string, unknown> = {};
        parsed.headers.forEach((_, i) => {
          const target = mapping[i];
          const val = (row[i] || "").trim();
          if (!target || !val) return;
          if (target === "full_name") {
            const [first, ...rest] = val.split(/\s+/);
            if (!out.first_name) out.first_name = first;
            if (rest.length && !out.last_name) out.last_name = rest.join(" ");
          } else if (target.startsWith(CUSTOM_PREFIX)) {
            custom[target.slice(CUSTOM_PREFIX.length)] = val;
          } else {
            out[target] = val;
          }
        });
        if (Object.keys(custom).length) out.custom = custom;
        return out;
      });
      const res = await importEntity(config.entity, rows, {
        inferCompanyFromEmail: canInfer && inferCompanies,
      });
      setResult(res);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="size-5 text-muted-foreground" />
            {config.title}
          </DialogTitle>
        </DialogHeader>

        {step === "upload" && (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input p-10 text-center transition-colors hover:border-primary hover:bg-secondary">
            <input
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              onChange={onFile}
              disabled={busy}
            />
            <Upload className="size-5 text-muted-foreground" />
            {busy ? (
              <span className="text-sm text-muted-foreground">Reading {fileName}…</span>
            ) : (
              <>
                <span className="text-sm font-medium">Choose a CSV or Excel file</span>
                <span className="text-xs text-muted-foreground">
                  .csv, .xlsx, or .xls — first row must be column headers
                </span>
              </>
            )}
          </label>
        )}

        {step === "map" && parsed && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Map columns from {fileName} ({parsed.rows.length} {parsed.rows.length === 1 ? "row" : "rows"}).
            </p>

            <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto pr-1">
              {parsed.headers.map((header, i) => (
                <div key={i} className="grid grid-cols-2 items-center gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {header || <span className="text-muted-foreground">Column {i + 1}</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{parsed.rows[0]?.[i] || "—"}</div>
                  </div>
                  <Select
                    value={mapping[i] === "" ? SKIP : mapping[i]}
                    onValueChange={(v) =>
                      setMapping((m) => {
                        const next = [...m];
                        next[i] = v === SKIP ? "" : v;
                        return next;
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP}>— Skip —</SelectItem>
                      {config.fields.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                      {entityDefs.length > 0 && (
                        <>
                          <SelectSeparator />
                          <SelectGroup>
                            <SelectLabel>Custom fields</SelectLabel>
                            {entityDefs.map((d) => (
                              <SelectItem key={d.key} value={CUSTOM_PREFIX + d.key}>
                                {d.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {canInfer && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-3 text-sm shadow-edge">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  checked={inferCompanies}
                  onChange={(e) => setInferCompanies(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Create companies from work-email domains</span>
                  <span className="block text-xs text-muted-foreground">
                    For rows without a company, group contacts by their email domain into a company.
                    Personal providers (Gmail, Outlook, …) are skipped.
                  </span>
                </span>
              </label>
            )}

            <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col sm:items-end sm:space-x-0">
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={backToUpload} disabled={busy}>
                  <ArrowLeft className="size-4" />
                  Back
                </Button>
                <Button type="button" size="sm" onClick={onImport} disabled={busy || !hasRequired}>
                  {busy
                    ? "Importing…"
                    : `Import ${parsed.rows.length} ${parsed.rows.length === 1 ? config.noun : `${config.noun}s`}`}
                </Button>
              </div>
              {!hasRequired && <p className="text-xs text-muted-foreground">{config.requiredHint}</p>}
            </DialogFooter>
          </div>
        )}

        {step === "done" && result && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 className="size-10 text-success" />
            <p className="font-semibold">
              {result.imported} {result.imported === 1 ? config.noun : `${config.noun}s`} imported
            </p>
            <p className="text-sm text-muted-foreground">{doneDetail(result, config.noun)}</p>
            <DialogFooter className="mt-2 w-full sm:justify-center">
              <Button type="button" size="sm" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function doneDetail(r: ImportResult, noun: string): string {
  const parts: string[] = [];
  if (r.companiesCreated && r.companiesCreated > 0)
    parts.push(`${r.companiesCreated} new ${r.companiesCreated === 1 ? "company" : "companies"}`);
  if (r.duplicates && r.duplicates > 0)
    parts.push(`${r.duplicates} duplicate ${r.duplicates === 1 ? `${noun} name` : `${noun} names`} skipped`);
  if (r.skipped > 0) parts.push(`${r.skipped} ${r.skipped === 1 ? "row" : "rows"} skipped (no name)`);
  return parts.length ? parts.join(" · ") : "All rows imported cleanly.";
}
