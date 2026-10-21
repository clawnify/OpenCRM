import { useMemo, useState } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, ArrowLeft } from "lucide-react";
import { useCrm } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { createCustomField, TYPE_OPTIONS } from "@/lib/custom-fields";
import { CREATE_FIELD, suggestField, prepareImportFields, importFieldValue, type FieldDraft } from "@/lib/import-fields";
import type { CustomFieldDef, ImportResult, ImportRow } from "@/types";

const IMPORT_TYPES = TYPE_OPTIONS.filter((t) => t.field_type !== "relation");

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
  const { importEntity, customFields, refetchCustomFields } = useCrm();
  // Keep successful creations in this review if a later creation fails.
  const [createdFields, setCreatedFields] = useState<CustomFieldDef[]>([]);
  const entityDefs = useMemo(
    // Relations aren't imported: a cell holds a name, not the linked record's id.
    () => [...customFields, ...createdFields.filter((d) => !customFields.some((f) => f.key === d.key && f.entity_type === d.entity_type))]
      .filter((d) => d.entity_type === config.entity && d.field_type !== "relation"),
    [customFields, createdFields, config.entity],
  );

  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<FieldDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inferCompanies, setInferCompanies] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setStep("upload");
    setBusy(false);
    setFileName("");
    setParsed(null);
    setMapping([]);
    setDrafts([]);
    setCreatedFields([]);
    setError(null);
    setInferCompanies(false);
    setResult(null);
  }

  function handleOpenChange(o: boolean) {
    if (busy) return;
    if (!o) reset();
    onOpenChange(o);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      // Keep CSV text (especially ISO dates and leading-zero identifiers) intact.
      // XLSX cells still use their formatted display values below.
      const wb = XLSX.read(buf, { type: "array", raw: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
      const nonEmpty = grid.filter((r) => r.some((cell) => String(cell).trim() !== ""));
      if (nonEmpty.length < 2) throw new Error("File needs a header row and at least one data row");
      const headers = nonEmpty[0].map((h) => String(h).trim());
      const rows = nonEmpty.slice(1).map((r) => headers.map((_, i) => String(r[i] ?? "")));
      setParsed({ headers, rows });
      const initialMapping = autoMap(headers, config, entityDefs);
      const suggestions = headers.map((header, i) => suggestField(header, rows.map((r) => r[i])));
      setDrafts(suggestions.map((suggestion, i) => suggestion ?? {
        label: headers[i] || `Column ${i + 1}`, typeId: "base:string",
      }));
      setMapping(initialMapping.map((target, i) => {
        const knownHeader = config.exact[norm(headers[i])] ||
          entityDefs.some((d) => norm(d.key) === norm(headers[i]) || norm(d.label) === norm(headers[i]));
        return !target && !knownHeader && suggestions[i] ? CREATE_FIELD : target;
      }));
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
    setDrafts([]);
    setError(null);
    setFileName("");
    setStep("upload");
  }

  const hasRequired = config.hasRequired(mapping);
  const newFieldCount = mapping.filter((target) => target === CREATE_FIELD).length;
  const hasLabels = mapping.every((target, i) => target !== CREATE_FIELD || drafts[i]?.label.trim());
  // Company inference needs an email column but no explicit company mapping to
  // be useful (a mapped Company column already resolves those rows).
  const canInfer =
    config.supportsCompanyInference === true &&
    mapping.some((f) => f === "email") &&
    !mapping.some((f) => f === "company");

  async function onImport() {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const fields = prepareImportFields(
        config.entity, parsed.rows, mapping, drafts,
        [...customFields.filter((d) => d.entity_type === config.entity), ...createdFields].map((d) => d.key),
      );
      const finalMapping = [...mapping];
      for (const field of fields) finalMapping[field.column] = CUSTOM_PREFIX + field.key;
      // Tags and checkboxes need the same text conversion on subsequent imports
      // into an existing field, not only in the review that created it.
      const conversionDefs = new Map([
        ...entityDefs.filter((d) => d.field_type === "boolean" || d.custom_field === "clawnify::tags.tags"),
        ...createdFields, ...fields,
      ].map((d) => [d.key, d]));
      const rows: ImportRow[] = parsed.rows.map((row) => {
        const out: ImportRow = {};
        const custom: Record<string, unknown> = {};
        parsed.headers.forEach((_, i) => {
          const target = finalMapping[i];
          const val = (row[i] || "").trim();
          if (!target || !val) return;
          if (target === "full_name") {
            const [first, ...rest] = val.split(/\s+/);
            if (!out.first_name) out.first_name = first;
            if (rest.length && !out.last_name) out.last_name = rest.join(" ");
          } else if (target.startsWith(CUSTOM_PREFIX)) {
            const key = target.slice(CUSTOM_PREFIX.length);
            const def = conversionDefs.get(key);
            custom[key] = def ? importFieldValue(val, def) : val;
          } else {
            out[target] = val;
          }
        });
        if (Object.keys(custom).length) out.custom = custom;
        return out;
      });
      // All overrides are validated above. Create only the approved definitions,
      // remembering each success before proceeding so a retry can reuse it.
      for (const { column, ...input } of fields) {
        const { def } = await createCustomField(input);
        setCreatedFields((previous) => [...previous, def]);
        setMapping((previous) => previous.map((target, i) => i === column ? CUSTOM_PREFIX + def.key : target));
      }
      if (fields.length || createdFields.length) await refetchCustomFields();
      const res = await importEntity(config.entity, rows, {
        inferCompanyFromEmail: canInfer && inferCompanies,
      });
      setResult(res);
      setStep("done");
    } catch (err) {
      // A successful earlier creation must also be visible outside this dialog.
      await refetchCustomFields().catch(() => {});
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="size-5 text-muted-foreground" />
            {config.title}
          </DialogTitle>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

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
              {" "}Review suggested fields below. You can change their label or type, map to an existing field, or skip.
            </p>
            {createdFields.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {createdFields.length} new {createdFields.length === 1 ? "field has" : "fields have"} been created.
                {" "}They remain available in Attributes even if you cancel; retrying reuses them.
              </p>
            )}

            <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto pr-1">
              {parsed.headers.map((header, i) => (
                <div key={i} className="grid grid-cols-2 items-center gap-3 rounded-md p-2 shadow-edge">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {header || <span className="text-muted-foreground">Column {i + 1}</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{parsed.rows[0]?.[i] || "—"}</div>
                  </div>
                  <Select
                    disabled={busy}
                    value={mapping[i] === "" ? SKIP : mapping[i]}
                    onValueChange={(v) =>
                      setMapping((m) => {
                        const next = [...m];
                        next[i] = v === SKIP ? "" : v;
                        return next;
                      })
                    }
                  >
                    <SelectTrigger className="w-full" aria-label={`Map ${header || `Column ${i + 1}`}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP}>— Skip —</SelectItem>
                      <SelectItem value={CREATE_FIELD}>Create new field</SelectItem>
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
                  {mapping[i] === CREATE_FIELD && (
                    <div className="col-span-2 grid grid-cols-2 gap-3">
                      <label className="space-y-1 text-xs text-muted-foreground">
                        Field label
                        <Input
                          aria-label={`Field label for ${header || `Column ${i + 1}`}`}
                          value={drafts[i].label}
                          disabled={busy}
                          onChange={(e) => setDrafts((previous) => previous.map((d, j) => j === i ? { ...d, label: e.target.value } : d))}
                        />
                      </label>
                      <div className="space-y-1 text-xs text-muted-foreground">
                        Field type
                        <Select
                          value={drafts[i].typeId}
                          disabled={busy}
                          onValueChange={(typeId) => setDrafts((previous) => previous.map((d, j) => j === i ? { ...d, typeId } : d))}
                        >
                          <SelectTrigger aria-label={`Field type for ${header || `Column ${i + 1}`}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {IMPORT_TYPES.map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                <span className="inline-flex items-center gap-2"><t.icon className="size-3.5 opacity-60" />{t.label}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {drafts[i].typeId === "widget:clawnify::badge.badge" && (
                        <p className="col-span-2 text-xs text-muted-foreground">Badge options come from all non-empty values in this column.</p>
                      )}
                      {drafts[i].typeId === "widget:clawnify::tags.tags" && (
                        <p className="col-span-2 text-xs text-muted-foreground">Separate tags with semicolons.</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {canInfer && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-3 text-sm shadow-edge">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  checked={inferCompanies}
                  disabled={busy}
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
                <Button type="button" size="sm" onClick={onImport} disabled={busy || !hasRequired || !hasLabels}>
                  {busy
                    ? "Importing…"
                    : newFieldCount
                      ? `Create ${newFieldCount} ${newFieldCount === 1 ? "field" : "fields"} & import`
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
