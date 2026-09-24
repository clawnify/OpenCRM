import { createApp, createRoute, z } from "@clawnify/app";
import freemailDomains from "free-email-domains";
import { query, get, run } from "./db.js";
import type { CredentialBinding } from "@clawnify/connections";
import { sendEmail, createMeeting, notifySlack, connectionStatus } from "./integrations.js";
import {
  listDefs,
  createDef,
  createRelation,
  hasColumn,
  updateDef,
  deleteDef,
  coerceCustomValue,
  classifyCustomWrite,
  missingRequiredCustom,
  writableFieldKeys,
  isEntityType,
  ENTITY_TABLES,
  type EntityType,
  type CustomFieldDef,
} from "./custom-fields.js";
import { withRelations, relationWriteError, relationSortSQL, detachRelations, searchRecords } from "./relations.js";

// In production Clawnify injects the CREDENTIALS broker binding + CLAWNIFY_ORG_ID
// whenever clawnify.json declares `app.credentials`. SLACK_CHANNEL is an optional
// custom env var: when set (and Slack is connected), won deals auto-notify it.
type Env = {
  Bindings: {
    DB: D1Database;
    CREDENTIALS?: CredentialBinding;
    CLAWNIFY_ORG_ID?: string;
    SLACK_CHANNEL?: string;
  };
};

/** Split an array into fixed-size chunks. Used to keep bulk SQL within D1's
 * 100-bound-parameter limit (the same cap applies to the preview-tier Facet). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** withRelations for a single record read (list reads call it directly). */
async function withRelationsOne(entity: EntityType, row: unknown): Promise<unknown> {
  return row ? (await withRelations(entity, [row as Record<string, unknown>], 100))[0] : row;
}

/** Append a row to the activity timeline. Never throws — logging is best-effort. */
async function logActivity(
  entity_type: string,
  entity_id: string,
  type: string,
  body: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await run(
      "INSERT INTO activities (id, entity_type, entity_id, type, body, meta) VALUES (?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), entity_type, entity_id, type, body, JSON.stringify(meta)],
    );
  } catch {
    /* timeline logging must never break the primary action */
  }
}

/**
 * Write custom-property values for one entity row. `custom` is the nested
 * object from the request body ({ key: value }); only keys with a matching def
 * are written, each coerced/validated for its type. Runs as a follow-up UPDATE
 * so the built-in INSERT/UPDATE paths stay untouched. Throws on enum violation.
 */
async function applyCustomValues(
  entity: EntityType,
  table: string,
  id: string,
  custom: Record<string, unknown> | undefined,
): Promise<void> {
  if (!custom || typeof custom !== "object") return;
  const defs = await listDefs(entity);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, raw] of Object.entries(custom)) {
    const def = byKey.get(key);
    if (!def || !hasColumn(def)) continue; // ignore unknown keys: only defined properties with a column are writable
    sets.push(`"${key.replace(/"/g, '""')}" = ?`);
    params.push(coerceCustomValue(raw, def));
  }
  if (sets.length === 0) return;
  params.push(id);
  await run(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`, params);
}

/** Reusable request-body field: the nested bag of custom-property values.
 *  Still accepted for back-compat, but custom keys may now also be sent flat at
 *  the top level (see resolveCustomWrite). */
const CustomValues = z.record(z.string(), z.any()).optional();

/** Merge a request body's flat top-level custom keys with its nested `custom`
 *  bag, then classify against the entity's registry. Both shapes are accepted
 *  (the bag wins on a key conflict); built-in base keys pass through untouched.
 *  Returns the writable custom values and any unknown keys the caller rejects. */
async function resolveCustomWrite(
  entity: EntityType,
  body: Record<string, unknown>,
): Promise<{ values: Record<string, unknown>; unknown: string[] }> {
  const candidates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (k !== "custom") candidates[k] = v;
  const bag = body.custom;
  if (bag && typeof bag === "object") Object.assign(candidates, bag as Record<string, unknown>);
  return classifyCustomWrite(entity, candidates);
}

/** 422 body: a write named a field that is neither a base column nor a
 *  registered custom field — surfaced loudly instead of silently dropped. */
const UnknownFieldsSchema = z.object({
  error: z.string(),
  unknown_fields: z.array(z.string()),
  valid_fields: z.array(z.string()),
}).openapi("UnknownFields");

/** Build the 422 body when a write named unknown keys, or null when the write is
 *  clean. Returns the payload (not a Response) so each handler surfaces it via its
 *  own typed `c.json(body, 422)` — keeping OpenAPIHono's strict response inference. */
async function unknownFieldsError(
  entity: EntityType,
  unknown: string[],
): Promise<z.infer<typeof UnknownFieldsSchema> | null> {
  if (unknown.length === 0) return null;
  return {
    error: `Unknown field(s) for ${entity}: ${unknown.join(", ")}. Send a base field or a registered custom field, or define it first via POST /api/custom-fields.`,
    unknown_fields: unknown,
    valid_fields: await writableFieldKeys(entity),
  };
}

/** Quote a SQL identifier (custom-field keys are already regex-validated at
 *  def creation, but quote defensively — same as applyCustomValues). */
const quoteIdent = (k: string) => `"${k.replace(/"/g, '""')}"`;

/** Lenient coercion for bulk import: an invalid cell (bad enum, unparseable
 *  number) becomes null rather than aborting the whole import batch. */
function coerceForImport(value: unknown, def: CustomFieldDef): string | number | null {
  try {
    const v = coerceCustomValue(value, def);
    return typeof v === "number" && Number.isNaN(v) ? null : v;
  } catch {
    return null;
  }
}

/** The custom columns to write for an import: defs whose key is present and
 *  non-empty in at least one row's `custom` bag. Keeps the bulk INSERT narrow. */
async function resolveImportCustomColumns(
  entity: EntityType,
  rows: Array<{ custom?: Record<string, unknown> }>,
): Promise<{ keys: string[]; defByKey: Map<string, CustomFieldDef> }> {
  // Relations aren't imported: a cell holds a name, not the linked record's id.
  const defByKey = new Map((await listDefs(entity)).filter((d) => d.field_type !== "relation").map((d) => [d.key, d]));
  const present = new Set<string>();
  for (const r of rows) {
    if (!r.custom || typeof r.custom !== "object") continue;
    for (const [k, v] of Object.entries(r.custom)) {
      if (defByKey.has(k) && v !== null && v !== undefined && v !== "") present.add(k);
    }
  }
  return { keys: [...present], defByKey };
}

// createApp bakes in the standard skeleton: OpenAPIHono construction, the
// per-request D1/Storage init middleware, and API discovery (GET
// /api/openapi.json + GET /llms.txt from the live routes). App code below is
// just routes + business logic.
const app = createApp<Env>({
  title: "OpenCRM",
  version: "1.0.0",
  description: "A CRM with companies, contacts, and deal pipeline management.",
});

// ── Shared Schemas ─────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  industry: z.string(),
  phone: z.string(),
  email: z.string(),
  notes: z.string(),
  contact_count: z.number().int().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Company");

const ContactSchema = z.object({
  id: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  phone: z.string(),
  company_id: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  company_name: z.string().nullable().optional(),
  company_domain: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Contact");

const DealSchema = z.object({
  id: z.string(),
  name: z.string(),
  contact_id: z.string().nullable(),
  value: z.number(),
  stage: z.string(),
  close_date: z.string(),
  notes: z.string(),
  contact_first_name: z.string().nullable().optional(),
  contact_last_name: z.string().nullable().optional(),
  company_name: z.string().nullable().optional(),
  company_domain: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Deal");

const IdParam = z.object({ id: z.string().openapi({ description: "Resource ID (integer)" }) });

const PaginationQuery = z.object({
  page: z.string().optional().openapi({ description: "Page number (default: 1)" }),
  limit: z.string().optional().openapi({ description: "Items per page (default: 25, max: 100)" }),
  sort: z.string().optional().openapi({ description: "Column to sort by (any real column, incl. custom fields)" }),
  order: z.enum(["asc", "desc"]).optional().openapi({ description: "Sort direction (default: desc)" }),
  search: z.string().optional().openapi({ description: "Search term" }),
  filters: z.string().optional().openapi({ description: 'JSON filter list, ANDed. Each entry is a rule {field, op, value} or a group {logic: "and"|"or", rules: [...]} (groups nest one level). op ∈ contains|does_not_contain|is|is_not (value may be an array)|is_empty|is_not_empty|gt|gte|lt|lte, and for dates on|before|after (value YYYY-MM-DD, after = on or after)|today|in_past|in_future|relative (value PAST_7_DAY, NEXT_2_WEEK, THIS_1_MONTH: DAY|WEEK|MONTH|YEAR)' }),
  tz: z.string().optional().openapi({ description: "Viewer's UTC offset in minutes (e.g. 120), for date filters on local days" }),
});

/** Real column names of a table (from sqlite). Used to validate sort/filter
 *  fields against actual columns — the safe allowlist for built-ins + custom. */
async function tableColumns(table: string): Promise<Set<string>> {
  const rows = await query<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => r.name));
}

const qid = (col: string) => `"${col.replace(/"/g, '""')}"`;

// A filter is a tree. The top level is a list, ANDed: each entry is a rule
// ({field, op, value}) or a group ({logic: "and"|"or", rules: [...]}). A group
// may hold rules and one more level of groups. The flat list of rules is the
// same shape with no groups, so older links keep working.
type FilterRule = { field?: unknown; op?: unknown; value?: unknown };
type FilterGroup = { logic?: unknown; rules?: unknown };

/** Filter values past this many would crowd D1's 100 bound parameters per query. */
const MAX_FILTER_PARAMS = 60;

class FilterError extends Error {}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" of a UTC timestamp shifted to the viewer's offset. */
function localDay(ms: number, tzOffset: number): string {
  return new Date(ms + tzOffset * 60_000).toISOString().slice(0, 10);
}

/** A relative date ("PAST_7_DAY", "NEXT_2_WEEK", "THIS_1_MONTH") as an inclusive
 *  [start, end] of local days. Weeks start on Monday. */
function relativeRange(value: string, tzOffset: number): [string, string] | null {
  const m = /^(PAST|NEXT|THIS)_(\d{1,4})_(DAY|WEEK|MONTH|YEAR)$/.exec(value);
  if (!m) return null;
  const [, dir, n, unit] = m;
  const amount = Number(n);
  const today = new Date(`${localDay(Date.now(), tzOffset)}T00:00:00Z`);
  const shift = (d: Date, by: number) => {
    const x = new Date(d);
    if (unit === "DAY") x.setUTCDate(x.getUTCDate() + by);
    else if (unit === "WEEK") x.setUTCDate(x.getUTCDate() + 7 * by);
    else if (unit === "MONTH") x.setUTCMonth(x.getUTCMonth() + by);
    else x.setUTCFullYear(x.getUTCFullYear() + by);
    return x;
  };
  const day = (d: Date) => d.toISOString().slice(0, 10);
  if (dir === "PAST") return [day(shift(today, -amount)), day(today)];
  if (dir === "NEXT") return [day(today), day(shift(today, amount))];
  const start = new Date(today);
  if (unit === "WEEK") start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  else if (unit === "MONTH") start.setUTCDate(1);
  else if (unit === "YEAR") start.setUTCMonth(0, 1);
  const end = shift(start, 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return [day(start), day(unit === "DAY" ? today : end)];
}

/** Build safe WHERE clauses from a JSON filter tree. Fields are validated
 *  against `cols` (real columns), so identifiers are never user-controlled;
 *  values are always parameterised. `tzOffset` (minutes east of UTC) puts date
 *  rules on the viewer's local day. Invalid rules are skipped; too many
 *  values throw a FilterError. */
function buildFilters(cols: Set<string>, raw: string | undefined, prefix = "", tzOffset = 0): { clauses: string[]; params: unknown[] } {
  const params: unknown[] = [];
  let nodes: unknown[] = [];
  try { const a = JSON.parse(raw || "[]"); if (Array.isArray(a)) nodes = a; } catch { /* ignore */ }
  const mod = `${tzOffset >= 0 ? "+" : ""}${tzOffset} minutes`;

  // A value's local day: a date-only value is already one; a timestamp is
  // stored in UTC and shifted to the viewer's offset.
  const dayOf = (col: string) => {
    params.push(mod);
    return `(CASE WHEN length(${col}) <= 10 THEN ${col} ELSE date(${col}, ?) END)`;
  };
  const today = () => { params.push(mod); return "date('now', ?)"; };

  const leaf = (r: FilterRule): string | null => {
    if (typeof r.field !== "string" || !cols.has(r.field) || typeof r.op !== "string") return null;
    const col = `${prefix}${qid(r.field)}`;
    const list = Array.isArray(r.value) ? r.value.filter((v): v is string => typeof v === "string") : null;
    const v = typeof r.value === "string" || typeof r.value === "number" ? String(r.value) : "";
    const num = Number(v);
    switch (r.op) {
      case "contains": if (!v) return null; params.push(`%${v}%`); return `${col} LIKE ?`;
      case "does_not_contain": if (!v) return null; params.push(`%${v}%`); return `(${col} IS NULL OR ${col} NOT LIKE ?)`;
      // is / is not ignore case, as contains (LIKE) already does: "consulting" finds "Consulting".
      case "is":
        if (list) { if (!list.length) return null; params.push(...list); return `${col} COLLATE NOCASE IN (${list.map(() => "?").join(", ")})`; }
        params.push(v); return `${col} = ? COLLATE NOCASE`;
      case "is_not":
        if (list) { if (!list.length) return null; params.push(...list); return `(${col} IS NULL OR ${col} COLLATE NOCASE NOT IN (${list.map(() => "?").join(", ")}))`; }
        params.push(v); return `(${col} IS NULL OR ${col} != ? COLLATE NOCASE)`;
      case "is_empty": return `(${col} IS NULL OR ${col} = '')`;
      case "is_not_empty": return `(${col} IS NOT NULL AND ${col} != '')`;
      case "gt": case "lt": case "gte": case "lte": {
        if (v === "" || Number.isNaN(num)) return null;
        params.push(num);
        return `${col} ${({ gt: ">", lt: "<", gte: ">=", lte: "<=" } as const)[r.op]} ?`;
      }
      case "on": case "before": case "after": {
        if (!DAY.test(v)) return null;
        const d = dayOf(col);
        params.push(v);
        return `${d} ${({ on: "=", before: "<", after: ">=" } as const)[r.op]} ?`;
      }
      case "today": { const d = dayOf(col); return `${d} = ${today()}`; }
      case "in_past": return `(${col} IS NOT NULL AND ${col} != '' AND datetime(${col}) < datetime('now'))`;
      case "in_future": return `(${col} IS NOT NULL AND ${col} != '' AND datetime(${col}) > datetime('now'))`;
      case "relative": {
        const range = relativeRange(v, tzOffset);
        if (!range) return null;
        const d = dayOf(col);
        params.push(range[0], range[1]);
        return `${d} BETWEEN ? AND ?`;
      }
      default: return null;
    }
  };

  // depth 0: the top-level list; a group there may hold one more level of groups.
  const node = (n: unknown, depth: number): string | null => {
    if (!n || typeof n !== "object") return null;
    const g = n as FilterGroup;
    if (Array.isArray(g.rules)) {
      if (depth > 1) return null;
      const parts = g.rules.map((r) => node(r, depth + 1)).filter((p): p is string => !!p);
      if (!parts.length) return null;
      return `(${parts.join(g.logic === "or" ? " OR " : " AND ")})`;
    }
    return leaf(n as FilterRule);
  };

  const clauses = nodes.map((n) => node(n, 0)).filter((c): c is string => !!c);
  if (params.length > MAX_FILTER_PARAMS) throw new FilterError(`Too many filter values (at most ${MAX_FILTER_PARAMS})`);
  return { clauses, params };
}

/** The viewer's UTC offset in minutes from a `tz` query value; 0 when absent or invalid. */
function tzOffsetOf(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && Math.abs(n) <= 840 ? n : 0;
}

// ── Column aggregates (the list footer's "Calculate" row) ──────────
// The footer's operations: every column can count; numbers also sum,
// average and range; dates give the earliest and latest; booleans count each
// side. Computed over the whole filtered list, not the page on screen.

type ColumnKind = "text" | "number" | "date" | "boolean";
const BASE_AGGREGATES = ["count", "count_empty", "count_not_empty", "count_unique", "percent_empty", "percent_not_empty"];
const AGGREGATES_FOR: Record<ColumnKind, string[]> = {
  text: BASE_AGGREGATES,
  number: [...BASE_AGGREGATES, "sum", "avg", "min", "max"],
  date: [...BASE_AGGREGATES, "earliest", "latest"],
  boolean: [...BASE_AGGREGATES, "count_true", "count_false"],
};
const ALL_AGGREGATES = new Set(Object.values(AGGREGATES_FOR).flat());

function kindOf(fieldType: string): ColumnKind {
  if (fieldType === "integer" || fieldType === "decimal") return "number";
  if (fieldType === "date" || fieldType === "datetime") return "date";
  if (fieldType === "boolean") return "boolean";
  return "text";
}

function aggregateSQL(op: string, x: string): string {
  const empty = `(${x} IS NULL OR ${x} = '')`;
  switch (op) {
    case "count": return "COUNT(*)";
    case "count_empty": return `SUM(CASE WHEN ${empty} THEN 1 ELSE 0 END)`;
    case "count_not_empty": return `SUM(CASE WHEN ${empty} THEN 0 ELSE 1 END)`;
    case "count_unique": return `COUNT(DISTINCT NULLIF(${x}, ''))`;
    case "percent_empty": return `ROUND(100.0 * SUM(CASE WHEN ${empty} THEN 1 ELSE 0 END) / MAX(COUNT(*), 1))`;
    case "percent_not_empty": return `ROUND(100.0 * SUM(CASE WHEN ${empty} THEN 0 ELSE 1 END) / MAX(COUNT(*), 1))`;
    case "sum": return `SUM(${x})`;
    case "avg": return `ROUND(AVG(${x}), 2)`;
    case "min": return `MIN(${x})`;
    case "max": return `MAX(${x})`;
    case "earliest": return `MIN(NULLIF(${x}, ''))`;
    case "latest": return `MAX(NULLIF(${x}, ''))`;
    case "count_true": return `SUM(CASE WHEN ${x} = 1 THEN 1 ELSE 0 END)`;
    case "count_false": return `SUM(CASE WHEN ${x} = 0 THEN 1 ELSE 0 END)`;
    default: throw new Error(`Unknown aggregate ${op}`);
  }
}

/** Runs the requested `ops` ([{key, op}] as JSON) in one query over `from` +
 *  `whereSQL`. Only keys in `columns` and ops valid for their kind are run;
 *  anything else (a deleted field, a sum of text) is left out of the answer. */
async function aggregateColumns(
  from: string,
  whereSQL: string,
  params: unknown[],
  columns: Record<string, { sql: string; kind: ColumnKind }>,
  raw: string | undefined,
): Promise<Record<string, number | string | null>> {
  let asked: Array<{ key?: unknown; op?: unknown }> = [];
  try { const a = JSON.parse(raw || "[]"); if (Array.isArray(a)) asked = a.slice(0, 50); } catch { /* ignore */ }
  const valid = asked.filter((a): a is { key: string; op: string } =>
    typeof a.key === "string" && typeof a.op === "string" && !!columns[a.key] && AGGREGATES_FOR[columns[a.key].kind].includes(a.op));
  if (!valid.length) return {};
  const select = valid.map((a, i) => `${aggregateSQL(a.op, columns[a.key].sql)} AS a${i}`).join(", ");
  const row = await get<Record<string, number | string | null>>(`SELECT ${select} FROM ${from}${whereSQL}`, params);
  return Object.fromEntries(valid.map((a, i) => [a.key, row?.[`a${i}`] ?? null]));
}

/** A custom field's column for aggregates, if the field still has one. */
async function customAggregateColumns(entity: EntityType, alias: string, cols: Set<string>) {
  const defs = await listDefs(entity);
  return Object.fromEntries(
    defs.filter((d) => cols.has(d.key)).map((d) => [d.key, { sql: `${alias}.${qid(d.key)}`, kind: kindOf(d.field_type) }]),
  );
}

// ── Stats ──────────────────────────────────────────────────────────

const getStats = createRoute({
  method: "get",
  path: "/api/stats",
  tags: ["Stats"],
  summary: "Get dashboard statistics",
  responses: {
    200: {
      description: "Dashboard stats",
      content: { "application/json": { schema: z.object({
        contacts: z.number().int(),
        companies: z.number().int(),
        deals: z.number().int(),
        dealValue: z.number(),
      }) } },
    },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getStats, async (c) => {
  try {
    const contacts = await get<{ count: number }>("SELECT COUNT(*) as count FROM contacts");
    const companies = await get<{ count: number }>("SELECT COUNT(*) as count FROM companies");
    const deals = await get<{ count: number }>("SELECT COUNT(*) as count FROM deals");
    const dealValue = await get<{ total: number }>("SELECT COALESCE(SUM(value), 0) as total FROM deals WHERE stage NOT IN (SELECT key FROM stages WHERE is_lost = 1)");
    return c.json({
      contacts: contacts?.count || 0,
      companies: companies?.count || 0,
      deals: deals?.count || 0,
      dealValue: dealValue?.total || 0,
    }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Companies ──────────────────────────────────────────────────────

const listCompanies = createRoute({
  method: "get",
  path: "/api/companies",
  tags: ["Companies"],
  summary: "List companies with pagination, search, and filtering",
  request: {
    query: PaginationQuery.extend({
      industry: z.string().optional().openapi({ description: "Filter by industry" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated companies",
      content: { "application/json": { schema: z.object({
        companies: z.array(CompanySchema),
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
      }) } },
    },
    400: { description: "Invalid filter", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/** The companies list's WHERE: search, industry and filters. Shared by the
 *  list and its footer aggregates, so both see the same rows. */
function companiesWhere(q: { search?: string; industry?: string; filters?: string; tz?: string }, cols: Set<string>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const search = (q.search || "").trim();
  const industry = (q.industry || "").trim();
  if (search) {
    where.push("(name LIKE ? OR domain LIKE ? OR email LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (industry) {
    where.push("industry = ?");
    params.push(industry);
  }
  const flt = buildFilters(cols, q.filters, "", tzOffsetOf(q.tz));
  where.push(...flt.clauses);
  params.push(...flt.params);
  return { whereSQL: where.length ? " WHERE " + where.join(" AND ") : "", params };
}

// Registered before /api/companies/{id}, which would otherwise take "aggregates" as an id.
app.get("/api/companies/aggregates", async (c) => {
  try {
    const q = c.req.query();
    const cols = await tableColumns("companies");
    const { whereSQL, params } = companiesWhere(q, cols);
    const values = await aggregateColumns("companies c", whereSQL, params, {
      name: { sql: "c.name", kind: "text" },
      domain: { sql: "c.domain", kind: "text" },
      industry: { sql: "c.industry", kind: "text" },
      contacts: { sql: "(SELECT COUNT(*) FROM contacts WHERE company_id = c.id)", kind: "number" },
      ...(await customAggregateColumns("company", "c", cols)),
    }, q.ops);
    return c.json({ values }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, err instanceof FilterError ? 400 : 500);
  }
});

app.openapi(listCompanies, async (c) => {
  try {
    const q = c.req.valid("query");
    const page = Math.max(1, parseInt(q.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10)));
    const offset = (page - 1) * limit;
    const cols = await tableColumns("companies");
    let sortCol = q.sort || "id";
    if (!cols.has(sortCol)) sortCol = "id";
    let order = (q.order || "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";
    const sortSQL = (await relationSortSQL("company", "c", sortCol)) ?? `c.${qid(sortCol)}`;

    const { whereSQL, params } = companiesWhere(q, cols);

    const countResult = await get<{ total: number }>(
      "SELECT COUNT(*) as total FROM companies" + whereSQL,
      [...params],
    );
    const total = countResult?.total || 0;

    const rows = await query(
      `SELECT c.*, (SELECT COUNT(*) FROM contacts WHERE company_id = c.id) as contact_count
       FROM companies c${whereSQL} ORDER BY ${sortSQL} ${order}, c.id LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return c.json({ companies: await withRelations("company", rows as Record<string, unknown>[]), total, page, limit }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, err instanceof FilterError ? 400 : 500);
  }
});

const createCompany = createRoute({
  method: "post",
  path: "/api/companies",
  tags: ["Companies"],
  summary: "Create a new company",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        name: z.string().min(1),
        domain: z.string().optional(),
        industry: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        notes: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    201: { description: "Created company", content: { "application/json": { schema: z.object({ company: CompanySchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createCompany, async (c) => {
  try {
    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("company", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("company", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const missingReq = await missingRequiredCustom("company", customValues, "create");
    if (missingReq.length) return c.json({ error: `Missing required field(s): ${missingReq.join(", ")}` }, 400);
    const relationErr = await relationWriteError("company", customValues);
    if (relationErr) return c.json({ error: relationErr }, 400);
    const name = body.name.trim();
    if (!name) return c.json({ error: "Name is required" }, 400);

    const id = crypto.randomUUID();
    await run(
      "INSERT INTO companies (id, name, domain, industry, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, name, (body.domain || "").trim(), (body.industry || "").trim(), (body.phone || "").trim(), (body.email || "").trim(), (body.notes || "").trim()],
    );

    await applyCustomValues("company", "companies", id, customValues);

    const inserted = await withRelationsOne("company", await get("SELECT * FROM companies WHERE id = ?", [id]));
    return c.json({ company: inserted }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const updateCompany = createRoute({
  method: "put",
  path: "/api/companies/{id}",
  tags: ["Companies"],
  summary: "Update a company",
  request: {
    params: IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        domain: z.string().optional(),
        industry: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        notes: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    200: { description: "Updated company", content: { "application/json": { schema: z.object({ company: CompanySchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateCompany, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("company", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("company", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const missingReq = await missingRequiredCustom("company", customValues, "update");
    if (missingReq.length) return c.json({ error: `Missing required field(s): ${missingReq.join(", ")}` }, 400);
    const relationErr = await relationWriteError("company", customValues);
    if (relationErr) return c.json({ error: relationErr }, 400);
    const fields: string[] = [];
    const params: unknown[] = [];

    for (const key of ["name", "domain", "industry", "phone", "email", "notes"] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(typeof body[key] === "string" ? body[key].trim() : body[key]);
      }
    }

    const hasCustom = Object.keys(customValues).length > 0;
    if (fields.length === 0 && !hasCustom) return c.json({ error: "No fields to update" }, 400);

    const exists = await get("SELECT id FROM companies WHERE id = ?", [id]);
    if (!exists) return c.json({ error: "Company not found" }, 404);

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      params.push(id);
      await run("UPDATE companies SET " + fields.join(", ") + " WHERE id = ?", params);
    }
    await applyCustomValues("company", "companies", id, customValues);

    const updated = await withRelationsOne("company", await get("SELECT * FROM companies WHERE id = ?", [id]));
    return c.json({ company: updated }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const deleteCompany = createRoute({
  method: "delete",
  path: "/api/companies/{id}",
  tags: ["Companies"],
  summary: "Delete a company",
  request: { params: IdParam },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteCompany, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const result = await run("DELETE FROM companies WHERE id = ?", [id]);
    if (result.changes === 0) return c.json({ error: "Company not found" }, 404);
    await detachRelations("company", [id]);
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Deletes many at once: the table's selection bar. Chunked under D1's
// 100-parameter cap; not one transaction, so a failure mid-way leaves the
// earlier chunks deleted (the list refetches either way).
const bulkDeleteCompanies = createRoute({
  method: "post",
  path: "/api/companies/bulk-delete",
  tags: ["Companies"],
  summary: "Delete several companies",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }) } },
    },
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.number() }) } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(bulkDeleteCompanies, async (c) => {
  try {
    const { ids } = c.req.valid("json");
    let deleted = 0;
    const unique = [...new Set(ids)];
    for (const part of chunk(unique, 90)) {
      const result = await run(`DELETE FROM companies WHERE id IN (${part.map(() => "?").join(", ")})`, part);
      deleted += result.changes;
    }
    await detachRelations("company", unique);
    return c.json({ deleted }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Contacts ───────────────────────────────────────────────────────

const listContacts = createRoute({
  method: "get",
  path: "/api/contacts",
  tags: ["Contacts"],
  summary: "List contacts with pagination, search, and filtering",
  request: {
    query: PaginationQuery.extend({
      status: z.string().optional().openapi({ description: "Filter by status (lead, customer, etc.)" }),
      company_id: z.string().optional().openapi({ description: "Filter by company ID" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated contacts",
      content: { "application/json": { schema: z.object({
        contacts: z.array(ContactSchema),
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
      }) } },
    },
    400: { description: "Invalid filter", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/** The contacts list's WHERE: search, status, company and filters. Shared by
 *  the list and its footer aggregates, so both see the same rows. */
function contactsWhere(q: { search?: string; status?: string; company_id?: string; filters?: string; tz?: string }, cols: Set<string>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const search = (q.search || "").trim();
  const status = (q.status || "").trim();
  const companyId = q.company_id || "";
  if (search) {
    // Match the contact's own fields OR their company name, so searching a
    // company surfaces its contacts (both queries LEFT JOIN companies as `co`).
    where.push("(ct.first_name LIKE ? OR ct.last_name LIKE ? OR ct.email LIKE ? OR ct.title LIKE ? OR co.name LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) {
    where.push("ct.status = ?");
    params.push(status);
  }
  if (companyId) {
    where.push("ct.company_id = ?");
    params.push(companyId);
  }
  const flt = buildFilters(cols, q.filters, "ct.", tzOffsetOf(q.tz));
  where.push(...flt.clauses);
  params.push(...flt.params);
  return { whereSQL: where.length ? " WHERE " + where.join(" AND ") : "", params };
}

// Registered before /api/contacts/{id}, which would otherwise take "aggregates" as an id.
app.get("/api/contacts/aggregates", async (c) => {
  try {
    const q = c.req.query();
    const cols = await tableColumns("contacts");
    const { whereSQL, params } = contactsWhere(q, cols);
    const values = await aggregateColumns("contacts ct LEFT JOIN companies co ON ct.company_id = co.id", whereSQL, params, {
      name: { sql: "TRIM(COALESCE(ct.first_name, '') || ' ' || COALESCE(ct.last_name, ''))", kind: "text" },
      email: { sql: "ct.email", kind: "text" },
      phone: { sql: "ct.phone", kind: "text" },
      company: { sql: "ct.company_id", kind: "text" },
      title: { sql: "ct.title", kind: "text" },
      status: { sql: "ct.status", kind: "text" },
      ...(await customAggregateColumns("contact", "ct", cols)),
    }, q.ops);
    return c.json({ values }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, err instanceof FilterError ? 400 : 500);
  }
});

app.openapi(listContacts, async (c) => {
  try {
    const q = c.req.valid("query");
    const page = Math.max(1, parseInt(q.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10)));
    const offset = (page - 1) * limit;
    const cols = await tableColumns("contacts");
    let sortCol = q.sort || "id";
    if (!cols.has(sortCol)) sortCol = "id";
    let order = (q.order || "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";
    const sortSQL = (await relationSortSQL("contact", "ct", sortCol)) ?? `ct.${qid(sortCol)}`;

    const { whereSQL, params } = contactsWhere(q, cols);

    const countResult = await get<{ total: number }>(
      "SELECT COUNT(*) as total FROM contacts ct LEFT JOIN companies co ON ct.company_id = co.id" + whereSQL,
      [...params],
    );
    const total = countResult?.total || 0;

    const rows = await query(
      `SELECT ct.*, co.name as company_name, co.domain as company_domain
       FROM contacts ct
       LEFT JOIN companies co ON ct.company_id = co.id
       ${whereSQL}
       ORDER BY ${sortSQL} ${order}, ct.id
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return c.json({ contacts: await withRelations("contact", rows as Record<string, unknown>[]), total, page, limit }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, err instanceof FilterError ? 400 : 500);
  }
});

const createContact = createRoute({
  method: "post",
  path: "/api/contacts",
  tags: ["Contacts"],
  summary: "Create a new contact",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        first_name: z.string().min(1),
        last_name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        company_id: z.string().nullable().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    201: { description: "Created contact", content: { "application/json": { schema: z.object({ contact: ContactSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createContact, async (c) => {
  try {
    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("contact", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("contact", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const missingReq = await missingRequiredCustom("contact", customValues, "create");
    if (missingReq.length) return c.json({ error: `Missing required field(s): ${missingReq.join(", ")}` }, 400);
    const relationErr = await relationWriteError("contact", customValues);
    if (relationErr) return c.json({ error: relationErr }, 400);
    const firstName = body.first_name.trim();
    if (!firstName) return c.json({ error: "First name is required" }, 400);

    // Link to the chosen company, or infer one from the work-email domain
    // (skips free providers) so a contact never lands orphaned when its email
    // clearly belongs to a company.
    let companyId = body.company_id ? String(body.company_id) : null;
    if (!companyId && body.email) {
      const dom = workEmailDomain(String(body.email));
      if (dom) companyId = await findOrCreateCompanyByDomain(dom);
    }

    const id = crypto.randomUUID();
    await run(
      "INSERT INTO contacts (id, first_name, last_name, email, phone, company_id, title, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, firstName, (body.last_name || "").trim(), (body.email || "").trim(), (body.phone || "").trim(), companyId, (body.title || "").trim(), (body.status || "lead").trim()],
    );

    await applyCustomValues("contact", "contacts", id, customValues);

    const inserted = await get(
      `SELECT ct.*, co.name as company_name, co.domain as company_domain
       FROM contacts ct LEFT JOIN companies co ON ct.company_id = co.id
       WHERE ct.id = ?`,
      [id],
    );
    return c.json({ contact: await withRelationsOne("contact", inserted) }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const updateContact = createRoute({
  method: "put",
  path: "/api/contacts/{id}",
  tags: ["Contacts"],
  summary: "Update a contact",
  request: {
    params: IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        company_id: z.string().nullable().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    200: { description: "Updated contact", content: { "application/json": { schema: z.object({ contact: ContactSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateContact, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("contact", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("contact", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const missingReq = await missingRequiredCustom("contact", customValues, "update");
    if (missingReq.length) return c.json({ error: `Missing required field(s): ${missingReq.join(", ")}` }, 400);
    const relationErr = await relationWriteError("contact", customValues);
    if (relationErr) return c.json({ error: relationErr }, 400);
    const fields: string[] = [];
    const params: unknown[] = [];

    for (const key of ["first_name", "last_name", "email", "phone", "title", "status"] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(typeof body[key] === "string" ? body[key].trim() : body[key]);
      }
    }
    if (body.company_id !== undefined) {
      fields.push("company_id = ?");
      params.push(body.company_id ? String(body.company_id) : null);
    }

    const hasCustom = Object.keys(customValues).length > 0;
    if (fields.length === 0 && !hasCustom) return c.json({ error: "No fields to update" }, 400);

    const exists = await get("SELECT id FROM contacts WHERE id = ?", [id]);
    if (!exists) return c.json({ error: "Contact not found" }, 404);

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      params.push(id);
      await run("UPDATE contacts SET " + fields.join(", ") + " WHERE id = ?", params);
    }
    await applyCustomValues("contact", "contacts", id, customValues);

    const updated = await get(
      `SELECT ct.*, co.name as company_name, co.domain as company_domain
       FROM contacts ct LEFT JOIN companies co ON ct.company_id = co.id
       WHERE ct.id = ?`,
      [id],
    );
    return c.json({ contact: await withRelationsOne("contact", updated) }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const deleteContact = createRoute({
  method: "delete",
  path: "/api/contacts/{id}",
  tags: ["Contacts"],
  summary: "Delete a contact",
  request: { params: IdParam },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteContact, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const result = await run("DELETE FROM contacts WHERE id = ?", [id]);
    if (result.changes === 0) return c.json({ error: "Contact not found" }, 404);
    await detachRelations("contact", [id]);
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Deletes many at once: the table's selection bar. Chunked under D1's
// 100-parameter cap; not one transaction, so a failure mid-way leaves the
// earlier chunks deleted (the list refetches either way).
const bulkDeleteContacts = createRoute({
  method: "post",
  path: "/api/contacts/bulk-delete",
  tags: ["Contacts"],
  summary: "Delete several contacts",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }) } },
    },
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.number() }) } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(bulkDeleteContacts, async (c) => {
  try {
    const { ids } = c.req.valid("json");
    let deleted = 0;
    const unique = [...new Set(ids)];
    for (const part of chunk(unique, 90)) {
      const result = await run(`DELETE FROM contacts WHERE id IN (${part.map(() => "?").join(", ")})`, part);
      deleted += result.changes;
    }
    await detachRelations("contact", unique);
    return c.json({ deleted }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Stages (the pipeline vocabulary — data, not code) ──────────────
// `key` is immutable and stored on deals.stage. Behavior hangs on the
// semantic flags, never on names: is_won → celebrate + Slack notify,
// is_lost → excluded from pipeline value.

const StageSchema = z.object({
  key: z.string(),
  label: z.string(),
  color: z.string().openapi({ description: "Palette token: sky, emerald, amber, rose, violet, fuchsia, teal, orange, slate" }),
  position: z.number().int(),
  is_won: z.number().int().openapi({ description: "1 = a deal here counts as won (fires the Slack alert)" }),
  is_lost: z.number().int().openapi({ description: "1 = a deal here counts as lost (excluded from pipeline value)" }),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Stage");

type StageRow = z.infer<typeof StageSchema>;

const STAGE_COLORS = ["sky", "emerald", "amber", "rose", "violet", "fuchsia", "teal", "orange", "slate"];
const STAGE_KEY_RE = /^[a-z][a-z0-9_]*$/;

// Default sales pipeline — seeded only when the table is empty, so re-deploys
// never resurrect a stage the user renamed or deleted.
const DEFAULT_STAGES: Array<[string, string, string, number, number, number]> = [
  ["prospect", "Prospect", "slate", 0, 0, 0],
  ["qualified", "Qualified", "sky", 1, 0, 0],
  ["proposal", "Proposal", "violet", 2, 0, 0],
  ["negotiation", "Negotiation", "amber", 3, 0, 0],
  ["won", "Won", "emerald", 4, 1, 0],
  ["lost", "Lost", "rose", 5, 0, 1],
];

let stagesSeeded = false; // per-isolate fast path; the COUNT re-check is cheap

async function ensureStagesSeeded(): Promise<void> {
  if (stagesSeeded) return;
  const row = await get<{ count: number }>("SELECT COUNT(*) as count FROM stages");
  if ((row?.count ?? 0) === 0) {
    for (const s of DEFAULT_STAGES) {
      await run("INSERT OR IGNORE INTO stages (key, label, color, position, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?)", s);
    }
  }
  stagesSeeded = true;
}

const listStagesRows = async () => {
  await ensureStagesSeeded();
  return query<StageRow>("SELECT * FROM stages ORDER BY position, key");
};

/** Look up one stage (seeding the defaults first if the table is empty). */
async function getStageRow(key: string): Promise<StageRow | undefined> {
  await ensureStagesSeeded();
  return get<StageRow>("SELECT * FROM stages WHERE key = ?", [key]);
}

/** 400 body for an unknown stage key on a deal write. */
async function unknownStageError(key: string): Promise<{ error: string }> {
  const valid = (await listStagesRows()).map((s) => s.key).join(", ");
  return { error: `Unknown stage "${key}". Valid stages: ${valid}. Create it first via POST /api/stages.` };
}

const listStages = createRoute({
  method: "get",
  path: "/api/stages",
  tags: ["Stages"],
  summary: "List pipeline stages in order",
  responses: {
    200: { description: "Stages", content: { "application/json": { schema: z.object({ stages: z.array(StageSchema) }) } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listStages, async (c) => {
  try {
    return c.json({ stages: await listStagesRows() }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const createStage = createRoute({
  method: "post",
  path: "/api/stages",
  tags: ["Stages"],
  summary: "Create a pipeline stage",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        label: z.string().min(1),
        key: z.string().optional().openapi({ description: "Immutable identifier; derived from the label when omitted" }),
        color: z.string().optional(),
        position: z.number().int().optional().openapi({ description: "Defaults to the end of the pipeline" }),
        is_won: z.boolean().optional(),
        is_lost: z.boolean().optional(),
      }) } },
    },
  },
  responses: {
    201: { description: "Created stage", content: { "application/json": { schema: z.object({ stage: StageSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Key already exists", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createStage, async (c) => {
  try {
    const body = c.req.valid("json");
    const label = body.label.trim();
    if (!label) return c.json({ error: "Label is required" }, 400);
    const key = (body.key || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")).trim();
    if (!STAGE_KEY_RE.test(key)) {
      return c.json({ error: `Invalid stage key "${key}" — use lowercase letters, digits, and underscores (must start with a letter).` }, 400);
    }
    if (body.is_won && body.is_lost) return c.json({ error: "A stage cannot be both won and lost" }, 400);
    const exists = await getStageRow(key);
    if (exists) return c.json({ error: `Stage "${key}" already exists` }, 409);

    const color = STAGE_COLORS.includes((body.color || "").trim()) ? (body.color as string).trim() : "slate";
    let position = body.position;
    if (position === undefined) {
      const max = await get<{ m: number }>("SELECT COALESCE(MAX(position), -1) as m FROM stages");
      position = (max?.m ?? -1) + 1;
    }
    await run(
      "INSERT INTO stages (key, label, color, position, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?)",
      [key, label, color, position, body.is_won ? 1 : 0, body.is_lost ? 1 : 0],
    );
    const inserted = await get<StageRow>("SELECT * FROM stages WHERE key = ?", [key]);
    return c.json({ stage: inserted! }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const updateStage = createRoute({
  method: "put",
  path: "/api/stages/{key}",
  tags: ["Stages"],
  summary: "Update a stage's label, color, position, or semantic flags (key is immutable)",
  request: {
    params: z.object({ key: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        label: z.string().optional(),
        color: z.string().optional(),
        position: z.number().int().optional(),
        is_won: z.boolean().optional(),
        is_lost: z.boolean().optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Updated stage", content: { "application/json": { schema: z.object({ stage: StageSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateStage, async (c) => {
  try {
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await getStageRow(key);
    if (!existing) return c.json({ error: "Stage not found" }, 404);

    const is_won = body.is_won === undefined ? existing.is_won === 1 : body.is_won;
    const is_lost = body.is_lost === undefined ? existing.is_lost === 1 : body.is_lost;
    if (is_won && is_lost) return c.json({ error: "A stage cannot be both won and lost" }, 400);

    const fields: string[] = [];
    const params: unknown[] = [];
    if (body.label !== undefined) {
      const label = body.label.trim();
      if (!label) return c.json({ error: "Label cannot be empty" }, 400);
      fields.push("label = ?"); params.push(label);
    }
    if (body.color !== undefined) {
      if (!STAGE_COLORS.includes(body.color.trim())) {
        return c.json({ error: `Unknown color "${body.color}". Valid: ${STAGE_COLORS.join(", ")}` }, 400);
      }
      fields.push("color = ?"); params.push(body.color.trim());
    }
    if (body.position !== undefined) { fields.push("position = ?"); params.push(body.position); }
    if (body.is_won !== undefined) { fields.push("is_won = ?"); params.push(body.is_won ? 1 : 0); }
    if (body.is_lost !== undefined) { fields.push("is_lost = ?"); params.push(body.is_lost ? 1 : 0); }
    if (fields.length === 0) return c.json({ error: "No fields to update" }, 400);

    fields.push("updated_at = datetime('now')");
    params.push(key);
    await run("UPDATE stages SET " + fields.join(", ") + " WHERE key = ?", params);
    const updated = await get<StageRow>("SELECT * FROM stages WHERE key = ?", [key]);
    return c.json({ stage: updated! }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const deleteStage = createRoute({
  method: "delete",
  path: "/api/stages/{key}",
  tags: ["Stages"],
  summary: "Delete a stage; deals in it must be reassigned via ?reassign_to=<stage key>",
  request: {
    params: z.object({ key: z.string() }),
    query: z.object({
      reassign_to: z.string().optional().openapi({ description: "Stage key to move this stage's deals to (required when the stage has deals)" }),
    }),
  },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ ok: z.boolean(), reassigned: z.number().int() }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Stage has deals and no reassign_to was given", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteStage, async (c) => {
  try {
    const { key } = c.req.valid("param");
    const { reassign_to } = c.req.valid("query");
    const existing = await getStageRow(key);
    if (!existing) return c.json({ error: "Stage not found" }, 404);
    const total = await get<{ count: number }>("SELECT COUNT(*) as count FROM stages");
    if ((total?.count ?? 0) <= 1) return c.json({ error: "Cannot delete the last stage" }, 400);

    const inStage = await get<{ count: number }>("SELECT COUNT(*) as count FROM deals WHERE stage = ?", [key]);
    let reassigned = 0;
    if ((inStage?.count ?? 0) > 0) {
      const target = (reassign_to || "").trim();
      if (!target) {
        return c.json({ error: `Stage has ${inStage!.count} deal(s). Pass ?reassign_to=<stage key> to move them first.` }, 409);
      }
      if (target === key) return c.json({ error: "reassign_to must be a different stage" }, 400);
      const targetRow = await getStageRow(target);
      if (!targetRow) return c.json(await unknownStageError(target), 400);
      const res = await run("UPDATE deals SET stage = ?, updated_at = datetime('now') WHERE stage = ?", [target, key]);
      reassigned = res.changes ?? 0;
    }
    await run("DELETE FROM stages WHERE key = ?", [key]);
    return c.json({ ok: true, reassigned }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Deals ──────────────────────────────────────────────────────────

const getDealsBoard = createRoute({
  method: "get",
  path: "/api/deals/board",
  tags: ["Deals"],
  summary: "Get all deals for the pipeline board view, optionally filtered",
  request: {
    query: PaginationQuery.pick({ filters: true, tz: true }),
  },
  responses: {
    200: { description: "All deals with contact/company info", content: { "application/json": { schema: z.object({ deals: z.array(DealSchema) }) } } },
    400: { description: "Invalid filters", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getDealsBoard, async (c) => {
  try {
    const q = c.req.valid("query");
    const flt = buildFilters(await tableColumns("deals"), q.filters, "d.", tzOffsetOf(q.tz));
    const whereSQL = flt.clauses.length ? " WHERE " + flt.clauses.join(" AND ") : "";
    const rows = await query(
      `SELECT d.*,
              ct.first_name as contact_first_name, ct.last_name as contact_last_name,
              co.name as company_name, co.domain as company_domain
       FROM deals d
       LEFT JOIN contacts ct ON d.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id` + whereSQL + `
       ORDER BY d.created_at ASC`,
      flt.params,
    );
    return c.json({ deals: await withRelations("deal", rows as Record<string, unknown>[]) }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, err instanceof FilterError ? 400 : 500);
  }
});

const listDeals = createRoute({
  method: "get",
  path: "/api/deals",
  tags: ["Deals"],
  summary: "List deals with pagination, search, and filtering",
  request: {
    query: PaginationQuery.extend({
      stage: z.string().optional().openapi({ description: "Filter by stage key (see GET /api/stages for the pipeline vocabulary)" }),
      contact_id: z.string().optional().openapi({ description: "Filter by contact ID" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated deals",
      content: { "application/json": { schema: z.object({
        deals: z.array(DealSchema),
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
        totalValue: z.number(),
      }) } },
    },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listDeals, async (c) => {
  try {
    const q = c.req.valid("query");
    const page = Math.max(1, parseInt(q.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10)));
    const offset = (page - 1) * limit;
    const search = (q.search || "").trim();
    const stage = (q.stage || "").trim();
    const contactId = q.contact_id || "";

    let sortCol = q.sort || "id";
    if (!["id", "name", "value", "stage", "close_date", "created_at"].includes(sortCol)) sortCol = "id";
    let order = (q.order || "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";

    const where: string[] = [];
    const params: unknown[] = [];

    if (search) {
      where.push("(d.name LIKE ? OR d.notes LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    if (stage) {
      where.push("d.stage = ?");
      params.push(stage);
    }
    if (contactId) {
      where.push("d.contact_id = ?");
      params.push(contactId);
    }

    const whereSQL = where.length ? " WHERE " + where.join(" AND ") : "";

    const countResult = await get<{ total: number }>(
      "SELECT COUNT(*) as total FROM deals d" + whereSQL,
      [...params],
    );
    const total = countResult?.total || 0;

    const agg = await get<{ total_value: number }>(
      "SELECT COALESCE(SUM(d.value), 0) as total_value FROM deals d" + whereSQL,
      [...params],
    );

    const rows = await query(
      `SELECT d.*,
              ct.first_name as contact_first_name, ct.last_name as contact_last_name,
              co.name as company_name, co.domain as company_domain
       FROM deals d
       LEFT JOIN contacts ct ON d.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id
       ${whereSQL}
       ORDER BY d.${sortCol} ${order}, d.id
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return c.json({ deals: await withRelations("deal", rows as Record<string, unknown>[]), total, page, limit, totalValue: agg?.total_value || 0 }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const createDeal = createRoute({
  method: "post",
  path: "/api/deals",
  tags: ["Deals"],
  summary: "Create a new deal",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        name: z.string().min(1),
        contact_id: z.string().nullable().optional(),
        value: z.union([z.number(), z.string()]).optional(),
        stage: z.string().optional(),
        close_date: z.string().optional(),
        notes: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    201: { description: "Created deal", content: { "application/json": { schema: z.object({ deal: DealSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createDeal, async (c) => {
  try {
    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("deal", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("deal", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const missingReq = await missingRequiredCustom("deal", customValues, "create");
    if (missingReq.length) return c.json({ error: `Missing required field(s): ${missingReq.join(", ")}` }, 400);
    const relationErr = await relationWriteError("deal", customValues);
    if (relationErr) return c.json({ error: relationErr }, 400);
    const name = body.name.trim();
    if (!name) return c.json({ error: "Name is required" }, 400);

    const contactId = body.contact_id ? String(body.contact_id) : null;
    const value = parseFloat(String(body.value)) || 0;

    // Stage must exist; default is the first stage of the pipeline.
    let stageKey = (body.stage || "").trim();
    if (stageKey) {
      const ok = await getStageRow(stageKey);
      if (!ok) return c.json(await unknownStageError(stageKey), 400);
    } else {
      const all = await listStagesRows();
      stageKey = all[0]?.key ?? "prospect";
    }

    const id = crypto.randomUUID();
    await run(
      "INSERT INTO deals (id, name, contact_id, value, stage, close_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, name, contactId, value, stageKey, (body.close_date || "").trim(), (body.notes || "").trim()],
    );

    await applyCustomValues("deal", "deals", id, customValues);

    const inserted = await get(
      `SELECT d.*, ct.first_name as contact_first_name, ct.last_name as contact_last_name,
              co.name as company_name, co.domain as company_domain
       FROM deals d
       LEFT JOIN contacts ct ON d.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id
       WHERE d.id = ?`,
      [id],
    );
    return c.json({ deal: await withRelationsOne("deal", inserted) }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const updateDeal = createRoute({
  method: "put",
  path: "/api/deals/{id}",
  tags: ["Deals"],
  summary: "Update a deal",
  request: {
    params: IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        contact_id: z.string().nullable().optional(),
        value: z.union([z.number(), z.string()]).optional(),
        stage: z.string().optional(),
        close_date: z.string().optional(),
        notes: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    200: { description: "Updated deal", content: { "application/json": { schema: z.object({ deal: DealSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateDeal, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("deal", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("deal", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const missingReq = await missingRequiredCustom("deal", customValues, "update");
    if (missingReq.length) return c.json({ error: `Missing required field(s): ${missingReq.join(", ")}` }, 400);
    const relationErr = await relationWriteError("deal", customValues);
    if (relationErr) return c.json({ error: relationErr }, 400);
    if (body.stage !== undefined) {
      const stageKey = String(body.stage).trim();
      const ok = await getStageRow(stageKey);
      if (!ok) return c.json(await unknownStageError(stageKey), 400);
    }
    const fields: string[] = [];
    const params: unknown[] = [];

    for (const key of ["name", "stage", "close_date", "notes"] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(typeof body[key] === "string" ? body[key].trim() : body[key]);
      }
    }
    if (body.value !== undefined) {
      fields.push("value = ?");
      params.push(parseFloat(String(body.value)) || 0);
    }
    if (body.contact_id !== undefined) {
      fields.push("contact_id = ?");
      params.push(body.contact_id ? String(body.contact_id) : null);
    }

    const hasCustom = Object.keys(customValues).length > 0;
    if (fields.length === 0 && !hasCustom) return c.json({ error: "No fields to update" }, 400);

    const exists = await get("SELECT id FROM deals WHERE id = ?", [id]);
    if (!exists) return c.json({ error: "Deal not found" }, 404);

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      params.push(id);
      await run("UPDATE deals SET " + fields.join(", ") + " WHERE id = ?", params);
    }
    await applyCustomValues("deal", "deals", id, customValues);

    const updated = await get<Record<string, unknown>>(
      `SELECT d.*, ct.first_name as contact_first_name, ct.last_name as contact_last_name,
              co.name as company_name, co.domain as company_domain
       FROM deals d
       LEFT JOIN contacts ct ON d.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id
       WHERE d.id = ?`,
      [id],
    );

    // Deal just marked won → log it and notify Slack (best-effort, never blocks
    // the update). Fires only when this request set stage='won'.
    // Stage semantics fire on the stage's FLAGS, never its name — so they work
    // with any vocabulary the user edits the pipeline into. Only when this
    // request actually set the stage (best-effort, never blocks the update).
    if (body.stage !== undefined && updated) {
      const st = await getStageRow(String(body.stage).trim());
      if (st?.is_won) {
        const value = Number(updated.value) || 0;
        await logActivity("deal", id, "stage_change", `Deal won — ${st.label}`, { stage: body.stage, value });
        const channel = c.env.SLACK_CHANNEL?.trim();
        if (channel) {
          const contact = [updated.contact_first_name, updated.contact_last_name].filter(Boolean).join(" ");
          const text = `🎉 *Deal won:* ${updated.name} — $${value.toLocaleString()}${contact ? ` (${contact})` : ""}`;
          try {
            await notifySlack(c.env, { channel, text });
            await logActivity("deal", id, "slack", `Notified #${channel} of the win`, { channel });
          } catch {
            /* Slack not connected / channel missing — the win is still recorded */
          }
        }
      }
      if (st?.is_lost) {
        await logActivity("deal", id, "stage_change", `Deal lost — ${st.label}`, { stage: body.stage });
      }
    }
    return c.json({ deal: await withRelationsOne("deal", updated) }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const deleteDeal = createRoute({
  method: "delete",
  path: "/api/deals/{id}",
  tags: ["Deals"],
  summary: "Delete a deal",
  request: { params: IdParam },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteDeal, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const result = await run("DELETE FROM deals WHERE id = ?", [id]);
    if (result.changes === 0) return c.json({ error: "Deal not found" }, 404);
    await detachRelations("deal", [id]);
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Activity timeline ──────────────────────────────────────────────
// Plain Hono handlers (not createRoute) to keep the integration surface
// compact; validation is done inline in the same defensive style as above.

const ENTITY_TYPES = ["contact", "company", "deal"];

app.get("/api/activities", async (c) => {
  try {
    const entity_type = (c.req.query("entity_type") || "").trim();
    const entity_id = (c.req.query("entity_id") || "").trim();
    if (!ENTITY_TYPES.includes(entity_type) || !entity_id) {
      return c.json({ error: "entity_type and entity_id are required" }, 400);
    }
    const activities = await query(
      "SELECT * FROM activities WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC",
      [entity_type, entity_id],
    );
    return c.json({ activities }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/activities", async (c) => {
  try {
    const body = await c.req.json<{ entity_type?: string; entity_id?: string; type?: string; body?: string }>();
    const entity_type = (body.entity_type || "").trim();
    const entity_id = (body.entity_id || "").trim();
    if (!ENTITY_TYPES.includes(entity_type) || !entity_id) {
      return c.json({ error: "entity_type and entity_id are required" }, 400);
    }
    const text = (body.body || "").trim();
    if (!text) return c.json({ error: "Note body is required" }, 400);
    await logActivity(entity_type, entity_id, (body.type || "note").trim(), text);
    return c.json({ ok: true }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Integrations (Clawnify connections) ────────────────────────────

app.get("/api/integrations/status", async (c) => {
  try {
    return c.json(await connectionStatus(c.env), 200);
  } catch {
    return c.json({ email: false, meeting: false, slack: false }, 200);
  }
});

// Email a contact via connected Gmail, then log it on the contact's timeline.
app.post("/api/integrations/email", async (c) => {
  try {
    const body = await c.req.json<{ contact_id?: string; subject?: string; body?: string }>();
    const contactId = (body.contact_id || "").trim();
    const subject = (body.subject || "").trim();
    const text = (body.body || "").trim();
    if (!contactId) return c.json({ error: "contact_id is required" }, 400);
    if (!subject && !text) return c.json({ error: "A subject or body is required" }, 400);

    const contact = await get<{ email: string; first_name: string; last_name: string }>(
      "SELECT email, first_name, last_name FROM contacts WHERE id = ?",
      [contactId],
    );
    if (!contact) return c.json({ error: "Contact not found" }, 404);
    if (!contact.email) return c.json({ error: "Contact has no email address" }, 400);

    await sendEmail(c.env, { to: contact.email, subject, body: text });
    await logActivity("contact", contactId, "email", subject || "(no subject)", { to: contact.email });
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Schedule a Google Calendar meeting with a contact, then log it.
app.post("/api/integrations/meeting", async (c) => {
  try {
    const body = await c.req.json<{
      contact_id?: string;
      summary?: string;
      start_datetime?: string;
      timezone?: string;
      duration_minutes?: number;
    }>();
    const contactId = (body.contact_id || "").trim();
    const summary = (body.summary || "").trim();
    const start = (body.start_datetime || "").trim();
    if (!contactId) return c.json({ error: "contact_id is required" }, 400);
    if (!summary) return c.json({ error: "A meeting title is required" }, 400);
    if (!start) return c.json({ error: "A start time is required" }, 400);

    const contact = await get<{ email: string }>("SELECT email FROM contacts WHERE id = ?", [contactId]);
    if (!contact) return c.json({ error: "Contact not found" }, 404);

    const durationMinutes = Number(body.duration_minutes) || 30;
    const timezone = (body.timezone || "").trim() || "UTC";
    await createMeeting(c.env, {
      summary,
      startDatetime: start,
      timezone,
      durationHour: Math.floor(durationMinutes / 60),
      durationMinutes: durationMinutes % 60,
      attendees: contact.email ? [contact.email] : [],
    });
    await logActivity("contact", contactId, "meeting", summary, { start, timezone });
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Contact import (CSV / XLSX, mapped client-side) ────────────────
// The client parses the file and maps headers → fields, then posts clean rows
// here. Company names resolve to ids (reusing existing, creating new), then the
// contacts are bulk-inserted.
//
// This is written set-based, not row-by-row: company lookups use `IN (…)` and
// inserts use multi-row `VALUES (…),(…)`, chunked to stay under D1's 100
// bound-parameter cap (the same cap the preview-tier Facet enforces). A 2000-row
// import is ~150 statements, not ~2400 — it stays well inside the Worker's
// subrequest/duration budget and goes through @clawnify/db unchanged (so it also
// works on the DO-Facet preview binding, which has no batch()).
//
// Ceiling: chunks are not one atomic transaction (the adapter exposes no
// batch()/transaction). Companies are created before contacts so a mid-import
// failure can't orphan a contact's company_id; re-running is safe for companies
// (deduped by name) but may duplicate contacts. Upgrade to a single transaction
// if @clawnify/db ever exposes batch().

const CONTACT_STATUSES = ["lead", "active", "inactive", "churned"];
const LOOKUP_CHUNK = 100; // one-param `name IN (…)` lookups
// Widest company insert is (id, name, domain, industry, phone) = 5 params/row.
// D1 caps bound parameters at 100 per query, so chunk at 100/5 = 20 rows.
const COMPANY_COLS = 5;
const COMPANY_INSERT_CHUNK = Math.floor(100 / COMPANY_COLS); // 20 rows/stmt → 100 params ≤ 100

// Personal/free email providers (gmail, outlook, …) — a company is never
// inferred from these, else every import would spawn a "Gmail" company. Sourced
// from the maintained `free-email-domains` list (~12.8k domains) so it stays
// current via dependency bumps rather than hand-curation.
const FREEMAIL_DOMAINS = new Set(freemailDomains.map((d) => d.toLowerCase()));

// The domain of a work email, or "" if it has none or is a free provider.
function workEmailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes(".")) return "";
  return FREEMAIL_DOMAINS.has(domain) ? "" : domain;
}

/** Find a company whose stored domain resolves to `domain` (tolerating
 *  protocol / www / trailing slash), else create a lightweight one named after
 *  the domain. Used to auto-link a contact to a company from its work email. */
async function findOrCreateCompanyByDomain(domain: string): Promise<string> {
  const existing = await get<{ id: string }>(
    `SELECT id FROM companies
      WHERE lower(replace(replace(replace(rtrim(domain,'/'),'https://',''),'http://',''),'www.','')) = ?
      LIMIT 1`,
    [domain],
  );
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const sld = domain.split(".")[0] || domain;
  const name = sld.charAt(0).toUpperCase() + sld.slice(1);
  await run("INSERT INTO companies (id, name, domain) VALUES (?, ?, ?)", [id, name, domain]);
  return id;
}

// A first-guess company name from a domain: "acme.com" → "Acme". Crude but
// editable post-import, matching how HubSpot seeds domain-derived companies.
function companyNameFromDomain(domain: string): string {
  const label = domain.replace(/^www\./, "").split(".")[0] || domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

app.post("/api/contacts/import", async (c) => {
  try {
    const body = await c.req.json<{
      contacts?: Array<{
        first_name?: string;
        last_name?: string;
        email?: string;
        phone?: string;
        title?: string;
        status?: string;
        company?: string;
        company_domain?: string;
        company_industry?: string;
        company_phone?: string;
        custom?: Record<string, unknown>;
      }>;
      // Opt-in: infer/associate a company from each contact's work-email domain
      // when the row has no explicit company column.
      inferCompanyFromEmail?: boolean;
    }>();
    const rows = Array.isArray(body.contacts) ? body.contacts : [];
    if (rows.length === 0) return c.json({ error: "No rows to import" }, 400);
    if (rows.length > 2000) return c.json({ error: "Import is limited to 2000 rows at a time" }, 400);
    const inferFromEmail = body.inferCompanyFromEmail === true;

    // Keep only rows with at least a first name; normalize fields. `inferDomain`
    // is the work-email domain to build a company from — set only when opted in,
    // the row has no explicit company, and the email domain isn't a free provider.
    const clean = rows
      .map((r) => {
        const email = (r.email || "").trim();
        const company = (r.company || "").trim();
        return {
          first_name: (r.first_name || "").trim(),
          last_name: (r.last_name || "").trim(),
          email,
          phone: (r.phone || "").trim(),
          title: (r.title || "").trim(),
          status: CONTACT_STATUSES.includes((r.status || "").trim()) ? (r.status as string).trim() : "lead",
          company,
          company_domain: (r.company_domain || "").trim(),
          company_industry: (r.company_industry || "").trim(),
          company_phone: (r.company_phone || "").trim(),
          inferDomain: inferFromEmail && !company && email ? workEmailDomain(email) : "",
          custom: r.custom && typeof r.custom === "object" ? r.custom : undefined,
        };
      })
      .filter((r) => r.first_name);
    const skipped = rows.length - clean.length;
    if (clean.length === 0) return c.json({ error: "No rows had a first name to import" }, 400);

    // ── Resolve company names → ids (set-based, case-insensitive) ──
    // Distinct names, keeping the first-seen original casing for any we create.
    // Company attributes (domain/industry/phone) are captured from the first
    // row that carries each one, so a new company lands fully populated instead
    // of as a name-only stub.
    type CompanyDraft = { name: string; domain: string; industry: string; phone: string };
    const nameByKey = new Map<string, CompanyDraft>();
    for (const r of clean) {
      if (!r.company) continue;
      const key = r.company.toLowerCase();
      const existing = nameByKey.get(key);
      if (!existing) {
        nameByKey.set(key, { name: r.company, domain: r.company_domain, industry: r.company_industry, phone: r.company_phone });
      } else {
        if (!existing.domain) existing.domain = r.company_domain;
        if (!existing.industry) existing.industry = r.company_industry;
        if (!existing.phone) existing.phone = r.company_phone;
      }
    }
    const companyIds = new Map<string, number>(); // lowercased name → id

    const loadIds = async (names: string[]) => {
      for (const group of chunk(names, LOOKUP_CHUNK)) {
        const placeholders = group.map(() => "?").join(", ");
        const found = await query<{ id: string; name: string }>(
          `SELECT id, name FROM companies WHERE name COLLATE NOCASE IN (${placeholders})`,
          group,
        );
        for (const co of found) companyIds.set(co.name.toLowerCase(), co.id);
      }
    };

    const allNames = [...nameByKey.values()].map((co) => co.name);
    await loadIds(allNames);

    // Create the ones that don't exist yet (multi-row insert), then reload ids.
    // Existing companies are reused untouched — dedupe-by-name wins, so we never
    // overwrite an established company's attributes from an import.
    const missing = [...nameByKey].filter(([key]) => !companyIds.has(key)).map(([, co]) => co);
    for (const group of chunk(missing, COMPANY_INSERT_CHUNK)) {
      const placeholders = group.map(() => "(?, ?, ?, ?, ?)").join(", ");
      const params = group.flatMap((co) => [crypto.randomUUID(), co.name, co.domain, co.industry, co.phone]);
      await run(`INSERT INTO companies (id, name, domain, industry, phone) VALUES ${placeholders}`, params);
    }
    if (missing.length) await loadIds(missing.map((co) => co.name));

    // ── Infer companies from work-email domains (opt-in) ──
    // Runs after the name phase so a domain match can land on a company that
    // phase just created (e.g. a mapped "Acme" with domain acme.com absorbs a
    // contact whose email is @acme.com). Existing companies match by domain
    // first; unmatched domains create a company named from the domain.
    const domainSet = new Set<string>();
    for (const r of clean) if (r.inferDomain) domainSet.add(r.inferDomain);

    const companyIdByDomain = new Map<string, string>(); // domain (lower) → id (UUID)
    const loadIdsByDomain = async (domainsList: string[]) => {
      for (const group of chunk(domainsList, LOOKUP_CHUNK)) {
        const placeholders = group.map(() => "?").join(", ");
        const found = await query<{ id: string; domain: string }>(
          `SELECT id, domain FROM companies WHERE domain <> '' AND domain COLLATE NOCASE IN (${placeholders})`,
          group,
        );
        for (const co of found) if (co.domain) companyIdByDomain.set(co.domain.toLowerCase(), co.id);
      }
    };

    const allDomains = [...domainSet];
    if (allDomains.length) await loadIdsByDomain(allDomains);

    const missingDomains = allDomains.filter((d) => !companyIdByDomain.has(d));
    for (const group of chunk(missingDomains, COMPANY_INSERT_CHUNK)) {
      const placeholders = group.map(() => "(?, ?, ?)").join(", ");
      const params = group.flatMap((d) => [crypto.randomUUID(), companyNameFromDomain(d), d]);
      await run(`INSERT INTO companies (id, name, domain) VALUES ${placeholders}`, params);
    }
    if (missingDomains.length) await loadIdsByDomain(missingDomains);

    const companiesCreated = missing.length + missingDomains.length;

    // ── Bulk-insert contacts (multi-row VALUES, chunked) ──
    // Mapped custom-field columns ride along in the same INSERT. Chunk size is
    // derived from the real column count so bound params stay ≤ 100 (D1 cap).
    const custom = await resolveImportCustomColumns("contact", clean);
    const builtinCols = ["id", "first_name", "last_name", "email", "phone", "company_id", "title", "status"];
    const cols = [...builtinCols, ...custom.keys.map(quoteIdent)];
    const rowsPerStmt = Math.max(1, Math.floor(100 / cols.length));
    const rowPlaceholder = `(${cols.map(() => "?").join(", ")})`;

    let imported = 0;
    for (const group of chunk(clean, rowsPerStmt)) {
      const placeholders = group.map(() => rowPlaceholder).join(", ");
      const params: unknown[] = [];
      for (const r of group) {
        const companyId = r.company
          ? companyIds.get(r.company.toLowerCase()) ?? null
          : r.inferDomain
            ? companyIdByDomain.get(r.inferDomain) ?? null
            : null;
        params.push(crypto.randomUUID(), r.first_name, r.last_name, r.email, r.phone, companyId, r.title, r.status);
        for (const k of custom.keys) params.push(coerceForImport(r.custom?.[k], custom.defByKey.get(k)!));
      }
      await run(`INSERT INTO contacts (${cols.join(", ")}) VALUES ${placeholders}`, params);
      imported += group.length;
    }

    return c.json({ imported, companiesCreated, skipped }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Bulk company import (CSV / XLSX) ────────────────────────────────
// Dedupe by name (case-insensitive): a company whose name already exists is
// skipped, never duplicated or overwritten. New companies land with their
// built-in columns + any mapped custom fields.
app.post("/api/companies/import", async (c) => {
  try {
    const body = await c.req.json<{
      companies?: Array<{
        name?: string;
        domain?: string;
        industry?: string;
        phone?: string;
        email?: string;
        notes?: string;
        custom?: Record<string, unknown>;
      }>;
    }>();
    const rows = Array.isArray(body.companies) ? body.companies : [];
    if (rows.length === 0) return c.json({ error: "No rows to import" }, 400);
    if (rows.length > 2000) return c.json({ error: "Import is limited to 2000 rows at a time" }, 400);

    // Keep only rows with a name; collapse to the first-seen row per name so a
    // duplicated name in the file resolves to one company (first wins).
    const byKey = new Map<string, {
      name: string; domain: string; industry: string; phone: string; email: string; notes: string;
      custom?: Record<string, unknown>;
    }>();
    for (const r of rows) {
      const name = (r.name || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (byKey.has(key)) continue;
      byKey.set(key, {
        name,
        domain: (r.domain || "").trim(),
        industry: (r.industry || "").trim(),
        phone: (r.phone || "").trim(),
        email: (r.email || "").trim(),
        notes: (r.notes || "").trim(),
        custom: r.custom && typeof r.custom === "object" ? r.custom : undefined,
      });
    }
    const named = rows.filter((r) => (r.name || "").trim()).length;
    const noName = rows.length - named; // rows with no company name at all
    const fileDuplicates = named - byKey.size; // same name repeated within the file
    if (byKey.size === 0) return c.json({ error: "No rows had a company name to import" }, 400);

    // Which names already exist → skip those (dedupe).
    const existing = new Set<string>();
    const names = [...byKey.values()].map((co) => co.name);
    for (const group of chunk(names, LOOKUP_CHUNK)) {
      const placeholders = group.map(() => "?").join(", ");
      const found = await query<{ name: string }>(
        `SELECT name FROM companies WHERE name COLLATE NOCASE IN (${placeholders})`,
        group,
      );
      for (const co of found) existing.add(co.name.toLowerCase());
    }
    const fresh = [...byKey].filter(([key]) => !existing.has(key)).map(([, co]) => co);
    // Duplicates = names repeated within the file + names that already exist.
    const duplicates = fileDuplicates + (byKey.size - fresh.length);

    // Bulk-insert new companies + mapped custom columns (chunk from col count).
    const custom = await resolveImportCustomColumns("company", fresh);
    const builtinCols = ["id", "name", "domain", "industry", "phone", "email", "notes"];
    const cols = [...builtinCols, ...custom.keys.map(quoteIdent)];
    const rowsPerStmt = Math.max(1, Math.floor(100 / cols.length));
    const rowPlaceholder = `(${cols.map(() => "?").join(", ")})`;

    let imported = 0;
    for (const group of chunk(fresh, rowsPerStmt)) {
      const placeholders = group.map(() => rowPlaceholder).join(", ");
      const params: unknown[] = [];
      for (const co of group) {
        params.push(crypto.randomUUID(), co.name, co.domain, co.industry, co.phone, co.email, co.notes);
        for (const k of custom.keys) params.push(coerceForImport(co.custom?.[k], custom.defByKey.get(k)!));
      }
      await run(`INSERT INTO companies (${cols.join(", ")}) VALUES ${placeholders}`, params);
      imported += group.length;
    }

    return c.json({ imported, skipped: noName, duplicates }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Single contact (for deep-linked detail view) ───────────────────

app.get("/api/contacts/:id", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id || id === "all") return c.json({ error: "Not found" }, 404);
    const contact = await get(
      `SELECT ct.*, co.name as company_name, co.domain as company_domain
       FROM contacts ct LEFT JOIN companies co ON ct.company_id = co.id
       WHERE ct.id = ?`,
      [id],
    );
    if (!contact) return c.json({ error: "Contact not found" }, 404);
    return c.json({ contact: await withRelationsOne("contact", contact) }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/companies/:id", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Not found" }, 404);
    const company = await get(
      `SELECT c.*, (SELECT COUNT(*) FROM contacts WHERE company_id = c.id) as contact_count
       FROM companies c WHERE c.id = ?`,
      [id],
    );
    if (!company) return c.json({ error: "Company not found" }, 404);
    return c.json({ company: await withRelationsOne("company", company) }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Records (named, for relation chips and pickers) ────────────────

// `search` matches the record's name; `ids` (comma-separated, at most 60)
// returns those records instead, to name ids a filter or form already holds.
app.get("/api/records", async (c) => {
  try {
    const entity = c.req.query("entity") ?? "";
    if (!isEntityType(entity)) return c.json({ error: "entity must be contact, company or deal" }, 400);
    const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length > 60) return c.json({ error: "At most 60 ids" }, 400);
    return c.json({ records: await searchRecords(entity, c.req.query("search") ?? "", ids) }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// The values a column already holds, for a picker that offers them (an
// industry typed once is picked after). Any real column of the entity.
app.get("/api/values", async (c) => {
  try {
    const entity = c.req.query("entity") ?? "";
    if (!isEntityType(entity)) return c.json({ error: "entity must be contact, company or deal" }, 400);
    const table = ENTITY_TABLES[entity];
    const field = c.req.query("field") ?? "";
    if (!(await tableColumns(table)).has(field)) return c.json({ error: `Unknown field "${field}"` }, 400);
    const col = qid(field);
    const rows = await query<{ v: string }>(
      // One per value ignoring case: "consulting" and "Consulting" are one option.
      `SELECT MIN(${col}) AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} COLLATE NOCASE ORDER BY v COLLATE NOCASE LIMIT 200`,
    );
    return c.json({ values: rows.map((r) => String(r.v)) }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Custom properties (field definitions + schema-sync) ────────────

app.get("/api/custom-fields", async (c) => {
  const entity = c.req.query("entity");
  if (entity && !isEntityType(entity)) return c.json({ error: "Invalid entity" }, 400);
  const defs = await listDefs(entity ? (entity as EntityType) : undefined);
  return c.json({ defs }, 200);
});

app.post("/api/custom-fields", async (c) => {
  try {
    const body = await c.req.json();
    if (!isEntityType(body.entity_type)) return c.json({ error: "Invalid entity_type" }, 400);
    if (!body.key || !body.label) return c.json({ error: "key and label are required" }, 400);
    if (body.field_type === "relation") {
      if (!isEntityType(body.target_entity)) return c.json({ error: "A relation needs target_entity: contact, company or deal" }, 400);
      if (!body.inverse_key || !body.inverse_label) return c.json({ error: "A relation needs inverse_key and inverse_label for its other side" }, 400);
      const def = await createRelation({
        entity_type: body.entity_type,
        key: String(body.key),
        label: String(body.label),
        relation_type: body.relation_type,
        target_entity: body.target_entity,
        inverse_key: String(body.inverse_key),
        inverse_label: String(body.inverse_label),
        position: body.position ?? 0,
      });
      return c.json({ def }, 201);
    }
    const def = await createDef({
      entity_type: body.entity_type,
      key: String(body.key),
      label: String(body.label),
      field_type: body.field_type ?? "string",
      custom_field: body.custom_field ?? "",
      options: body.options ?? {},
      position: body.position ?? 0,
    });
    return c.json({ def }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.put("/api/custom-fields/:id", async (c) => {
  try {
    const def = await updateDef(c.req.param("id"), await c.req.json());
    if (!def) return c.json({ error: "Not found" }, 404);
    return c.json({ def }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.delete("/api/custom-fields/:id", async (c) => {
  const ok = await deleteDef(c.req.param("id"));
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true }, 200);
});

// ── Views (a list's named, shared layouts) ─────────────────────────

const VIEW_FIELD_KEY = /^[a-z][a-z0-9_]*$/;
const DEFAULT_VIEW_NAMES: Record<EntityType, string> = { contact: "All contacts", company: "All companies", deal: "All deals" };

interface ViewRow {
  id: string; entity_type: string; name: string; icon: string; is_default: number; position: number;
  filters: string; sort: string | null; sort_order: string | null;
}
const viewJson = (v: ViewRow) => {
  let filters: unknown = [];
  try { filters = JSON.parse(v.filters || "[]"); } catch { /* a bad row reads as no filters */ }
  return {
    id: v.id, entity: v.entity_type, name: v.name, icon: v.icon, isDefault: v.is_default === 1, position: v.position,
    filters: Array.isArray(filters) ? filters : [], sort: v.sort, order: v.sort_order === "asc" ? "asc" : v.sort_order === "desc" ? "desc" : null,
  };
};

/** A view name: trimmed, 1–60 characters. */
function viewName(raw: unknown): string | null {
  const name = typeof raw === "string" ? raw.trim() : "";
  return name && name.length <= 60 ? name : null;
}

/** Validates a view's filters by compiling them against the list's real columns; the JSON to store, or an error. */
async function viewFilters(entity: EntityType, raw: unknown): Promise<{ json: string } | { error: string }> {
  if (!Array.isArray(raw)) return { error: "filters must be an array" };
  const json = JSON.stringify(raw);
  if (json.length > 20_000) return { error: "filters too large" };
  try {
    buildFilters(await tableColumns(ENTITY_TABLES[entity]), json);
  } catch (err: unknown) {
    return { error: (err as Error).message };
  }
  return { json };
}

/** The list's default view, created on first use. */
async function ensureDefaultView(entity: EntityType): Promise<ViewRow> {
  const find = () => get<ViewRow>("SELECT * FROM views WHERE entity_type = ? AND is_default = 1", [entity]);
  const found = await find();
  if (found) return found;
  // The unique default index turns a racing second insert into a no-op.
  await run(
    "INSERT OR IGNORE INTO views (id, entity_type, name, icon, is_default, position) VALUES (?, ?, ?, 'table', 1, 0)",
    [crypto.randomUUID(), entity, DEFAULT_VIEW_NAMES[entity]],
  );
  return (await find())!;
}

app.get("/api/views", async (c) => {
  const entity = c.req.query("entity") ?? "";
  if (!isEntityType(entity)) return c.json({ error: "Invalid entity" }, 400);
  await ensureDefaultView(entity);
  const views = await query<ViewRow>(
    "SELECT * FROM views WHERE entity_type = ? ORDER BY is_default DESC, position, created_at",
    [entity],
  );
  return c.json({ views: views.map(viewJson) }, 200);
});

app.get("/api/views/:id/fields", async (c) => {
  const id = c.req.param("id");
  if (!(await get("SELECT id FROM views WHERE id = ?", [id]))) return c.json({ error: "View not found" }, 404);
  const fields = await query<{ field_key: string; is_visible: number; size: number | null; aggregate: string | null }>(
    "SELECT field_key, is_visible, size, aggregate FROM view_fields WHERE view_id = ?",
    [id],
  );
  return c.json({ fields: fields.map((f) => ({ key: f.field_key, visible: f.is_visible === 1, size: f.size, aggregate: f.aggregate })) }, 200);
});

// Sets one column's visibility, width and/or footer aggregate in a view,
// keeping whatever isn't sent. `aggregate: null` clears the calculation.
app.put("/api/views/:id/fields/:key", async (c) => {
  const { id, key } = c.req.param();
  if (!(await get("SELECT id FROM views WHERE id = ?", [id]))) return c.json({ error: "View not found" }, 404);
  if (!VIEW_FIELD_KEY.test(key)) return c.json({ error: "Invalid key" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { visible?: unknown; size?: unknown; aggregate?: unknown };
  if (body.visible !== undefined && typeof body.visible !== "boolean") return c.json({ error: "visible must be a boolean" }, 400);
  if (body.size !== undefined && (typeof body.size !== "number" || !Number.isInteger(body.size) || body.size < 40 || body.size > 2000)) {
    return c.json({ error: "size must be an integer between 40 and 2000" }, 400);
  }
  if (body.aggregate !== undefined && body.aggregate !== null && !(typeof body.aggregate === "string" && ALL_AGGREGATES.has(body.aggregate))) {
    return c.json({ error: "Unknown aggregate" }, 400);
  }
  const prev = await get<{ is_visible: number; size: number | null; aggregate: string | null }>(
    "SELECT is_visible, size, aggregate FROM view_fields WHERE view_id = ? AND field_key = ?",
    [id, key],
  );
  const visible = body.visible ?? (prev ? prev.is_visible === 1 : true);
  const size = (body.size as number | undefined) ?? prev?.size ?? null;
  const aggregate = body.aggregate === undefined ? prev?.aggregate ?? null : (body.aggregate as string | null);
  await run(
    `INSERT INTO view_fields (view_id, field_key, is_visible, size, aggregate, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(view_id, field_key) DO UPDATE SET is_visible = excluded.is_visible, size = excluded.size,
       aggregate = excluded.aggregate, updated_at = excluded.updated_at`,
    [id, key, visible ? 1 : 0, size, aggregate],
  );
  return c.json({ field: { key, visible, size, aggregate } }, 200);
});

// Creates a view from the list's current state: its filters and sort, and
// the columns of the view it was made from (`from`).
app.post("/api/views", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { entity?: unknown; name?: unknown; from?: unknown; filters?: unknown; sort?: unknown; order?: unknown };
  const entity = typeof body.entity === "string" ? body.entity : "";
  if (!isEntityType(entity)) return c.json({ error: "Invalid entity" }, 400);
  const name = viewName(body.name);
  if (!name) return c.json({ error: "A view needs a name of up to 60 characters" }, 400);
  const f = await viewFilters(entity, body.filters ?? []);
  if ("error" in f) return c.json({ error: f.error }, 400);
  const sort = typeof body.sort === "string" && VIEW_FIELD_KEY.test(body.sort) ? body.sort : null;
  const order = body.order === "asc" || body.order === "desc" ? body.order : null;
  await ensureDefaultView(entity);
  const last = await get<{ p: number | null }>("SELECT MAX(position) as p FROM views WHERE entity_type = ?", [entity]);
  const id = crypto.randomUUID();
  await run(
    "INSERT INTO views (id, entity_type, name, icon, is_default, position, filters, sort, sort_order) VALUES (?, ?, ?, 'table', 0, ?, ?, ?, ?)",
    [id, entity, name, (last?.p ?? 0) + 1, f.json, sort, order],
  );
  if (typeof body.from === "string") {
    await run(
      `INSERT INTO view_fields (view_id, field_key, is_visible, size, aggregate)
       SELECT ?, field_key, is_visible, size, aggregate FROM view_fields
       WHERE view_id = (SELECT id FROM views WHERE id = ? AND entity_type = ?)`,
      [id, body.from, entity],
    );
  }
  const row = await get<ViewRow>("SELECT * FROM views WHERE id = ?", [id]);
  return c.json({ view: viewJson(row!) }, 201);
});

// Renames a view, or updates its filters and sort (the "Update view" button).
app.patch("/api/views/:id", async (c) => {
  const id = c.req.param("id");
  const prev = await get<ViewRow>("SELECT * FROM views WHERE id = ?", [id]);
  if (!prev) return c.json({ error: "View not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; filters?: unknown; sort?: unknown; order?: unknown };
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.name !== undefined) {
    const name = viewName(body.name);
    if (!name) return c.json({ error: "A view needs a name of up to 60 characters" }, 400);
    sets.push("name = ?"); params.push(name);
  }
  if (body.filters !== undefined) {
    const f = await viewFilters(prev.entity_type as EntityType, body.filters);
    if ("error" in f) return c.json({ error: f.error }, 400);
    sets.push("filters = ?"); params.push(f.json);
  }
  if (body.sort !== undefined) {
    sets.push("sort = ?"); params.push(typeof body.sort === "string" && VIEW_FIELD_KEY.test(body.sort) ? body.sort : null);
  }
  if (body.order !== undefined) {
    sets.push("sort_order = ?"); params.push(body.order === "asc" || body.order === "desc" ? body.order : null);
  }
  if (sets.length) await run(`UPDATE views SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, [...params, id]);
  const row = await get<ViewRow>("SELECT * FROM views WHERE id = ?", [id]);
  return c.json({ view: viewJson(row!) }, 200);
});

// Deletes a view for everyone. The list's default view stays.
app.delete("/api/views/:id", async (c) => {
  const id = c.req.param("id");
  const prev = await get<ViewRow>("SELECT * FROM views WHERE id = ?", [id]);
  if (!prev) return c.json({ error: "View not found" }, 404);
  if (prev.is_default === 1) return c.json({ error: "The default view can't be deleted" }, 400);
  await run("DELETE FROM view_fields WHERE view_id = ?", [id]);
  await run("DELETE FROM views WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

export default app;
