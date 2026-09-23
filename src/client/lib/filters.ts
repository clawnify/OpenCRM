// The list filter model, shared by the filter bar and the API (see the server's
// buildFilters). The top level is a list, ANDed: each entry is a rule or a
// group. A basic filter is a top-level rule, shown as its own chip. The
// advanced filter is the one top-level group ("N advanced rules"), whose rules
// combine with AND or OR and which may hold one more level of groups.

import type { EntityType } from "@/types";

export type FieldType = "text" | "number" | "enum" | "date" | "boolean" | "relation";

export interface FilterField {
  /** The real column the rule filters on. */
  key: string;
  label: string;
  type: FieldType;
  options?: { label: string; value: string }[];
  /** The table column that shows this field, for Visible / Hidden grouping. */
  column?: string;
  /** A relation's linked entity: its values are that entity's record ids. */
  entity?: EntityType;
  /** Names a value for the rule's chip (a relation's record name). */
  labelOf?: (value: string) => string;
}

export interface FilterRule {
  field: string;
  op: string;
  value?: string | string[];
}

export interface FilterGroup {
  logic: "and" | "or";
  rules: FilterNode[];
}

export type FilterNode = FilterRule | FilterGroup;

export const isGroup = (n: FilterNode): n is FilterGroup => Array.isArray((n as FilterGroup).rules);

interface Operator {
  op: string;
  /** In the operator picker: "contains", "is before". */
  label: string;
}

export const OPERATORS: Record<FieldType, Operator[]> = {
  text: [
    { op: "contains", label: "contains" },
    { op: "does_not_contain", label: "does not contain" },
    { op: "is", label: "is" },
    { op: "is_not", label: "is not" },
    { op: "is_empty", label: "is empty" },
    { op: "is_not_empty", label: "is not empty" },
  ],
  number: [
    { op: "is", label: "=" },
    { op: "is_not", label: "≠" },
    { op: "gt", label: ">" },
    { op: "gte", label: "≥" },
    { op: "lt", label: "<" },
    { op: "lte", label: "≤" },
    { op: "is_empty", label: "is empty" },
    { op: "is_not_empty", label: "is not empty" },
  ],
  enum: [
    { op: "is", label: "is" },
    { op: "is_not", label: "is not" },
    { op: "is_empty", label: "is empty" },
    { op: "is_not_empty", label: "is not empty" },
  ],
  date: [
    { op: "on", label: "is" },
    { op: "before", label: "is before" },
    { op: "after", label: "is on or after" },
    { op: "relative", label: "is relative" },
    { op: "today", label: "is today" },
    { op: "in_past", label: "is in past" },
    { op: "in_future", label: "is in future" },
    { op: "is_empty", label: "is empty" },
    { op: "is_not_empty", label: "is not empty" },
  ],
  boolean: [{ op: "is", label: "is" }],
  relation: [
    { op: "is", label: "is" },
    { op: "is_not", label: "is not" },
    { op: "is_empty", label: "is empty" },
    { op: "is_not_empty", label: "is not empty" },
  ],
};

const VALUELESS = new Set(["is_empty", "is_not_empty", "today", "in_past", "in_future"]);
export const needsValue = (op: string) => !VALUELESS.has(op);

export const defaultOp = (type: FieldType) => OPERATORS[type][0].op;

/** A fresh rule for a field; enum and relation rules hold a list of values. */
export function newRule(field: FilterField): FilterRule {
  if (field.type === "enum" || field.type === "relation") return { field: field.key, op: "is", value: [] };
  if (field.type === "boolean") return { field: field.key, op: "is", value: "1" };
  if (field.type === "date") return { field: field.key, op: "relative", value: "PAST_7_DAY" };
  return { field: field.key, op: defaultOp(field.type), value: "" };
}

/** Whether a rule filters anything yet (a rule still being typed does not). */
export function isComplete(r: FilterRule): boolean {
  if (!needsValue(r.op)) return true;
  return Array.isArray(r.value) ? r.value.length > 0 : !!r.value;
}

/** The tree without unfinished rules and emptied groups: what the API receives. */
export function sanitize(nodes: FilterNode[]): FilterNode[] {
  return nodes.flatMap((n): FilterNode[] => {
    if (!isGroup(n)) return isComplete(n) ? [n] : [];
    const rules = sanitize(n.rules);
    return rules.length ? [{ ...n, rules }] : [];
  });
}

/** Counts the rules in a tree, groups included as their contents. */
export const countRules = (nodes: FilterNode[]): number =>
  nodes.reduce((n, x) => n + (isGroup(x) ? countRules(x.rules) : 1), 0);

// ── Relative dates ("PAST_7_DAY"), the server's format ─────────────

export type Direction = "PAST" | "NEXT" | "THIS";
export type Unit = "DAY" | "WEEK" | "MONTH" | "YEAR";
export interface Relative { direction: Direction; amount: number; unit: Unit }

export function parseRelative(v: unknown): Relative {
  const m = typeof v === "string" ? /^(PAST|NEXT|THIS)_(\d{1,4})_(DAY|WEEK|MONTH|YEAR)$/.exec(v) : null;
  return m ? { direction: m[1] as Direction, amount: Number(m[2]), unit: m[3] as Unit } : { direction: "PAST", amount: 7, unit: "DAY" };
}

export const formatRelative = (r: Relative) => `${r.direction}_${r.direction === "THIS" ? 1 : Math.max(1, r.amount)}_${r.unit}`;

function describeRelative(v: unknown): string {
  const r = parseRelative(v);
  const unit = r.unit.toLowerCase();
  if (r.direction === "THIS") return `this ${unit}`;
  return `${r.direction === "PAST" ? "past" : "next"} ${r.amount} ${unit}${r.amount === 1 ? "" : "s"}`;
}

const formatDay = (v: unknown) => {
  const d = new Date(`${String(v)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

/** A rule as its chip reads: "Status: Lead, Customer", "Created: past 7 days", "Score ≥ 5". */
export function describeRule(r: FilterRule, field: FilterField | undefined): string {
  const label = field?.label ?? r.field;
  const optionLabel = (v: string) => field?.labelOf?.(v) ?? field?.options?.find((o) => o.value === v)?.label ?? v;
  const values = Array.isArray(r.value) ? r.value.map(optionLabel).join(", ") : optionLabel(r.value ?? "");
  switch (r.op) {
    case "contains": case "is": return field?.type === "number" ? `${label} = ${values}` : `${label}: ${values}`;
    case "does_not_contain": case "is_not": return field?.type === "number" ? `${label} ≠ ${values}` : `${label}: not ${values}`;
    case "is_empty": return `${label}: empty`;
    case "is_not_empty": return `${label}: not empty`;
    case "gt": return `${label} > ${values}`;
    case "gte": return `${label} ≥ ${values}`;
    case "lt": return `${label} < ${values}`;
    case "lte": return `${label} ≤ ${values}`;
    case "on": return `${label}: ${formatDay(r.value)}`;
    case "before": return `${label}: before ${formatDay(r.value)}`;
    case "after": return `${label}: on or after ${formatDay(r.value)}`;
    case "relative": return `${label}: ${describeRelative(r.value)}`;
    case "today": return `${label}: today`;
    case "in_past": return `${label}: in past`;
    case "in_future": return `${label}: in future`;
    default: return `${label} ${r.op} ${values}`;
  }
}

/** The filterable fields of an entity: its built-ins, then its custom fields by
 *  storage type. A relation filters on its many_to_one side only: the other
 *  side has no column of its own. */
export function fieldsFromDefs(
  builtins: FilterField[],
  defs: { key: string; label: string; field_type: string; custom_field: string; options: Record<string, unknown>; relation_type: string | null; target_entity: EntityType | null }[],
): FilterField[] {
  const custom: FilterField[] = defs.filter((d) => d.relation_type !== "one_to_many").map((d) => {
    const base = { key: d.key, label: d.label, column: d.key };
    if (d.field_type === "relation" && d.target_entity) return { ...base, type: "relation", entity: d.target_entity };
    if (d.custom_field === "clawnify::score.score" || d.field_type === "integer" || d.field_type === "decimal") return { ...base, type: "number" };
    if (d.custom_field === "clawnify::badge.badge" || d.field_type === "enumeration") {
      const vals = Array.isArray(d.options.enum) ? (d.options.enum as string[]) : [];
      return { ...base, type: "enum", options: vals.map((v) => ({ label: v, value: v })) };
    }
    if (d.field_type === "boolean") return { ...base, type: "boolean", options: [{ label: "Yes", value: "1" }, { label: "No", value: "0" }] };
    if (d.field_type === "date" || d.field_type === "datetime") return { ...base, type: "date" };
    return { ...base, type: "text" };
  });
  return [...builtins, ...custom];
}
