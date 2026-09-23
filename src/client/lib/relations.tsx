/**
 * Relations, client side: record chips, the record picker, and the value
 * control for a relation field.
 *
 * A relation field holds a linked record's id (many_to_one) or lists the
 * records linked back to this one (one_to_many). Read rows carry the linked
 * records under `row.relations[key]`; anything that only has ids (a filter,
 * a form) names them through a shared cache filled from GET /api/records.
 */

import { useEffect, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Ban, Handshake } from "lucide-react";
import { Avatar, EntityIcon } from "@/components/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { api } from "@/api";
import { go } from "@/hooks/use-router";
import { cn } from "@/lib/utils";
import type { RecordColumn } from "@/components/record-table";
import type { CustomFieldDef, EntityType, RelationRecord, RelationValue } from "@/types";

// ── Names: one cache for every chip, picker and filter ────────────────

// `${entity}:${id}` → the record, or null once the server says it's gone.
const names = new Map<string, RelationRecord | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const nameKey = (entity: EntityType, id: string) => `${entity}:${id}`;

function remember(entity: EntityType, records: RelationRecord[], asked: string[] = []) {
  for (const id of asked) if (!names.has(nameKey(entity, id))) names.set(nameKey(entity, id), null);
  for (const r of records) names.set(nameKey(entity, r.id), r);
  version++;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

async function fetchNames(entity: EntityType, ids: string[]) {
  const todo = ids.filter((id) => !pending.has(nameKey(entity, id)));
  if (!todo.length) return;
  todo.forEach((id) => pending.add(nameKey(entity, id)));
  try {
    for (let i = 0; i < todo.length; i += 60) {
      const part = todo.slice(i, i + 60);
      const { records } = await api<{ records: RelationRecord[] }>("GET", `/api/records?entity=${entity}&ids=${part.map(encodeURIComponent).join(",")}`);
      remember(entity, records, part);
    }
  } catch {
    /* unnamed ids read as "…"; the next render asks again */
  } finally {
    todo.forEach((id) => pending.delete(nameKey(entity, id)));
  }
}

/** Records of `entity` matching `search` by name, remembered for later chips. */
export async function searchRecords(entity: EntityType, search: string): Promise<RelationRecord[]> {
  const { records } = await api<{ records: RelationRecord[] }>("GET", `/api/records?entity=${entity}&search=${encodeURIComponent(search)}`);
  remember(entity, records);
  return records;
}

/**
 * Names the given ids, fetching the ones not yet known; re-renders when they
 * arrive. Returns a lookup: the record, null for one that no longer exists,
 * undefined while loading.
 */
export function useRecordNames(wanted: Array<{ entity: EntityType; id: string }>) {
  useSyncExternalStore(subscribe, () => version);
  const missing = wanted.filter((w) => !names.has(nameKey(w.entity, w.id)));
  const ask = missing.map((w) => nameKey(w.entity, w.id)).join(" ");
  useEffect(() => {
    const byEntity = new Map<EntityType, string[]>();
    for (const w of missing) byEntity.set(w.entity, [...(byEntity.get(w.entity) ?? []), w.id]);
    byEntity.forEach((ids, entity) => void fetchNames(entity, ids));
  }, [ask]); // eslint-disable-line react-hooks/exhaustive-deps
  return (entity: EntityType, id: string) => names.get(nameKey(entity, id));
}

// ── Chips ─────────────────────────────────────────────────────────────

const LIST_PATH: Partial<Record<EntityType, string>> = { contact: "/contacts", company: "/companies" };

/** Where a record opens: its list with the record in the side panel. Deals have no record page. */
export function recordHref(entity: EntityType, id: string): string | undefined {
  const base = LIST_PATH[entity];
  return base ? `${base}?record=${encodeURIComponent(id)}` : undefined;
}

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function RecordIcon({ entity, record }: { entity: EntityType; record: RelationRecord }) {
  if (entity === "company") return <EntityIcon name={record.label} domain={record.domain} className="size-4 rounded-xs text-[0.5rem]" />;
  if (entity === "contact") {
    const [first, ...rest] = record.label.split(" ");
    return <Avatar firstName={first} lastName={rest.join(" ")} className="size-4 text-[0.4375rem]" />;
  }
  return <Handshake className="size-3.5 shrink-0 text-muted-foreground" />;
}

const chipClass = "inline-flex h-5 max-w-[12rem] shrink-0 items-center gap-1 rounded-xs bg-secondary pl-0.5 pr-1.5 text-[0.8125rem] leading-5 text-foreground";

/** A linked record: its icon and name, a link to it when it has a page. `link={false}` inside another control. */
export function RecordChip({ entity, record, link = true }: { entity: EntityType; record: RelationRecord; link?: boolean }) {
  const body = (
    <>
      <RecordIcon entity={entity} record={record} />
      <span className="truncate">{record.label || "Untitled"}</span>
    </>
  );
  const href = link ? recordHref(entity, record.id) : undefined;
  if (!href) return <span className={chipClass}>{body}</span>;
  return (
    <a
      href={href}
      onClick={(e) => {
        e.stopPropagation();
        if (plainClick(e)) { e.preventDefault(); go(href); }
      }}
      className={cn(chipClass, "hover:bg-border/60")}
    >
      {body}
    </a>
  );
}

const readRelation = (row: unknown, key: string): RelationValue | undefined =>
  (row as { relations?: Record<string, RelationValue> } | undefined)?.relations?.[key];

const dash = <span className="text-muted-foreground">—</span>;

/** A relation field in a table cell: the linked record, or the first two and "+N". */
export function RelationCell({ def, row }: { def: CustomFieldDef; row: unknown }) {
  const v = readRelation(row, def.key);
  const entity = def.target_entity!;
  if (!v) return dash;
  if (!("items" in v)) return <RecordChip entity={entity} record={v} />;
  if (!v.total) return dash;
  const extra = v.total - Math.min(2, v.items.length);
  return (
    <span className="flex min-w-0 items-center gap-1">
      {v.items.slice(0, 2).map((r) => <RecordChip key={r.id} entity={entity} record={r} />)}
      {extra > 0 && <span className="shrink-0 text-xs text-muted-foreground">+{extra}</span>}
    </span>
  );
}

/** A relation field as plain text, for CSV export. */
export function relationText(def: CustomFieldDef, row: unknown): string {
  const v = readRelation(row, def.key);
  if (!v) return "";
  if (!("items" in v)) return v.label;
  return v.items.map((r) => r.label).join(", ") + (v.total > v.items.length ? ` +${v.total - v.items.length}` : "");
}

/** A relation field's table column. Only the many_to_one side sorts (by the
 *  linked record's name) and calculates: the other side has no column. */
export function relationColumn<T>(def: CustomFieldDef): RecordColumn<T> {
  const one = def.relation_type === "many_to_one";
  return {
    key: def.key, label: def.label, sort: one ? def.key : undefined, kind: "text", calculate: one,
    text: (row) => relationText(def, row),
    render: (row) => <RelationCell def={def} row={row} />,
  };
}

// ── Picker ────────────────────────────────────────────────────────────

/**
 * Search `entity`'s records by name and pick one. The records in `selected`
 * are highlighted (never ticked) and listed first; picking one of them again
 * is how it's removed. With `onClear`, a first row ("No company") empties a
 * single value, highlighted while nothing is picked.
 */
export function RecordPicker({ entity, selected, onPick, onClear, emptyLabel, placeholder }: {
  entity: EntityType;
  selected: string[];
  onPick: (record: RelationRecord) => void;
  onClear?: () => void;
  emptyLabel?: string;
  placeholder?: string;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<RelationRecord[] | null>(null);
  const name = useRecordNames(selected.map((id) => ({ entity, id })));

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      searchRecords(entity, search).then((r) => { if (alive) setResults(r); }, () => { if (alive) setResults([]); });
    }, search ? 200 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [entity, search]);

  const chosen = search ? [] : selected.map((id) => name(entity, id)).filter((r): r is RelationRecord => !!r);
  // While the next search is on its way, the last results narrow to what's typed,
  // so Enter never picks a record that no longer matches.
  const needle = search.trim().toLowerCase();
  const matches = (results ?? []).filter((r) => r.label.toLowerCase().includes(needle));
  const items = [...chosen, ...matches.filter((r) => !chosen.some((c) => c.id === r.id))];

  return (
    <Command shouldFilter={false}>
      <CommandInput autoFocus value={search} onValueChange={setSearch} placeholder={placeholder ?? "Search…"} />
      <CommandList>
        {results === null
          ? <div className="py-4 text-center text-[13px] text-muted-foreground">Loading…</div>
          : <CommandEmpty>No match.</CommandEmpty>}
        <CommandGroup>
          {onClear && !search && (
            <CommandItem value="__none" onSelect={onClear} aria-selected={!selected.length} className={cn(!selected.length && "bg-secondary font-medium")}>
              <Ban className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{emptyLabel ?? "None"}</span>
            </CommandItem>
          )}
          {items.map((r) => {
            const on = selected.includes(r.id);
            return (
              <CommandItem key={r.id} value={r.id} onSelect={() => onPick(r)} aria-selected={on} className={cn(on && "bg-secondary font-medium")}>
                <RecordIcon entity={entity} record={r} />
                <span className="truncate">{r.label || "Untitled"}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

// ── Value control ─────────────────────────────────────────────────────

/**
 * A many_to_one value as its own control: the linked record's chip (or the
 * placeholder), which opens the picker. `emptyLabel` ("No company") is the
 * picker's row for clearing it. `known` names the current value without a fetch.
 */
export function RelationInput({ entity, value, onChange, placeholder = "Select…", emptyLabel, known, className }: {
  entity: EntityType;
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  emptyLabel?: string;
  known?: RelationRecord | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const name = useRecordNames(value && known?.id !== value ? [{ entity, id: value }] : []);
  const record = value ? (known?.id === value ? known : name(entity, value)) : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={placeholder} className={cn("flex h-8 w-full min-w-0 items-center rounded-[0.5rem] px-2 text-left text-sm hover:bg-secondary", className)}>
          {record ? <RecordChip entity={entity} record={record} link={false} />
            : value ? <span className="text-muted-foreground">{record === null ? "Deleted record" : "…"}</span>
            : <span className="text-faint">{placeholder}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <RecordPicker
          entity={entity}
          selected={value ? [value] : []}
          emptyLabel={emptyLabel}
          onClear={() => { setOpen(false); onChange(null); }}
          onPick={(r) => { setOpen(false); onChange(r.id === value ? null : r.id); }}
        />
      </PopoverContent>
    </Popover>
  );
}
