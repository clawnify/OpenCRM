import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, Filter as FilterIcon, ListFilter, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  OPERATORS, isGroup, needsValue, newRule, isComplete, describeRule, parseRelative, formatRelative,
  type FieldType, type FilterField, type FilterGroup, type FilterNode, type FilterRule, type Direction, type Unit,
} from "@/lib/filters";
import { RecordPicker, useRecordNames } from "@/lib/relations";
import { cn } from "@/lib/utils";
import type { EntityType, RelationRecord } from "@/types";

// Which popover is open: the "+ Filter" menu, a basic rule's chip, or the advanced editor.
type Open = { kind: "add"; editing?: number } | { kind: "rule"; index: number } | { kind: "advanced" } | null;

const chip = "inline-flex h-7 items-center gap-1 rounded-sm bg-card pl-2 pr-1 text-[0.8125rem] shadow-raised hover:bg-secondary";

/**
 * The list's view row: the view switcher (`leading`), one chip per basic
 * filter, one "N advanced rules" chip, "+ Filter", and Reset / Update view
 * while the list differs from its view. Editing applies at once; a rule still
 * being typed is left out of the query until it has a value.
 */
export function FilterBar({ leading, fields: baseFields, filters, onChange, isVisible, dirty, onSave, onReset, locked = false, onSaveAs }: {
  leading?: ReactNode;
  fields: FilterField[];
  filters: FilterNode[];
  onChange: (next: FilterNode[]) => void;
  /** Whether a column shows in the table, to split the field list into Visible / Hidden. */
  isVisible: (column: string) => boolean;
  dirty: boolean;
  onSave: () => void;
  onReset: () => void;
  /** The view can't take changes (the default "All …" view): offer a new view instead of Update view. */
  locked?: boolean;
  onSaveAs?: (name: string) => Promise<void>;
}) {
  // Relation rules hold record ids; their chips and lists show the records' names.
  const name = useRecordNames(relationValues(baseFields, filters));
  const fields = baseFields.map((f): FilterField =>
    f.type === "relation" && f.entity ? { ...f, labelOf: (v) => recordLabel(name(f.entity!, v)) } : f);
  const [open, setOpen] = useState<Open>(null);
  // Set while the "+ Filter" menu hands over to the advanced editor, so the
  // menu doesn't pull focus back to its button and close the editor.
  const handoff = useRef(false);
  const fieldOf = (key: string) => fields.find((f) => f.key === key);
  const advancedIndex = filters.findIndex(isGroup);
  const advanced = advancedIndex >= 0 ? (filters[advancedIndex] as FilterGroup) : null;

  const replace = (i: number, node: FilterNode | null) =>
    onChange(node ? filters.map((n, j) => (j === i ? node : n)) : filters.filter((_, j) => j !== i));

  // Closing a popover drops a basic chip left without a value. Unfinished
  // advanced rows stay where they are to be finished; the query skips them.
  const close = () => {
    setOpen(null);
    const kept = filters.filter((n) => isGroup(n) || isComplete(n));
    if (kept.length !== filters.length) onChange(kept);
  };
  const onOpenChange = (next: Open) => (o: boolean) => (o ? setOpen(next) : close());

  const pickField = (field: FilterField) => {
    // One basic chip per field: picking a filtered field again edits its chip.
    const existing = filters.findIndex((n) => !isGroup(n) && n.field === field.key);
    if (existing >= 0) return setOpen({ kind: "add", editing: existing });
    onChange([...filters, newRule(field)]);
    setOpen({ kind: "add", editing: filters.length });
  };

  const openAdvanced = () => {
    if (!advanced) onChange([...filters, { logic: "and", rules: [newRule(fields[0])] }]);
    // Next tick: opened during this click, the editor would take the click as outside and close.
    handoff.current = true;
    setOpen(null);
    setTimeout(() => setOpen({ kind: "advanced" }), 0);
  };

  // The rule the "+ Filter" menu is editing after a field was picked, if any.
  const addEditing = open?.kind === "add" && open.editing !== undefined ? filters[open.editing] : undefined;
  const addRule = addEditing && !isGroup(addEditing) ? addEditing : undefined;
  const addField = addRule ? fieldOf(addRule.field) : undefined;

  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-6 py-1.5">
      {leading}
      {leading && filters.length > 0 && <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />}
      {filters.map((n, i) => {
        if (isGroup(n)) return null;
        const field = fieldOf(n.field);
        return (
          <Popover key={i} open={open?.kind === "rule" && open.index === i} onOpenChange={onOpenChange({ kind: "rule", index: i })}>
            <span className={chip}>
              <PopoverTrigger asChild>
                <button type="button" className="max-w-[20rem] truncate" aria-label={`Edit filter ${describeRule(n, field)}`}>
                  {isComplete(n) ? describeRule(n, field) : `${field?.label ?? n.field}: …`}
                </button>
              </PopoverTrigger>
              <button type="button" onClick={() => replace(i, null)} aria-label="Remove filter" className="rounded-xs p-0.5 text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            </span>
            <PopoverContent align="start" className="w-72">
              {field && <RuleEditor field={field} rule={n} onChange={(r) => replace(i, r)} />}
            </PopoverContent>
          </Popover>
        );
      })}

      {advanced && (
        <Popover open={open?.kind === "advanced"} onOpenChange={onOpenChange({ kind: "advanced" })}>
          <span className={chip}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1">
                <ListFilter className="size-3.5 text-muted-foreground" />
                {advanced.rules.length} advanced {advanced.rules.length === 1 ? "rule" : "rules"}
              </button>
            </PopoverTrigger>
            <button type="button" onClick={() => replace(advancedIndex, null)} aria-label="Remove advanced filter" className="rounded-xs p-0.5 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </span>
          <PopoverContent align="start" className="w-[44rem] max-w-[calc(100vw-2rem)] p-3">
            <GroupEditor fields={fields} isVisible={isVisible} group={advanced} depth={0} onChange={(g) => replace(advancedIndex, g)} />
          </PopoverContent>
        </Popover>
      )}

      {/* Right end: Reset / Update view while the list differs from its view, then Filter. */}
      <div className="ml-auto flex items-center gap-2">
        {dirty && (
          <>
            <Button size="sm" variant="ghost" onClick={onReset}>Reset</Button>
            {locked
              ? onSaveAs && <SaveAsView onSave={onSaveAs} />
              : <Button size="sm" variant="secondary" onClick={onSave}>Update view</Button>}
          </>
        )}
        <Popover open={open?.kind === "add"} onOpenChange={onOpenChange({ kind: "add" })}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost">
              <FilterIcon className="size-4" />
              Filter
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-72"
            onCloseAutoFocus={(e) => { if (handoff.current) { e.preventDefault(); handoff.current = false; } }}
          >
            {open?.kind === "add" && open.editing !== undefined && addRule && addField ? (
              <RuleEditor
                field={addField}
                rule={addRule}
                onChange={(r) => replace(open.editing!, r)}
                onBack={() => { close(); setOpen({ kind: "add" }); }}
              />
            ) : (
              <FieldList fields={fields} isVisible={isVisible} onPick={pickField} footer={
                <CommandGroup forceMount className="border-t border-border">
                  <CommandItem forceMount value="Advanced filter" onSelect={openAdvanced}>
                    <ListFilter className="size-3.5 text-muted-foreground" /> Advanced filter
                  </CommandItem>
                </CommandGroup>
              } />
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

/** "Save as new view": a name, then Create. The list as it is now becomes that view. */
function SaveAsView({ onSave }: { onSave: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      await onSave(n);
      setOpen(false);
      setName("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="secondary">Save as new view</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <form onSubmit={submit} className="flex flex-col gap-2 p-2">
          <Input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="View name" aria-label="View name" className="h-8" />
          <p className="px-0.5 text-xs text-muted-foreground">Keeps these filters, sort and columns. Everyone in the org will see it.</p>
          <Button type="submit" size="sm" disabled={busy || !name.trim()} className="w-full">Create</Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Searchable field list, split into the columns the table shows and the ones it hides. */
function FieldList({ fields, isVisible, onPick, footer }: {
  fields: FilterField[];
  isVisible: (column: string) => boolean;
  onPick: (f: FilterField) => void;
  footer?: ReactNode;
}) {
  // A field that is no column of the table (Created) counts as hidden.
  const shown = fields.filter((f) => f.column && isVisible(f.column));
  const hidden = fields.filter((f) => !f.column || !isVisible(f.column));
  return (
    <Command>
      <CommandInput placeholder="Search fields…" autoFocus />
      <CommandList>
        <CommandEmpty>No fields match.</CommandEmpty>
        {[{ heading: "Visible fields", list: shown }, { heading: "Hidden fields", list: hidden }].map(({ heading, list }) =>
          list.length > 0 && (
            <CommandGroup key={heading} heading={heading}>
              {list.map((f) => (
                <CommandItem key={f.key} value={`${f.label} ${f.key}`} onSelect={() => onPick(f)}>{f.label}</CommandItem>
              ))}
            </CommandGroup>
          ),
        )}
        {footer}
      </CommandList>
    </Command>
  );
}

/** One rule, as a chip's popover: the field, its operator, then the value. */
/** Every record id a relation rule in the tree holds, with its entity. */
function relationValues(fields: FilterField[], nodes: FilterNode[]): Array<{ entity: EntityType; id: string }> {
  return nodes.flatMap((n) => {
    if (isGroup(n)) return relationValues(fields, n.rules);
    const entity = fields.find((f) => f.key === n.field && f.type === "relation")?.entity;
    return entity && Array.isArray(n.value) ? n.value.map((id) => ({ entity, id })) : [];
  });
}

const recordLabel = (r: RelationRecord | null | undefined) => (r ? r.label || "Untitled" : r === null ? "Deleted record" : "…");

function RuleEditor({ field, rule, onChange, onBack }: {
  field: FilterField;
  rule: FilterRule;
  onChange: (r: FilterRule) => void;
  onBack?: () => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex h-9 items-center gap-1 border-b border-border px-2 text-[0.8125rem] font-medium">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to fields" className="rounded-xs p-0.5 text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" />
          </button>
        )}
        {field.label}
      </div>
      <div className="flex flex-col gap-2 p-2">
        <OperatorPicker type={field.type} rule={rule} onChange={onChange} />
        <ValueInput key={rule.op} field={field} rule={rule} onChange={onChange} autoFocus />
      </div>
    </div>
  );
}

const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** Switching operator keeps the value when it still fits, and resets it when it doesn't. */
function withOp(field: FilterField, rule: FilterRule, op: string): FilterRule {
  if (!needsValue(op)) return { field: rule.field, op };
  if (field.type === "date") {
    if (op === "relative") return { field: rule.field, op, value: rule.op === "relative" ? rule.value : "PAST_7_DAY" };
    const day = typeof rule.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rule.value) ? rule.value : todayISO();
    return { field: rule.field, op, value: day };
  }
  if (field.type === "enum" || field.type === "relation") return { field: rule.field, op, value: Array.isArray(rule.value) ? rule.value : [] };
  return { ...rule, op, value: rule.value ?? "" };
}

function Picker({ label, items, value, onPick, className }: {
  label: ReactNode;
  items: { value: string; label: string }[];
  value?: string;
  onPick: (v: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("inline-flex h-8 items-center justify-between gap-1 rounded-sm bg-secondary px-2 text-[0.8125rem]", className)}>
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56">
        <Command>
          {items.length > 8 && <CommandInput placeholder="Search…" />}
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {items.map((it) => (
                <CommandItem key={it.value} value={`${it.label} ${it.value}`} onSelect={() => { setOpen(false); onPick(it.value); }} aria-selected={it.value === value} className={cn(it.value === value && "bg-secondary font-medium")}>
                  {it.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function OperatorPicker({ type, rule, onChange, className }: { type: FieldType; rule: FilterRule; onChange: (r: FilterRule) => void; className?: string }) {
  const ops = OPERATORS[type];
  return (
    <Picker
      className={cn("w-full", className)}
      label={ops.find((o) => o.op === rule.op)?.label ?? rule.op}
      value={rule.op}
      items={ops.map((o) => ({ value: o.op, label: o.label }))}
      onPick={(op) => onChange(withOp({ key: rule.field, label: "", type }, rule, op))}
    />
  );
}

/** The value control for a rule's field type and operator. */
function ValueInput({ field, rule, onChange, autoFocus = false, inline = false }: {
  field: FilterField;
  rule: FilterRule;
  onChange: (r: FilterRule) => void;
  autoFocus?: boolean;
  /** In an advanced row: lists open from a trigger instead of showing in place. */
  inline?: boolean;
}) {
  if (!needsValue(rule.op)) return null;

  if (field.type === "enum" || field.type === "boolean") {
    const multi = field.type === "enum";
    const selected = Array.isArray(rule.value) ? rule.value : rule.value ? [rule.value] : [];
    const toggle = (v: string) => {
      if (!multi) return onChange({ ...rule, value: v });
      onChange({ ...rule, value: selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v] });
    };
    const list = (
      <Command>
        {(field.options?.length ?? 0) > 8 && <CommandInput placeholder={`Search ${field.label.toLowerCase()}…`} />}
        <CommandList>
          <CommandEmpty>No options.</CommandEmpty>
          <CommandGroup>
            {(field.options ?? []).map((o) => (
              <CommandItem key={o.value} value={`${o.label} ${o.value}`} onSelect={() => toggle(o.value)} aria-selected={selected.includes(o.value)} className={cn(selected.includes(o.value) && "bg-secondary font-medium")}>
                {o.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    );
    if (!inline) return <div className="-mx-2 border-t border-border pt-1">{list}</div>;
    const label = selected.map((v) => field.options?.find((o) => o.value === v)?.label ?? v).join(", ") || "Select…";
    return <InlineList label={label}>{list}</InlineList>;
  }

  if (field.type === "relation" && field.entity) {
    const selected = Array.isArray(rule.value) ? rule.value : [];
    const picker = (
      <RecordPicker
        entity={field.entity}
        selected={selected}
        placeholder={`Search ${field.label.toLowerCase()}…`}
        onPick={(r) => onChange({ ...rule, value: selected.includes(r.id) ? selected.filter((x) => x !== r.id) : [...selected, r.id] })}
      />
    );
    if (!inline) return <div className="-mx-2 border-t border-border">{picker}</div>;
    return <InlineList label={selected.map((v) => field.labelOf?.(v) ?? v).join(", ") || "Select…"}>{picker}</InlineList>;
  }

  if (field.type === "date") {
    if (rule.op === "relative") return <RelativeInput value={rule.value} onChange={(v) => onChange({ ...rule, value: v })} />;
    return (
      <Input
        type="date"
        autoFocus={autoFocus}
        value={typeof rule.value === "string" ? rule.value : ""}
        onChange={(e) => onChange({ ...rule, value: e.target.value })}
        className="h-8"
        aria-label={`${field.label} date`}
      />
    );
  }

  return <TextValue rule={rule} numeric={field.type === "number"} label={field.label} autoFocus={autoFocus} onChange={onChange} />;
}

function InlineList({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-8 min-w-0 flex-1 items-center justify-between gap-1 rounded-sm bg-secondary px-2 text-[0.8125rem]">
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56">{children}</PopoverContent>
    </Popover>
  );
}

// Applies on every keystroke: the page waits for a pause before refetching, so
// the rule is never behind what was typed when its popover closes.
function TextValue({ rule, numeric, label, autoFocus, onChange }: {
  rule: FilterRule;
  numeric: boolean;
  label: string;
  autoFocus: boolean;
  onChange: (r: FilterRule) => void;
}) {
  return (
    <Input
      type={numeric ? "number" : "text"}
      autoFocus={autoFocus}
      value={typeof rule.value === "string" ? rule.value : ""}
      onChange={(e) => onChange({ ...rule, value: e.target.value })}
      placeholder={label}
      className="h-8 min-w-0 flex-1"
      aria-label={`${label} value`}
    />
  );
}

const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: "PAST", label: "Past" },
  { value: "NEXT", label: "Next" },
  { value: "THIS", label: "This" },
];
const UNITS: { value: Unit; label: string }[] = [
  { value: "DAY", label: "Days" },
  { value: "WEEK", label: "Weeks" },
  { value: "MONTH", label: "Months" },
  { value: "YEAR", label: "Years" },
];

/** "Past 7 days", "Next 2 weeks", "This month". */
function RelativeInput({ value, onChange }: { value: FilterRule["value"]; onChange: (v: string) => void }) {
  const r = parseRelative(value);
  const set = (patch: Partial<typeof r>) => onChange(formatRelative({ ...r, ...patch }));
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <Picker className="w-20" label={DIRECTIONS.find((d) => d.value === r.direction)?.label} value={r.direction} items={DIRECTIONS} onPick={(v) => set({ direction: v as Direction })} />
      {r.direction !== "THIS" && (
        <Input
          type="number"
          min={1}
          value={r.amount}
          onChange={(e) => set({ amount: Math.max(1, Number(e.target.value) || 1) })}
          className="h-8 w-16"
          aria-label="Amount"
        />
      )}
      <Picker
        className="w-24"
        label={r.direction === "THIS" ? r.unit.charAt(0) + r.unit.slice(1).toLowerCase() : UNITS.find((u) => u.value === r.unit)?.label}
        value={r.unit}
        items={r.direction === "THIS" ? UNITS.map((u) => ({ ...u, label: u.label.slice(0, -1) })) : UNITS}
        onPick={(v) => set({ unit: v as Unit })}
      />
    </div>
  );
}

/**
 * The advanced filter: rows of "Where [field] [operator] [value]", joined by
 * the group's and/or, plus one level of sub-groups.
 */
function GroupEditor({ fields, isVisible, group, depth, onChange }: {
  fields: FilterField[];
  isVisible: (column: string) => boolean;
  group: FilterGroup;
  depth: number;
  onChange: (g: FilterGroup) => void;
}) {
  const setRule = (i: number, node: FilterNode | null) =>
    onChange({ ...group, rules: node ? group.rules.map((n, j) => (j === i ? node : n)) : group.rules.filter((_, j) => j !== i) });
  const logic = group.logic === "or" ? "or" : "and";

  return (
    <div className="flex flex-col gap-2">
      {group.rules.map((node, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex h-8 w-16 shrink-0 items-center text-[0.8125rem] text-muted-foreground">
            {i === 0 ? "Where" : i === 1 ? (
              <Picker className="w-16" label={logic} value={logic} items={[{ value: "and", label: "and" }, { value: "or", label: "or" }]} onPick={(v) => onChange({ ...group, logic: v as "and" | "or" })} />
            ) : logic}
          </div>
          {isGroup(node) ? (
            <div className="min-w-0 flex-1 rounded-md p-2 shadow-edge">
              <GroupEditor fields={fields} isVisible={isVisible} group={node} depth={depth + 1} onChange={(g) => setRule(i, g)} />
            </div>
          ) : (
            <RuleRow fields={fields} isVisible={isVisible} rule={node} onChange={(r) => setRule(i, r)} />
          )}
          <Button size="icon" variant="ghost" onClick={() => setRule(i, null)} aria-label={isGroup(node) ? "Remove rule group" : "Remove rule"}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onChange({ ...group, rules: [...group.rules, newRule(fields[0])] })}>
          <Plus className="size-4" /> Add filter rule
        </Button>
        {depth === 0 && (
          <Button size="sm" variant="ghost" onClick={() => onChange({ ...group, rules: [...group.rules, { logic: "and", rules: [newRule(fields[0])] }] })}>
            <Plus className="size-4" /> Add rule group
          </Button>
        )}
      </div>
    </div>
  );
}

function RuleRow({ fields, isVisible, rule, onChange }: {
  fields: FilterField[];
  isVisible: (column: string) => boolean;
  rule: FilterRule;
  onChange: (r: FilterRule) => void;
}) {
  const field = fields.find((f) => f.key === rule.field) ?? fields[0];
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex h-8 w-40 shrink-0 items-center justify-between gap-1 rounded-sm bg-secondary px-2 text-[0.8125rem]">
            <span className="truncate">{field.label}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64">
          <FieldList fields={fields} isVisible={isVisible} onPick={(f) => { setOpen(false); onChange(newRule(f)); }} />
        </PopoverContent>
      </Popover>
      <OperatorPicker className="w-36 shrink-0" type={field.type} rule={rule} onChange={onChange} />
      <ValueInput key={`${rule.field}:${rule.op}`} field={field} rule={rule} onChange={onChange} inline />
    </div>
  );
}
