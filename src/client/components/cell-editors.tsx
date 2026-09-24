import { useEffect, useState } from "react";
import { Ban, Plus } from "lucide-react";
import { api } from "@/api";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { RecordPicker } from "@/lib/relations";
import { CategoryBadge } from "@/components/shared";
import { readCustom, TagsInput } from "@/lib/custom-fields";
import { ManyPicker } from "@/components/record-relations";
import { cn } from "@/lib/utils";
import type { CellEdit } from "@/components/record-table";
import type { CustomFieldDef } from "@/types";

type Save<T> = (row: T, patch: Record<string, unknown>) => Promise<void>;

/**
 * A list of options to pick one from, the current one highlighted (never
 * ticked). With `emptyLabel`, a first row clears the value.
 */
export function OptionMenu({ options, value, onPick, emptyLabel }: {
  options: { value: string; label: string }[];
  value: string | null;
  onPick: (value: string | null) => void;
  emptyLabel?: string;
}) {
  return (
    <Command>
      {options.length > 8 && <CommandInput autoFocus placeholder="Search…" />}
      <CommandList>
        <CommandEmpty>No match.</CommandEmpty>
        <CommandGroup>
          {emptyLabel && (
            <CommandItem value={`__none ${emptyLabel}`} onSelect={() => onPick(null)} aria-selected={!value} className={cn(!value && "bg-secondary font-medium")}>
              <Ban className="size-3.5 shrink-0 text-muted-foreground" /> {emptyLabel}
            </CommandItem>
          )}
          {options.map((o) => (
            <CommandItem key={o.value} value={`${o.label} ${o.value}`} onSelect={() => onPick(o.value)} aria-selected={o.value === value} className={cn(o.value === value && "bg-secondary font-medium")}>
              {o.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

/**
 * Pick a value the field already holds somewhere, or type a new one ("Add
 * "Retail""): for a free-text field shown as a pill, like a company's industry.
 * The current value is highlighted; `emptyLabel` clears it.
 */
export function ValuesMenu({ entity, field, value, onPick, emptyLabel }: {
  entity: NonNullable<CustomFieldDef["target_entity"]>;
  field: string;
  value: string | null;
  onPick: (value: string | null) => void;
  emptyLabel?: string;
}) {
  const [values, setValues] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  useEffect(() => {
    api<{ values: string[] }>("GET", `/api/values?entity=${entity}&field=${encodeURIComponent(field)}`)
      .then((d) => setValues(d.values), () => setValues([]));
  }, [entity, field]);
  const typed = search.trim();
  const isNew = typed && !(values ?? []).some((v) => v.toLowerCase() === typed.toLowerCase());
  return (
    <Command>
      <CommandInput autoFocus value={search} onValueChange={setSearch} placeholder="Search or add…" />
      <CommandList>
        {values === null && <div className="py-4 text-center text-[13px] text-muted-foreground">Loading…</div>}
        <CommandGroup>
          {emptyLabel && !typed && (
            <CommandItem value={`__none ${emptyLabel}`} onSelect={() => onPick(null)} aria-selected={!value} className={cn(!value && "bg-secondary font-medium")}>
              <Ban className="size-3.5 shrink-0 text-muted-foreground" /> {emptyLabel}
            </CommandItem>
          )}
          {(values ?? []).map((v) => (
            <CommandItem key={v} value={v} onSelect={() => onPick(v)} aria-selected={v === value} className={cn(v === value && "bg-secondary")}>
              <CategoryBadge value={v} />
            </CommandItem>
          ))}
        </CommandGroup>
        {isNew && (
          <CommandGroup forceMount className="border-t border-border">
            <CommandItem forceMount value="__add" onSelect={() => onPick(typed)}>
              <Plus className="size-3.5 shrink-0 text-muted-foreground" /> Add "{typed}"
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}

/** A cell edit picking one of the values a free-text field already holds, or a new one. */
export function valuesEdit<T>(entity: NonNullable<CustomFieldDef["target_entity"]>, key: string, label: string, save: Save<T>): CellEdit<T> {
  return {
    type: "menu",
    render: (row, close) => {
      const v = (row as Record<string, unknown>)[key];
      return (
        <ValuesMenu
          entity={entity}
          field={key}
          value={v == null || v === "" ? null : String(v)}
          emptyLabel={`No ${label.toLowerCase()}`}
          onPick={(next) => { close(); void save(row, { [key]: next ?? "" }); }}
        />
      );
    },
  };
}

/** A text cell edit writing one field. `nullable`: an emptied value saves as null. */
export function textEdit<T>(key: string, save: Save<T>, opts: { input?: "text" | "email" | "tel" | "number" | "date"; read?: (row: T) => unknown; nullable?: boolean } = {}): CellEdit<T> {
  const read = opts.read ?? ((row: T) => (row as Record<string, unknown>)[key]);
  return {
    type: "text",
    input: opts.input,
    value: (row) => { const v = read(row); return v == null ? "" : String(v); },
    save: (row, v) => {
      const value = v === "" ? (opts.nullable ? null : "") : opts.input === "number" ? Number(v) : v;
      return save(row, { [key]: value });
    },
  };
}

/** A cell edit that picks one option (a status, a badge). */
export function optionEdit<T>(key: string, options: { value: string; label: string }[], save: Save<T>, emptyLabel?: string): CellEdit<T> {
  return {
    type: "menu",
    render: (row, close) => {
      const v = (row as Record<string, unknown>)[key];
      return (
        <OptionMenu
          options={options}
          value={v == null || v === "" ? null : String(v)}
          emptyLabel={emptyLabel}
          onPick={(next) => { close(); void save(row, { [key]: next }); }}
        />
      );
    },
  };
}

/** A cell edit that links one record (a company, a many_to_one relation), or none. */
export function recordEdit<T>(key: string, entity: NonNullable<CustomFieldDef["target_entity"]>, label: string, save: Save<T>): CellEdit<T> {
  return {
    type: "menu",
    render: (row, close) => {
      const id = (row as Record<string, unknown>)[key];
      return (
        <RecordPicker
          entity={entity}
          selected={typeof id === "string" && id ? [id] : []}
          creatable
          emptyLabel={`No ${label.toLowerCase()}`}
          onClear={() => { close(); void save(row, { [key]: null }); }}
          onPick={(r) => { close(); void save(row, { [key]: r.id }); }}
        />
      );
    },
  };
}

/** A custom email or phone field's value, for the cell's copy button. */
export function customFieldCopy<T>(def: CustomFieldDef): ((row: T) => string) | undefined {
  if (def.custom_field !== "clawnify::email.email" && def.custom_field !== "clawnify::phone.phone") return undefined;
  return (row) => String(readCustom(row, def.key) ?? "");
}

/** Tags in a cell: added and removed in place, each change saved as it's made. */
function TagsCell({ initial, onSave }: { initial: unknown; onSave: (value: string) => Promise<void> }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="p-1.5">
      <TagsInput value={value} onChange={(v) => { setValue(v); void onSave(String(v)); }} />
    </div>
  );
}

/**
 * How a custom field's cell edits, by type. `defs` finds a relation's other
 * side. None for a free JSON field.
 */
export function customFieldEdit<T extends { id: string }>(def: CustomFieldDef, save: Save<T>, defs: CustomFieldDef[]): CellEdit<T> | undefined {
  const read = (row: T) => readCustom(row, def.key);
  if (def.field_type === "relation") {
    if (!def.target_entity) return undefined;
    if (def.relation_type === "many_to_one") return recordEdit(def.key, def.target_entity, def.label, save);
    const inverse = defs.find((d) => d.id === def.inverse_def_id);
    return inverse && {
      type: "menu",
      render: (row) => <ManyPicker parentEntity={def.entity_type} parentId={row.id} def={def} inverseKey={inverse.key} />,
    };
  }
  if (def.custom_field === "clawnify::tags.tags") {
    return { type: "menu", render: (row) => <TagsCell initial={read(row)} onSave={(v) => save(row, { [def.key]: v })} /> };
  }
  if (def.field_type === "json") return undefined;
  if (def.custom_field === "clawnify::badge.badge" || def.field_type === "enumeration") {
    const values = Array.isArray(def.options.enum) ? def.options.enum.map(String) : [];
    return optionEdit(def.key, values.map((v) => ({ value: v, label: v })), save, `No ${def.label.toLowerCase()}`);
  }
  if (def.field_type === "boolean") {
    return optionEdit(def.key, [{ value: "1", label: "Yes" }, { value: "0", label: "No" }], (row, patch) => save(row, { [def.key]: patch[def.key] === "1" }));
  }
  if (def.field_type === "integer" || def.field_type === "decimal") return textEdit(def.key, save, { input: "number", read, nullable: true });
  if (def.field_type === "date") return textEdit(def.key, save, { input: "date", read, nullable: true });
  const input = def.custom_field === "clawnify::email.email" ? "email" : def.custom_field === "clawnify::phone.phone" ? "tel" : "text";
  return textEdit(def.key, save, { input, read, nullable: true });
}
