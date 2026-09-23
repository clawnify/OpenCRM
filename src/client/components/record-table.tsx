import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Copy, Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

/**
 * How a cell edits in place: click the value (no pencil). "text" puts an input
 * over the cell, saved on Enter or a click away and dropped on Escape; "menu"
 * opens a list under the cell (a status, a linked record), given `close`.
 */
export type CellEdit<T> =
  | { type: "text"; value: (row: T) => string; save: (row: T, value: string) => Promise<void>; input?: "text" | "email" | "tel" | "number" | "date" }
  | { type: "menu"; render: (row: T, close: () => void) => ReactNode };

/** A column the viewer can show, hide and resize. `key` is its id in the saved view. */
export interface RecordColumn<T> {
  key: string;
  label: string;
  kind?: ColumnKind;
  /** Server sort key; omit for a column that can't be sorted. */
  sort?: string;
  align?: "right";
  /** False for a column with nothing for the footer to calculate on (no column of its own). */
  calculate?: boolean;
  /** Edits the value in the cell; without it a click on the cell opens the record. */
  edit?: CellEdit<T>;
  /** The value a hover "copy" button copies (an email, a phone number). */
  copy?: (row: T) => string;
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
  // The cell being edited, as "rowId:columnKey".
  const [editing, setEditing] = useState<string | null>(null);
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
          <TableHead width={44} className="px-1 shadow-[inset_0_-1px_0_var(--rule)]">
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
              {shown.map((c) => c.edit ? (
                <EditableCell
                  key={c.key}
                  column={c}
                  edit={c.edit}
                  row={row}
                  editing={editing === `${row.id}:${c.key}`}
                  onEdit={() => setEditing(`${row.id}:${c.key}`)}
                  onDone={() => setEditing(null)}
                />
              ) : (
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
              {c.calculate !== false && <AggregatePicker label={c.label} kind={c.kind ?? "text"} op={view.aggregate(c.key)} value={totals[c.key]} onChange={(op) => view.setAggregate(c.key, op)} />}
            </TableCell>
          ))}
          <TableCell colSpan={2} className={footCell} />
        </TableRow>
      </tfoot>
    </Table>
  );
}

/** A cell whose value edits in place. Hover outlines it; click or Enter edits. */
function EditableCell<T extends { id: string }>({ column, edit, row, editing, onEdit, onDone }: {
  column: RecordColumn<T>;
  edit: CellEdit<T>;
  row: T;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const cell = useRef<HTMLTableCellElement>(null);
  // Escape drops a text edit; any other way out (Enter, a click away) keeps it.
  const cancelled = useRef(false);
  const size = editing && cell.current ? { w: cell.current.offsetWidth, h: cell.current.offsetHeight } : null;
  const open = () => { cancelled.current = false; onEdit(); };
  return (
    <Popover open={editing} onOpenChange={(o) => { if (!o) onDone(); }}>
      <PopoverAnchor asChild>
        <TableCell
          ref={cell}
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); open(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); open(); } }}
          className={cn(
            column.align === "right" && "text-right",
            "group/cell relative cursor-pointer outline-none hover:shadow-[inset_0_0_0_1px_var(--border)] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]",
          )}
        >
          {column.render(row)}
          {column.copy?.(row) && <CopyButton value={column.copy(row)} />}
        </TableCell>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        // A text editor sits on the cell itself; a list opens just under it.
        sideOffset={edit.type === "text" ? -(size?.h ?? 32) : 2}
        style={{ minWidth: size?.w, width: edit.type === "menu" ? Math.max(size?.w ?? 0, 256) : undefined }}
        onClick={(e) => e.stopPropagation()}
        onEscapeKeyDown={() => { cancelled.current = true; }}
      >
        {edit.type === "text"
          ? <TextCellEditor initial={edit.value(row)} input={edit.input} height={size?.h} cancelled={cancelled} onSave={(v) => edit.save(row, v)} onDone={onDone} />
          : edit.render(row, onDone)}
      </PopoverContent>
    </Popover>
  );
}

/** Copies a cell's value; shown on the cell's hover, always for an agent. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : `Copy ${value}`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="absolute right-1 top-1/2 inline-flex h-6 -translate-y-1/2 items-center gap-1 rounded-sm bg-card px-1.5 text-xs text-muted-foreground opacity-0 shadow-raised hover:text-foreground focus-visible:opacity-100 group-hover/cell:opacity-100 [[data-agent]_&]:opacity-100"
    >
      <Copy className="size-3.5" />
      {copied && "Copied"}
    </button>
  );
}

/** The input over a text cell. Saves when it goes away, unless Escape sent it. */
function TextCellEditor({ initial, input = "text", height, cancelled, onSave, onDone }: {
  initial: string;
  input?: "text" | "email" | "tel" | "number" | "date";
  height?: number;
  cancelled: { current: boolean };
  onSave: (value: string) => Promise<void>;
  onDone: () => void;
}) {
  const [value, setValue] = useState(initial);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => () => {
    const next = latest.current.trim();
    if (!cancelled.current && next !== initial.trim()) void onSave(next);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      autoFocus
      type={input}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => { if (input !== "date" && input !== "number") e.currentTarget.select(); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onDone(); } }}
      style={{ height }}
      className="w-full rounded-md bg-card px-3 text-[0.8125rem] outline-none"
    />
  );
}

const footCell = "sticky bottom-0 z-20 bg-background shadow-[inset_0_1px_0_var(--rule)]";

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
                <CommandItem key={a} value={a} onSelect={() => pick(a)} aria-selected={a === op} className={cn(a === op && "bg-secondary font-medium")}>
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
                    {c.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {shown.length > 0 && (
              <CommandGroup heading="Shown">
                {shown.map((c) => (
                  <CommandItem key={c.key} value={c.label} onSelect={() => view.setVisible(c.key, false)}>
                    {c.label}
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
