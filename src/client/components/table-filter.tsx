import { useEffect, useRef, useState } from "react";
import { Filter as FilterIcon, X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Filter } from "@/types";

export interface FilterField {
  key: string;
  label: string;
  type: "text" | "number" | "enum";
  options?: { label: string; value: string }[];
}

const OPS: Record<FilterField["type"], { op: Filter["op"]; label: string }[]> = {
  text: [
    { op: "contains", label: "contains" },
    { op: "is", label: "is" },
    { op: "is_not", label: "is not" },
    { op: "is_empty", label: "is empty" },
    { op: "is_not_empty", label: "is not empty" },
  ],
  number: [
    { op: "is", label: "=" },
    { op: "gt", label: ">" },
    { op: "lt", label: "<" },
    { op: "is_empty", label: "is empty" },
    { op: "is_not_empty", label: "is not empty" },
  ],
  enum: [
    { op: "is", label: "is" },
    { op: "is_not", label: "is not" },
    { op: "is_empty", label: "is empty" },
    { op: "is_not_empty", label: "is not empty" },
  ],
};

const needsValue = (op: Filter["op"]) => op !== "is_empty" && op !== "is_not_empty";
const control = "h-8 rounded-sm bg-card px-2 text-sm shadow-edge";

export function TableFilter({ fields, filters, onChange }: {
  fields: FilterField[];
  filters: Filter[];
  onChange: (f: Filter[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [fieldKey, setFieldKey] = useState(fields[0]?.key ?? "");
  const field = fields.find((f) => f.key === fieldKey) ?? fields[0];
  const ops = OPS[field?.type ?? "text"];
  const [op, setOp] = useState<Filter["op"]>(ops[0]?.op ?? "contains");
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Keep op valid when the field type changes.
  useEffect(() => { if (!ops.some((o) => o.op === op)) setOp(ops[0]?.op ?? "contains"); }, [fieldKey]); // eslint-disable-line

  const add = () => {
    if (!field) return;
    if (needsValue(op) && value.trim() === "") return;
    onChange([...filters, { field: field.key, op, value: needsValue(op) ? value.trim() : undefined }]);
    setValue("");
  };

  const labelFor = (f: Filter) => {
    const fld = fields.find((x) => x.key === f.field);
    const opLabel = (OPS[fld?.type ?? "text"].find((o) => o.op === f.op)?.label) ?? f.op;
    return `${fld?.label ?? f.field} ${opLabel}${f.value != null ? ` ${f.value}` : ""}`;
  };

  return (
    <div className="relative flex items-center gap-2" ref={ref}>
      {filters.map((f, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs">
          {labelFor(f)}
          <button aria-label="Remove filter" onClick={() => onChange(filters.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground">
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
        <FilterIcon className="size-4" />
        Filter{filters.length ? ` · ${filters.length}` : ""}
      </Button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-80 rounded-md bg-popover p-3 shadow-float">
          <div className="mb-2 text-[0.8125rem] font-medium text-muted-foreground">Add filter</div>
          <div className="flex flex-col gap-2">
            <select className={control} value={fieldKey} onChange={(e) => setFieldKey(e.target.value)}>
              {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <select className={control} value={op} onChange={(e) => setOp(e.target.value as Filter["op"])}>
              {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
            {needsValue(op) && (
              field?.type === "enum" && field.options ? (
                <select className={control} value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Select…</option>
                  {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <Input
                  className="h-8"
                  type={field?.type === "number" ? "number" : "text"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Value"
                  onKeyDown={(e) => { if (e.key === "Enter") add(); }}
                />
              )
            )}
            <Button size="sm" onClick={add} className={cn("self-end")}>
              <Plus className="size-4" />
              Add
            </Button>
          </div>
          {filters.length > 0 && (
            <button onClick={() => onChange([])} className="mt-3 text-xs text-muted-foreground hover:text-foreground hover:underline">
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Build the filterable/sortable field list for an entity from built-ins + custom defs. */
export function fieldsFromDefs(
  builtins: FilterField[],
  defs: { key: string; label: string; field_type: string; custom_field: string; options: Record<string, unknown> }[],
): FilterField[] {
  const custom: FilterField[] = defs.map((d) => {
    if (d.custom_field === "clawnify::score.score" || d.field_type === "integer" || d.field_type === "decimal") {
      return { key: d.key, label: d.label, type: "number" };
    }
    if (d.custom_field === "clawnify::badge.badge" || d.field_type === "enumeration") {
      const vals = Array.isArray(d.options.enum) ? (d.options.enum as string[]) : [];
      return { key: d.key, label: d.label, type: "enum", options: vals.map((v) => ({ label: v, value: v })) };
    }
    if (d.field_type === "boolean") {
      return { key: d.key, label: d.label, type: "enum", options: [{ label: "Yes", value: "1" }, { label: "No", value: "0" }] };
    }
    return { key: d.key, label: d.label, type: "text" };
  });
  return [...builtins, ...custom];
}
