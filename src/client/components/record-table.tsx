import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { TableView } from "@/hooks/use-table-view";
import { cn } from "@/lib/utils";

/** What a column holds, which decides the calculations its footer offers. */
export type ColumnKind = "text" | "number" | "date" | "boolean";

/** A custom field's column kind, from its storage type. */
export function columnKind(fieldType: string): ColumnKind {
  if (fieldType === "integer" || fieldType === "decimal") return "number";
  if (fieldType === "date" || fieldType === "datetime") return "date";
  if (fieldType === "boolean") return "boolean";
  return "text";
}

/** A column the viewer can show, hide and resize. `key` is its id in the saved view. */
export interface RecordColumn<T> {
  key: string;
  label: string;
  kind?: ColumnKind;
  /** Server sort key; omit for a column that can't be sorted. */
  sort?: string;
  align?: "right";
  render: (row: T) => ReactNode;
  /** The value as plain text, for CSV export. */
  text: (row: T) => string;
}

/** The pinned first column: the record's name, a real link to the record. */
export interface NameColumn<T> {
  label: string;
  sort: string;
  render: (row: T) => ReactNode;
  text: (row: T) => string;
  href: (row: T) => string;
}

interface Sorting {
  sort: string;
  order: "asc" | "desc";
}

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const checkbox = "size-3.5 shrink-0 cursor-pointer accent-[var(--foreground)] [[data-agent]_&]:size-5";

/**
 * The record list: a grid with the name pinned left and the
 * header pinned top, checkboxes for bulk actions, columns the viewer resizes
 * and hides from the "+" at the end of the header, and a row click that opens
 * the record. The layout lives in `view` (shared, server-side).
 */
export function RecordTable<T extends { id: string }>({
  rows,
  name,
  columns,
  view,
  sorting,
  onSort,
  openId,
  onOpen,
  selected,
  onSelectedChange,
  onCustomize,
  totals,
  onAdd,
}: {
  rows: T[];
  name: NameColumn<T>;
  columns: RecordColumn<T>[];
  view: TableView;
  sorting: Sorting;
  onSort: (col: string) => void;
  openId?: string;
  onOpen: (id: string) => void;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  onCustomize: () => void;
  /** The footer's computed values, by column key (see useAggregates). */
  totals: Record<string, number | string | null>;
  /** The "+ Add new" row under the records: opens the create dialog. */
  onAdd: () => void;
}) {
  const shown = columns.filter((c) => view.visible(c.key));
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someChecked = !allChecked && rows.some((r) => selected.has(r.id));

  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = someChecked;
  }, [someChecked]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };

  const sizing = (key: string) => ({
    width: view.width(key),
    onResize: (w: number) => view.resize(key, w),
    onResizeEnd: (w: number) => view.commitWidth(key, w),
  });

  return (
    <Table grid containerClassName="h-full">
      <TableHeader sticky>
        <TableRow>
          <TableHead pinned {...sizing("name")}>
            <span className="flex items-center gap-2.5">
              <input
                ref={selectAll}
                type="checkbox"
                className={checkbox}
                checked={allChecked}
                onChange={() => onSelectedChange(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
                aria-label={allChecked ? "Deselect all rows" : "Select all rows"}
              />
              <SortLabel label={name.label} col={name.sort} sorting={sorting} onSort={onSort} />
            </span>
          </TableHead>
          {shown.map((c) => (
            <TableHead key={c.key} className={cn(c.align === "right" && "text-right")} {...sizing(c.key)}>
              <SortLabel label={c.label} col={c.sort} sorting={sorting} onSort={onSort} />
            </TableHead>
          ))}
          {/* The "+": no rule on its right, so it reads as the end of the columns. */}
          <TableHead width={44} className="px-1 shadow-[inset_0_-1px_0_var(--border)]">
            <ColumnPicker columns={columns} view={view} onCustomize={onCustomize} />
          </TableHead>
          {/* Takes the slack, so the columns keep their widths. */}
          <TableHead aria-hidden="true" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const checked = selected.has(row.id);
          return (
            <TableRow
              key={row.id}
              data-state={checked || row.id === openId ? "selected" : undefined}
              className="cursor-pointer hover:bg-secondary"
              onClick={() => onOpen(row.id)}
            >
              <TableCell pinned>
                <span className="flex min-w-0 items-center gap-2.5">
                  <input
                    type="checkbox"
                    className={checkbox}
                    checked={checked}
                    onChange={() => toggle(row.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${name.text(row) || "row"}`}
                  />
                  {/* A real link: a plain click opens the panel, cmd/ctrl-click a new tab. */}
                  <a
                    href={name.href(row)}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!plainClick(e)) return;
                      e.preventDefault();
                      onOpen(row.id);
                    }}
                    className="flex min-w-0 items-center gap-2 font-medium hover:underline"
                  >
                    {name.render(row)}
                  </a>
                </span>
              </TableCell>
              {shown.map((c) => (
                <TableCell key={c.key} className={cn(c.align === "right" && "text-right")}>{c.render(row)}</TableCell>
              ))}
              <TableCell className="shadow-none" />
              <TableCell aria-hidden="true" />
            </TableRow>
          );
        })}
        <TableRow className="hover:bg-secondary">
          <TableCell pinned className="shadow-none">
            <button type="button" onClick={onAdd} className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
              <Plus className="size-3.5" /> Add new
            </button>
          </TableCell>
          <TableCell colSpan={shown.length + 2} className="shadow-none" />
        </TableRow>
      </TableBody>
      {/* Calculate: one total per column over the whole filtered list, held at
          the bottom while the rows scroll. Hover shows the empty ones' picker. */}
      <tfoot>
        <TableRow className="group/foot border-0 hover:bg-transparent">
          {/* The corner: above both the footer row and the pinned column. */}
          <TableCell pinned className={cn(footCell, "z-30 group-hover:bg-background")}>
            <AggregatePicker label={name.label} kind="text" op={view.aggregate("name")} value={totals.name} onChange={(op) => view.setAggregate("name", op)} alwaysShown />
          </TableCell>
          {shown.map((c) => (
            <TableCell key={c.key} className={cn(footCell, c.align === "right" && "text-right")}>
              <AggregatePicker label={c.label} kind={c.kind ?? "text"} op={view.aggregate(c.key)} value={totals[c.key]} onChange={(op) => view.setAggregate(c.key, op)} />
            </TableCell>
          ))}
          <TableCell colSpan={2} className={footCell} />
        </TableRow>
      </tfoot>
    </Table>
  );
}

const footCell = "sticky bottom-0 z-20 bg-background shadow-[inset_0_1px_0_var(--border)]";

const BASE_AGGREGATES = ["count", "count_empty", "count_not_empty", "count_unique", "percent_empty", "percent_not_empty"];
const AGGREGATES_FOR: Record<ColumnKind, string[]> = {
  text: BASE_AGGREGATES,
  number: [...BASE_AGGREGATES, "sum", "avg", "min", "max"],
  date: [...BASE_AGGREGATES, "earliest", "latest"],
  boolean: [...BASE_AGGREGATES, "count_true", "count_false"],
};
// Menu label, then the short form the footer prints before "of <column>".
const AGGREGATE_LABELS: Record<string, [string, string]> = {
  count: ["Count all", "Count all"],
  count_empty: ["Count empty", "Empty"],
  count_not_empty: ["Count not empty", "Not empty"],
  count_unique: ["Count unique values", "Unique"],
  percent_empty: ["Percent empty", "Empty"],
  percent_not_empty: ["Percent not empty", "Not empty"],
  sum: ["Sum", "Sum"],
  avg: ["Average", "Average"],
  min: ["Min", "Min"],
  max: ["Max", "Max"],
  earliest: ["Earliest date", "Earliest"],
  latest: ["Latest date", "Latest"],
  count_true: ["Count true", "True"],
  count_false: ["Count false", "False"],
};

function formatTotal(op: string, v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (op.startsWith("percent_")) return `${v}%`;
  if (op === "earliest" || op === "latest") {
    const d = new Date(String(v).replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
  }
  return typeof v === "number" ? v.toLocaleString() : String(v);
}

/** One footer cell: "Calculate ⌄" until a calculation is picked, then "Empty of Email 12%". */
function AggregatePicker({ label, kind, op, value, onChange, alwaysShown = false }: {
  label: string;
  kind: ColumnKind;
  op: string | null;
  value: number | string | null | undefined;
  onChange: (op: string | null) => void;
  alwaysShown?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pick = (next: string | null) => { setOpen(false); onChange(next); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex max-w-full items-center gap-1 text-muted-foreground hover:text-foreground",
            // An unset cell shows only on hover (and always for an agent, DESIGN.md → Agent mode).
            !op && !alwaysShown && !open && "opacity-0 group-hover/foot:opacity-100 focus-visible:opacity-100 [[data-agent]_&]:opacity-100",
          )}
        >
          {op ? (
            // In a narrow column the label gives way; the number never does.
            <>
              <span className="truncate">{op === "count" ? "Count all" : `${AGGREGATE_LABELS[op]?.[1] ?? op} of ${label}`}</span>
              <span className="tabular shrink-0 text-foreground">{formatTotal(op, value)}</span>
            </>
          ) : (
            <>Calculate <ChevronDown className="size-3.5" /></>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56">
        <Command>
          <CommandList>
            <CommandGroup>
              {op && (
                <CommandItem value="none" onSelect={() => pick(null)} className="text-muted-foreground">None</CommandItem>
              )}
              {AGGREGATES_FOR[kind].map((a) => (
                <CommandItem key={a} value={a} onSelect={() => pick(a)}>
                  <Check className={cn("size-3.5", a === op ? "opacity-100" : "opacity-0")} />
                  {AGGREGATE_LABELS[a][0]}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SortLabel({ label, col, sorting, onSort }: { label: string; col?: string; sorting: Sorting; onSort: (col: string) => void }) {
  if (!col) return <>{label}</>;
  const active = sorting.sort === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      aria-label={`Sort by ${label}`}
      className={cn("inline-flex max-w-full items-center gap-1 hover:text-foreground", active && "text-foreground")}
    >
      <span className="truncate">{label}</span>
      {active && (sorting.order === "asc" ? <ChevronUp className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />)}
    </button>
  );
}

/** The "+" after the last column: search the fields, show or hide each, or go edit them. */
function ColumnPicker<T>({ columns, view, onCustomize }: { columns: RecordColumn<T>[]; view: TableView; onCustomize: () => void }) {
  const [open, setOpen] = useState(false);
  const shown = columns.filter((c) => view.visible(c.key));
  const hidden = columns.filter((c) => !view.visible(c.key));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Show or hide columns" title="Show or hide columns">
          <Plus className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <Command>
          <CommandInput placeholder="Search fields…" />
          <CommandList>
            <CommandEmpty>No fields match.</CommandEmpty>
            {hidden.length > 0 && (
              <CommandGroup heading="Hidden">
                {hidden.map((c) => (
                  <CommandItem key={c.key} value={c.label} onSelect={() => view.setVisible(c.key, true)}>
                    <Plus className="size-3.5 text-muted-foreground" /> {c.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {shown.length > 0 && (
              <CommandGroup heading="Shown">
                {shown.map((c) => (
                  <CommandItem key={c.key} value={c.label} onSelect={() => view.setVisible(c.key, false)}>
                    <Check className="size-3.5" /> {c.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {/* Always offered, whatever the search: the way out to edit the fields themselves. */}
            <CommandGroup forceMount className="border-t border-border">
              <CommandItem forceMount value="Customize fields" onSelect={() => { setOpen(false); onCustomize(); }}>
                <Settings2 className="size-3.5 text-muted-foreground" /> Customize fields
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
