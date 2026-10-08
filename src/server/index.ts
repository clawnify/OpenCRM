import { createApp, createRoute, widgets, z, caller, user } from "@clawnify/app";
import { verifyDelivery } from "@clawnify/queue";
import { query, get, run } from "./db.js";
import type { CredentialBinding } from "@clawnify/connections";
import { sendEmail, replyToThread, forwardMessage, createMeeting, notifySlack, connectionStatus, mailConnection } from "./integrations.js";
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
import { workEmailDomain, findOrCreateCompanyByDomain } from "./email-domains.js";
import {
  connectedMailbox, currentAccount, accountFor, runSync, scheduleRun, ensureScheduled, cancelScheduled, listLabels,
  purge, restartImport, forgetSubjects, firstStep, contactEmails, importContactIfNeeded, openEmail, knownEmail, counts,
  VISIBILITIES, AUTO_CREATES, HISTORIES, LIVE_INTERVAL_MS, type EmailAccount,
} from "./email-sync.js";
import { normaliseBlocklist } from "./email-sync-rules.js";
import {
  AI_ENTITIES, FILL_LIMIT, FillError, eligibleFields, fieldSpec, listColumns, getColumn, saveColumn, removeColumn,
  openCells, queueFill, queueCell, runQueued, scheduleRun as scheduleAiRun,
} from "./ai-columns.js";
import {
  syncSettings, saveSettings, runMeetings, scheduleRun as scheduleMeetingsRun, ensureScheduled as ensureMeetingsScheduled,
  cancelScheduled as cancelMeetingsScheduled, listMeetings, getMeeting, linkMeeting, retryDigest, counts as meetingCounts,
  HISTORY_DAYS, LIVE_INTERVAL_MS as MEETINGS_INTERVAL_MS, type MeetingSync,
} from "./meetings.js";
import { customersOverview } from "./customers.js";
import { dealsProgress, SEVERITY, type ProgressDeal } from "./deal-progress.js";
import { withRelations, relationWriteError, relationSortSQL, detachRelations, searchRecords, manyLinks, countSQL, countOf, type ManyLink } from "./relations.js";

// In production Clawnify injects the CREDENTIALS broker binding + CLAWNIFY_ORG_ID
// whenever clawnify.json declares `app.credentials`. SLACK_CHANNEL is an optional
// custom env var: when set (and Slack is connected), won deals auto-notify it.
type Env = {
  Bindings: {
    DB: D1Database;
    CREDENTIALS?: CredentialBinding;
    CLAWNIFY_ORG_ID?: string;
    SLACK_CHANNEL?: string;
    // The org token (injected at build) reaches the platform queue, which chains
    // Gmail sync runs and AI fills, and the platform's model endpoint, which
    // AI columns call. The URLs are only set off-platform, to point them at a
    // local stand-in.
    CLAWNIFY_TOKEN?: string;
    CLAWNIFY_API_URL?: string;
    CLAWNIFY_QUEUE_URL?: string;
    CLAWNIFY_SERVICES_URL?: string;
  };
};

/** Split an array into fixed-size chunks. Used to keep bulk SQL within D1's
 * 100-bound-parameter limit (the same cap applies to the preview-tier Facet). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** A real calendar day written as YYYY-MM-DD. */
function isDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
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
  customer_since: z.string().nullable().optional().openapi({ description: "The day they became a customer (YYYY-MM-DD); null = not a customer. Set from the close date of their first won deal" }),
  renewal_date: z.string().nullable().optional().openapi({ description: "The next renewal (YYYY-MM-DD); null = none. Within 30 days, or past, it shows on the Customers page" }),
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
  last_contacted_at: z.string().nullable().optional().openapi({ description: "Newest synced email with this contact (Gmail sync). Read-only" }),
  company_name: z.string().nullable().optional(),
  company_domain: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Contact");

const SyncStateSchema = z.enum(["seen", "off", "importing", "failing"]).openapi({ description: "seen: on and working; off; importing: the first import hasn't finished; failing: the latest run failed" });

const NextStepSchema = z.object({
  kind: z.enum(["meeting", "task"]),
  title: z.string(),
  at: z.string().openapi({ description: "The meeting's start (ISO 8601) or the task's due day (YYYY-MM-DD)" }),
  owed_by: z.enum(["us", "them"]).nullable().openapi({ description: "Who owes a task; null for a meeting" }),
  overdue: z.boolean(),
}).openapi("NextStep");

const DealProgressSchema = z.object({
  status: z.enum(["red", "yellow", "green", "unknown"]),
  reasons: z.array(z.string()).openapi({ description: "Why, worst first, in plain words. Empty when on track." }),
  next_step: NextStepSchema.nullable().openapi({ description: "The soonest of the next meeting booked with the deal's company and its open tasks with a date. Null: nobody agreed on what happens next." }),
  last_touch_at: z.string().nullable().openapi({ description: "The latest call, email or logged touch with the deal's company" }),
  days_quiet: z.number().int().nullable(),
}).openapi("DealProgress");

const DealSchema = z.object({
  id: z.string(),
  name: z.string(),
  contact_id: z.string().nullable(),
  company_id: z.string().nullable(),
  value: z.number(),
  stage: z.string(),
  close_date: z.string(),
  notes: z.string(),
  contact_first_name: z.string().nullable().optional(),
  contact_last_name: z.string().nullable().optional(),
  company_name: z.string().nullable().optional(),
  company_domain: z.string().nullable().optional(),
  progress: DealProgressSchema.nullable().optional().openapi({ description: "How an open deal is moving (board and single-deal reads). Null for a won or lost deal." }),
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
function buildFilters(cols: Set<string>, raw: string | undefined, prefix = "", tzOffset = 0, many: Record<string, ManyLink> = {}): { clauses: string[]; params: unknown[] } {
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

  // A one_to_many field has no column here: it matches through the linked
  // records that point back at this row (`prefix` must name the row's table).
  const manyLeaf = (link: ManyLink, r: FilterRule): string | null => {
    const linked = `SELECT 1 FROM ${link.table} m WHERE m.${qid(link.fk)} = ${prefix}id`;
    const ids = Array.isArray(r.value) ? r.value.filter((v): v is string => typeof v === "string") : [];
    switch (r.op) {
      case "is_empty": return `NOT EXISTS (${linked})`;
      case "is_not_empty": return `EXISTS (${linked})`;
      case "is": case "is_not": {
        if (!ids.length) return null;
        params.push(...ids);
        const any = `EXISTS (${linked} AND m.id IN (${ids.map(() => "?").join(", ")}))`;
        return r.op === "is" ? any : `NOT ${any}`;
      }
      default: return null;
    }
  };

  // "count:<many side>" compares how many records link back: Contacts count ≥ 3.
  const countLeaf = (link: ManyLink, r: FilterRule): string | null => {
    if (r.op === "is_empty") return `${countSQL(link, prefix)} = 0`;
    if (r.op === "is_not_empty") return `${countSQL(link, prefix)} > 0`;
    const n = Number(typeof r.value === "string" || typeof r.value === "number" ? r.value : NaN);
    const op = ({ is: "=", is_not: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as Record<string, string>)[String(r.op)];
    if (!op || !Number.isFinite(n)) return null;
    params.push(n);
    return `${countSQL(link, prefix)} ${op} ?`;
  };

  const leaf = (r: FilterRule): string | null => {
    const counted = typeof r.field === "string" ? countOf(r.field) : null;
    if (counted && many[counted] && prefix) return countLeaf(many[counted], r);
    if (typeof r.field === "string" && typeof r.op === "string" && many[r.field] && prefix) return manyLeaf(many[r.field], r);
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
        customers: z.number().int().openapi({ description: "Companies that are customers (customer_since set)" }),
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
    await backfillCustomers();
    const customers = await get<{ count: number }>("SELECT COUNT(*) as count FROM companies WHERE customer_since IS NOT NULL AND TRIM(customer_since) != ''");
    return c.json({
      contacts: contacts?.count || 0,
      companies: companies?.count || 0,
      deals: deals?.count || 0,
      dealValue: dealValue?.total || 0,
      customers: customers?.count || 0,
    }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Dashboard widgets ──────────────────────────────────────────────
// Tiles the Clawnify dashboard shows on its home page while the CRM is closed
// (GET /api/widgets). Data only: the dashboard draws them. Each value is one
// aggregate query. Money is USD, matching formatMoney in the client.

const WEEKS = 12;
// Every widget summarises deals, so each carries the Deals section's tile:
// the same icon and colour as the "deals" item of the <AppNav> in
// client/app.tsx. Keep the two in step.
const DEALS = { icon: "dollar-sign", color: "green" } as const;

/** Monday (UTC) of the week `weeksAgo` weeks before this one, as YYYY-MM-DD. */
function weekStart(weeksAgo: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - weeksAgo * 7);
  return d.toISOString().slice(0, 10);
}

widgets(app, async () => {
  const since = weekStart(WEEKS - 1);
  const [thisMonth, open, byStage, weekly, latest] = await Promise.all([
    get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM deals WHERE created_at >= date('now', 'start of month')",
    ),
    get<{ total: number }>(
      "SELECT COALESCE(SUM(value), 0) AS total FROM deals WHERE stage IN (SELECT key FROM stages WHERE is_won = 0 AND is_lost = 0)",
    ),
    query<{ label: string; total: number }>(
      `SELECT s.label, COALESCE(SUM(d.value), 0) AS total
         FROM stages s JOIN deals d ON d.stage = s.key
        WHERE s.is_won = 0 AND s.is_lost = 0
        GROUP BY s.key ORDER BY total DESC LIMIT 12`,
    ),
    // date(x, '-6 days', 'weekday 1') is the Monday on or before x.
    query<{ wk: string; n: number }>(
      `SELECT date(created_at, '-6 days', 'weekday 1') AS wk, COUNT(*) AS n
         FROM deals WHERE created_at >= ? GROUP BY wk`,
      [since],
    ),
    query<{ name: string; value: number }>(
      "SELECT name, value FROM deals ORDER BY created_at DESC, rowid DESC LIMIT 5",
    ),
  ]);

  const perWeek = new Map(weekly.map((r) => [r.wk, r.n]));
  const usd = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  return [
    { key: "deals-this-month", kind: "metric", title: "Deals created this month", value: thisMonth?.n ?? 0, at: "/deals", ...DEALS },
    { key: "open-pipeline", kind: "metric", title: "Open pipeline value", value: open?.total ?? 0, format: "currency", currency: "USD", at: "/deals", ...DEALS },
    {
      key: "pipeline-by-stage", kind: "breakdown", title: "Open pipeline by stage", format: "currency", currency: "USD", at: "/deals", ...DEALS,
      items: byStage.map((r) => ({ label: r.label.slice(0, 80), value: r.total })),
    },
    {
      key: "deals-per-week", kind: "series", title: "Deals created per week", at: "/deals", ...DEALS,
      points: Array.from({ length: WEEKS }, (_, i) => {
        const wk = weekStart(WEEKS - 1 - i);
        return { x: wk, y: perWeek.get(wk) ?? 0 };
      }),
    },
    {
      key: "latest-deals", kind: "list", title: "Latest deals", at: "/deals", ...DEALS,
      items: latest.map((d) => ({ label: d.name.slice(0, 80), meta: usd(d.value ?? 0) })),
    },
  ];
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
function companiesWhere(q: { search?: string; industry?: string; filters?: string; tz?: string }, cols: Set<string>, many: Record<string, ManyLink> = {}) {
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
  const flt = buildFilters(cols, q.filters, "c.", tzOffsetOf(q.tz), many);
  where.push(...flt.clauses);
  params.push(...flt.params);
  return { whereSQL: where.length ? " WHERE " + where.join(" AND ") : "", params };
}

// Registered before /api/companies/{id}, which would otherwise take "aggregates" as an id.
app.get("/api/companies/aggregates", async (c) => {
  try {
    const q = c.req.query();
    const cols = await tableColumns("companies");
    const { whereSQL, params } = companiesWhere(q, cols, await manyLinks("company"));
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
    const many = await manyLinks("company");
    let sortCol = q.sort || "id";
    const counted = countOf(sortCol);
    const countSort = counted && many[counted] ? countSQL(many[counted], "c.") : null;
    if (!countSort && !cols.has(sortCol)) sortCol = "id";
    let order = (q.order || "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";
    const sortSQL = countSort ?? (await relationSortSQL("company", "c", sortCol)) ?? `c.${qid(sortCol)}`;

    const { whereSQL, params } = companiesWhere(q, cols, many);

    const countResult = await get<{ total: number }>(
      "SELECT COUNT(*) as total FROM companies c" + whereSQL,
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
        customer_since: z.string().nullable().optional().openapi({ description: "YYYY-MM-DD makes the company a customer from that day; null or \"\" makes it not a customer" }),
        renewal_date: z.string().nullable().optional().openapi({ description: "The next renewal as YYYY-MM-DD; null or \"\" clears it. Move it on after each renewal" }),
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
    if (body.customer_since !== undefined) {
      const day = (body.customer_since ?? "").trim();
      if (day && !isDay(day)) return c.json({ error: "customer_since must be a date as YYYY-MM-DD" }, 400);
      fields.push("customer_since = ?");
      params.push(day || null);
    }
    if (body.renewal_date !== undefined) {
      const day = (body.renewal_date ?? "").trim();
      if (day && !isDay(day)) return c.json({ error: "renewal_date must be a date as YYYY-MM-DD" }, 400);
      fields.push("renewal_date = ?");
      params.push(day || null);
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
function contactsWhere(q: { search?: string; status?: string; company_id?: string; filters?: string; tz?: string }, cols: Set<string>, many: Record<string, ManyLink> = {}) {
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
  const flt = buildFilters(cols, q.filters, "ct.", tzOffsetOf(q.tz), many);
  where.push(...flt.clauses);
  params.push(...flt.params);
  return { whereSQL: where.length ? " WHERE " + where.join(" AND ") : "", params };
}

// Registered before /api/contacts/{id}, which would otherwise take "aggregates" as an id.
app.get("/api/contacts/aggregates", async (c) => {
  try {
    const q = c.req.query();
    const cols = await tableColumns("contacts");
    const { whereSQL, params } = contactsWhere(q, cols, await manyLinks("contact"));
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
    const many = await manyLinks("contact");
    let sortCol = q.sort || "id";
    const counted = countOf(sortCol);
    const countSort = counted && many[counted] ? countSQL(many[counted], "ct.") : null;
    if (!countSort && !cols.has(sortCol)) sortCol = "id";
    let order = (q.order || "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";
    const sortSQL = countSort ?? (await relationSortSQL("contact", "ct", sortCol)) ?? `ct.${qid(sortCol)}`;

    const { whereSQL, params } = contactsWhere(q, cols, many);

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

/** Each open deal's progress (deal-progress.ts), with the default stages in place first: on a new database they are what says which deals are closed. */
async function progressOf(...args: Parameters<typeof dealsProgress>): ReturnType<typeof dealsProgress> {
  await ensureStagesSeeded();
  return dealsProgress(...args);
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

// A deal row as every deal route returns it: its own columns plus the names
// of its contact and of its own company (deals.company_id, not the contact's).
const DEAL_SELECT = `SELECT d.*,
       ct.first_name as contact_first_name, ct.last_name as contact_last_name,
       co.name as company_name, co.domain as company_domain
  FROM deals d
  LEFT JOIN contacts ct ON d.contact_id = ct.id
  LEFT JOIN companies co ON d.company_id = co.id`;

/** The company a contact works at, which a deal takes when it has none of its own. */
async function contactCompany(contactId: string | null): Promise<string | null> {
  if (!contactId) return null;
  return (await get<{ company_id: string | null }>("SELECT company_id FROM contacts WHERE id = ?", [contactId]))?.company_id ?? null;
}

let dealCompaniesBackfilled = false; // per-isolate fast path

/**
 * Deals predate deals.company_id: until it existed, a deal showed its
 * contact's company. Gives those deals that company, once per database, so
 * they read the same after the column arrives. The marker is written after
 * the update, so a failed run is retried; it is what stops a later run from
 * refilling a company someone cleared on purpose.
 */
async function backfillDealCompanies(): Promise<void> {
  if (dealCompaniesBackfilled) return;
  const done = await get("SELECT key FROM data_backfills WHERE key = 'deals.company_id'");
  if (!done) {
    await run(
      `UPDATE deals SET company_id = (SELECT company_id FROM contacts WHERE contacts.id = deals.contact_id)
       WHERE company_id IS NULL AND contact_id IS NOT NULL`,
    );
    await run("INSERT OR IGNORE INTO data_backfills (key) VALUES ('deals.company_id')");
  }
  dealCompaniesBackfilled = true;
}

let customersBackfilled = false; // per-isolate fast path

/** The day a won deal makes its company a customer: its close date, never later than today (a close date is often the planned one), or today when it has none. */
function wonDay(closeDate: unknown): string {
  const today = new Date().toISOString().slice(0, 10);
  const close = typeof closeDate === "string" ? closeDate.trim() : "";
  return isDay(close) && close < today ? close : today;
}

/** A company is a customer from the day its first deal closed won. A date already there (set by a person, or by an earlier win) stays. */
async function markCustomer(companyId: string, day: string): Promise<void> {
  await run(
    "UPDATE companies SET customer_since = ?, updated_at = datetime('now') WHERE id = ? AND (customer_since IS NULL OR TRIM(customer_since) = '')",
    [day, companyId],
  );
}

/**
 * Deals won before customer_since existed: their companies become customers
 * from the first one's close date (or the day it was last changed, when it has
 * none), never later than today, once per database. Like backfillDealCompanies, the marker is what stops
 * a later run from refilling a date someone cleared on purpose.
 */
async function backfillCustomers(): Promise<void> {
  if (customersBackfilled) return;
  const done = await get("SELECT key FROM data_backfills WHERE key = 'companies.customer_since'");
  if (!done) {
    await backfillDealCompanies();
    await run(
      `UPDATE companies SET customer_since = min((
          SELECT MIN(CASE WHEN d.close_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN d.close_date ELSE date(d.updated_at) END)
            FROM deals d JOIN stages s ON s.key = d.stage AND s.is_won = 1
           WHERE d.company_id = companies.id), date('now'))
        WHERE (customer_since IS NULL OR TRIM(customer_since) = '')
          AND EXISTS (SELECT 1 FROM deals d JOIN stages s ON s.key = d.stage AND s.is_won = 1 WHERE d.company_id = companies.id)`,
    );
    await run("INSERT OR IGNORE INTO data_backfills (key) VALUES ('companies.customer_since')");
  }
  customersBackfilled = true;
}

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
    await backfillDealCompanies();
    const flt = buildFilters(await tableColumns("deals"), q.filters, "d.", tzOffsetOf(q.tz), await manyLinks("deal"));
    const whereSQL = flt.clauses.length ? " WHERE " + flt.clauses.join(" AND ") : "";
    const rows = await query(DEAL_SELECT + whereSQL + " ORDER BY d.created_at ASC", flt.params);
    const deals = await withRelations("deal", rows as Record<string, unknown>[]);
    const { progress } = await progressOf(deals as unknown as ProgressDeal[], new Date(), tzOffsetOf(q.tz));
    return c.json({ deals: deals.map((d) => ({ ...d, progress: progress.get(String(d.id)) ?? null })) }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, err instanceof FilterError ? 400 : 500);
  }
});

const dealsProgressRoute = createRoute({
  method: "get",
  path: "/api/deals/progress",
  tags: ["Deals"],
  summary: "Open deals, worst first: each one's next step and the reasons to look at it",
  description: "An open deal is one whose stage is neither won nor lost. Its next step is the soonest of the next meeting booked with its company and its open tasks with a date (ours or theirs). Red: one of our promises is overdue, the last call went badly, a risk is open, or no next step and no contact in 14 days. Yellow: no next step, no contact in 14 days, waiting on them, the close date has passed, or the mood dropped. Contact is a call, an email, or a call, message, email or meeting logged on the deal, its company or its contacts; silence is judged only through what the CRM can see, and the reason says what it can't. Unknown: nothing against the deal and no way to judge contact.",
  request: {
    query: z.object({
      tz: z.string().optional().openapi({ description: "Viewer's UTC offset in minutes (e.g. 120), for what counts as overdue today" }),
      limit: z.string().optional().openapi({ description: "Default 100, max 500" }),
    }),
  },
  responses: {
    200: {
      description: "Open deals, worst first, then the biggest",
      content: { "application/json": { schema: z.object({
        deals: z.array(DealSchema),
        total: z.number().int(),
        counts: z.object({ red: z.number().int(), yellow: z.number().int(), unknown: z.number().int(), green: z.number().int() }),
        sight: z.object({ calls: SyncStateSchema, emails: SyncStateSchema }).openapi({ description: "Whether the CRM can see calls and emails at all" }),
      }) } },
    },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(dealsProgressRoute, async (c) => {
  try {
    const q = c.req.valid("query");
    await backfillDealCompanies();
    const rows = await query<Record<string, unknown> & { id: string; name: string; value: number }>(DEAL_SELECT + " ORDER BY d.created_at ASC");
    const { progress, sight } = await progressOf(rows as unknown as ProgressDeal[], new Date(), tzOffsetOf(q.tz));
    const open = rows
      .filter((d) => progress.has(String(d.id)))
      .map((d) => ({ ...d, progress: progress.get(String(d.id))! }))
      .sort((a, b) => SEVERITY[a.progress.status] - SEVERITY[b.progress.status]
        || (Number(b.value) || 0) - (Number(a.value) || 0)
        || String(a.name).localeCompare(String(b.name)));
    const counts = { red: 0, yellow: 0, unknown: 0, green: 0 };
    for (const d of open) counts[d.progress.status]++;
    const limit = Math.min(500, Math.max(1, parseInt(q.limit || "100", 10) || 100));
    const deals = await withRelations("deal", open.slice(0, limit));
    return c.json({ deals: deals as unknown as z.infer<typeof DealSchema>[], total: open.length, counts, sight }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
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
      company_id: z.string().optional().openapi({ description: "Filter by company ID" }),
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
    await backfillDealCompanies();
    const page = Math.max(1, parseInt(q.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10)));
    const offset = (page - 1) * limit;
    const search = (q.search || "").trim();
    const stage = (q.stage || "").trim();
    const contactId = q.contact_id || "";
    const companyId = q.company_id || "";

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
    if (companyId) {
      where.push("d.company_id = ?");
      params.push(companyId);
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
      `${DEAL_SELECT}
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
        company_id: z.string().nullable().optional().openapi({ description: "The deal's company. Omitted, it is the contact's company" }),
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
    const companyId = body.company_id !== undefined ? (body.company_id ? String(body.company_id) : null) : await contactCompany(contactId);
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
      "INSERT INTO deals (id, name, contact_id, company_id, value, stage, close_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, name, contactId, companyId, value, stageKey, (body.close_date || "").trim(), (body.notes || "").trim()],
    );

    await applyCustomValues("deal", "deals", id, customValues);
    if (companyId && (await getStageRow(stageKey))?.is_won) await markCustomer(companyId, wonDay(body.close_date));

    const inserted = await get(DEAL_SELECT + " WHERE d.id = ?", [id]);
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
        company_id: z.string().nullable().optional().openapi({ description: "The deal's company. Setting a contact on a deal without one also sets it, to the contact's company" }),
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
    if (body.company_id !== undefined) {
      fields.push("company_id = ?");
      params.push(body.company_id ? String(body.company_id) : null);
    }

    const hasCustom = Object.keys(customValues).length > 0;
    if (fields.length === 0 && !hasCustom) return c.json({ error: "No fields to update" }, 400);

    await backfillDealCompanies();
    const exists = await get<{ company_id: string | null }>("SELECT id, company_id FROM deals WHERE id = ?", [id]);
    if (!exists) return c.json({ error: "Deal not found" }, 404);

    // A contact set on a deal with no company brings its company along.
    if (body.contact_id && body.company_id === undefined && !exists.company_id) {
      const inherited = await contactCompany(String(body.contact_id));
      if (inherited) {
        fields.push("company_id = ?");
        params.push(inherited);
      }
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      params.push(id);
      await run("UPDATE deals SET " + fields.join(", ") + " WHERE id = ?", params);
    }
    await applyCustomValues("deal", "deals", id, customValues);

    const updated = await get<Record<string, unknown>>(DEAL_SELECT + " WHERE d.id = ?", [id]);

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
        // Their first won deal makes the company a customer (the Customers page), from its close date.
        if (updated.company_id) await markCustomer(String(updated.company_id), wonDay(updated.close_date));
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

// mailbox: the address email goes out from, known once email sync has been set up.
app.get("/api/integrations/status", async (c) => {
  const mailbox = (await currentAccount().catch(() => null))?.mailbox ?? null;
  try {
    return c.json({ ...(await connectionStatus(c.env)), mailbox }, 200);
  } catch {
    return c.json({ email: false, meeting: false, slack: false, notes: false, mailbox }, 200);
  }
});

// Send from the connected Gmail: a new email, a reply inside a synced thread
// (reply_to), or a forward of a synced email (forward). Every recipient who is
// a contact gets it on their timeline. contact_id is shorthand for "to this
// contact" and still works on its own.
const MAX_RECIPIENTS = 50;
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Lower-cased, de-duplicated addresses, or the first one that isn't an address. */
function addressList(v: unknown): { ok: string[] } | { bad: string } {
  if (v === undefined || v === null) return { ok: [] };
  if (!Array.isArray(v)) return { bad: String(v) };
  const out: string[] = [];
  for (const raw of v) {
    const e = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(e)) return { bad: String(raw) };
    if (!out.includes(e)) out.push(e);
  }
  return { ok: out };
}

type MessageRef = { mailbox: string; id: string };
const messageRef = (v: unknown): MessageRef | null =>
  v && typeof v === "object" && typeof (v as MessageRef).mailbox === "string" && typeof (v as MessageRef).id === "string"
    ? { mailbox: (v as MessageRef).mailbox.trim().toLowerCase(), id: (v as MessageRef).id.trim() }
    : null;

app.post("/api/integrations/email", async (c) => {
  try {
    const body = await c.req.json<{
      contact_id?: string; to?: unknown; cc?: unknown; bcc?: unknown;
      subject?: string; body?: string; reply_to?: unknown; forward?: unknown;
    }>();
    const subject = (body.subject || "").trim();
    const text = (body.body || "").trim();
    const replyTo = body.reply_to === undefined ? null : messageRef(body.reply_to);
    const forward = body.forward === undefined ? null : messageRef(body.forward);
    if (body.reply_to !== undefined && !replyTo) return c.json({ error: "reply_to must be { mailbox, id }" }, 400);
    if (body.forward !== undefined && !forward) return c.json({ error: "forward must be { mailbox, id }" }, 400);
    if (replyTo && forward) return c.json({ error: "Send a reply or a forward, not both" }, 400);

    const lists = { to: addressList(body.to), cc: addressList(body.cc), bcc: addressList(body.bcc) };
    for (const [field, l] of Object.entries(lists)) {
      if ("bad" in l) return c.json({ error: `${field}: "${l.bad}" is not an email address` }, 400);
    }
    const to = (lists.to as { ok: string[] }).ok;
    const cc = (lists.cc as { ok: string[] }).ok;
    const bcc = (lists.bcc as { ok: string[] }).ok;

    const contactId = (body.contact_id || "").trim();
    if (contactId) {
      const contact = await get<{ email: string }>("SELECT lower(trim(email)) AS email FROM contacts WHERE id = ?", [contactId]);
      if (!contact) return c.json({ error: "Contact not found" }, 404);
      if (!contact.email) return c.json({ error: "Contact has no email address" }, 400);
      if (!to.includes(contact.email)) to.unshift(contact.email);
    }
    if (!to.length) return c.json({ error: "Add at least one recipient" }, 400);
    if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) return c.json({ error: `At most ${MAX_RECIPIENTS} recipients per email` }, 400);

    let logged: string;
    if (replyTo || forward) {
      const ref = (replyTo ?? forward)!;
      const known = await knownEmail(ref.mailbox, ref.id);
      if (!known) return c.json({ error: "Email not found" }, 404);
      // A forward carries the email's text to someone new, so it needs the mailbox to share everything.
      if (forward && known.visibility !== "everything") return c.json({ error: "This mailbox shares metadata only; forward the email from Gmail" }, 403);
      const original = known.visibility === "metadata" ? "" : (known.subject ?? "");
      if (replyTo) {
        if (!text) return c.json({ error: "Write a reply first" }, 400);
        await replyToThread(c.env, { to, cc, bcc, threadId: known.thread_id, body: text });
        logged = original ? `Re: ${original.replace(/^re:\s*/i, "")}` : "Reply";
      } else {
        await forwardMessage(c.env, { to, cc, bcc, messageId: ref.id, note: text });
        logged = original ? `Fwd: ${original.replace(/^fwd?:\s*/i, "")}` : "Forwarded email";
      }
    } else {
      if (!subject && !text) return c.json({ error: "A subject or body is required" }, 400);
      await sendEmail(c.env, { to, cc, bcc, subject, body: text });
      logged = subject || "(no subject)";
    }

    const everyone = [...to, ...cc, ...bcc];
    const contacts = await query<{ id: string }>(
      `SELECT id FROM contacts WHERE lower(trim(email)) IN (${everyone.map(() => "?").join(", ")})`,
      everyone,
    );
    const ids = new Set([...contacts.map((r) => r.id), ...(contactId ? [contactId] : [])]);
    for (const id of ids) await logActivity("contact", id, "email", logged, { to, ...(cc.length ? { cc } : {}) });
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

// ── Gmail sync ─────────────────────────────────────────────────────
//
// The org's connected Gmail, read into the CRM: for each email with a contact,
// who wrote to whom and when (email-sync.ts). The body stays in Gmail. What the
// team sees of each email is the mailbox's visibility setting, applied here for
// every caller: people, agents and other apps get the same view.
//
// Changing the settings is a person's decision, made in the browser
// (caller "user"). Agents and apps can read synced emails and trigger a sync,
// never change what a mailbox shares.

/** Whether this caller may change a mailbox's sync settings. */
const mayConfigure = (c: Parameters<typeof caller>[0]) => caller(c) === "user" && !!user(c);

function accountView(a: EmailAccount) {
  return {
    mailbox: a.mailbox,
    enabled: !!a.enabled,
    labels: safeArray(a.labels),
    history: a.history,
    visibility: a.visibility,
    auto_create: a.auto_create,
    exclude_group: !!a.exclude_group,
    exclude_personal: !!a.exclude_personal,
    blocklist: safeArray(a.blocklist),
    phase: a.phase,
    synced_until: a.synced_until,
    contacts_created: a.contacts_created,
    last_run_at: a.last_run_at,
    last_error: a.last_error,
    next_run_at: a.next_run_at,
    updated_by: a.updated_by,
    updated_at: a.updated_at,
  };
}

function safeArray(v: string | null): unknown[] {
  try {
    const parsed = JSON.parse(v ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// The mailbox, its settings and where the sync is. Also the watchdog: an enabled
// mailbox with no run booked gets one, so a lost queue job heals on next view.
// `?check=1` also asks Google which account the connection signs in as (the
// settings page does; the contacts page's banner reads stored state only).
app.get("/api/email-sync", async (c) => {
  try {
    const mail = await mailConnection(c.env);
    let connected: string | null = null;
    if (mail && c.req.query("check") === "1") {
      try {
        connected = await connectedMailbox(mail);
      } catch {
        connected = null;
      }
    }
    // The mailbox being synced when there is one, else the connected one's last settings.
    const current = await currentAccount();
    const account = current?.enabled ? current : ((connected ? await accountFor(connected) : null) ?? current);
    const mailbox = connected ?? account?.mailbox ?? null;
    if (account?.enabled) await ensureScheduled(c.env, new URL(c.req.url).origin, account);
    return c.json({
      connected: !!mail,
      mailbox,
      // The Google connection now signs in as a different mailbox than the one synced.
      mailbox_changed: !!(account?.enabled && connected && connected !== account.mailbox),
      account: account ? accountView(account) : null,
      counts: account ? await counts(account.mailbox) : { emails: 0, contacts: 0 },
      can_configure: mayConfigure(c),
    }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Save settings; turning sync on or off is part of the same write. Turning off
// deletes everything synced from the mailbox. Narrowing what is imported starts
// the import over; showing less deletes what is no longer shown.
app.put("/api/email-sync", async (c) => {
  try {
    if (!mayConfigure(c)) return c.json({ error: "Only a signed-in person can change email sync settings." }, 403);
    const body = await c.req.json<Record<string, unknown>>();
    const who = user(c)?.email ?? user(c)?.id ?? null;

    const mail = await mailConnection(c.env);
    if (!mail) return c.json({ error: "Connect Gmail in Clawnify first." }, 409);
    const mailbox = await connectedMailbox(mail);
    // One mailbox syncs at a time. If the Google connection now signs in as
    // another account, what was synced from the old one goes, as when turning off.
    for (const old of await query<EmailAccount>("SELECT * FROM email_accounts WHERE mailbox != ? AND enabled = 1", [mailbox])) {
      await cancelScheduled(c.env, old);
      await purge(old.mailbox);
      await run("UPDATE email_accounts SET enabled = 0 WHERE mailbox = ?", [old.mailbox]);
    }
    const before = await accountFor(mailbox);
    const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
      const v = body[key];
      if (v === undefined) return fallback;
      if (typeof v !== "string" || !allowed.includes(v as T)) throw new SettingsError(`${key} must be one of ${allowed.join(", ")}`);
      return v as T;
    };
    const bool = (key: string, fallback: boolean): boolean => {
      const v = body[key];
      if (v === undefined) return fallback;
      if (typeof v !== "boolean") throw new SettingsError(`${key} must be true or false`);
      return v;
    };
    const labels = body.labels === undefined ? safeArray(before?.labels ?? "[]") : body.labels;
    if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string" || !l.trim())) throw new SettingsError("labels must be a list of Gmail label names");
    const blocklist = body.blocklist === undefined ? safeArray(before?.blocklist ?? "[]") : normaliseBlocklist(body.blocklist);

    const next = {
      enabled: bool("enabled", !!before?.enabled),
      labels: JSON.stringify([...new Set((labels as string[]).map((l) => l.trim()))]),
      history: pick("history", HISTORIES, before?.history ?? "12m"),
      visibility: pick("visibility", VISIBILITIES, before?.visibility ?? "metadata"),
      auto_create: pick("auto_create", AUTO_CREATES, before?.auto_create ?? "sent"),
      exclude_group: bool("exclude_group", before ? !!before.exclude_group : true),
      exclude_personal: bool("exclude_personal", before ? !!before.exclude_personal : true),
      blocklist: JSON.stringify(blocklist),
    };

    await run(
      `INSERT INTO email_accounts (mailbox, enabled, labels, history, visibility, auto_create, exclude_group, exclude_personal, blocklist, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (mailbox) DO UPDATE SET enabled = excluded.enabled, labels = excluded.labels, history = excluded.history,
         visibility = excluded.visibility, auto_create = excluded.auto_create, exclude_group = excluded.exclude_group,
         exclude_personal = excluded.exclude_personal, blocklist = excluded.blocklist, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
      [mailbox, next.enabled ? 1 : 0, next.labels, next.history, next.visibility, next.auto_create,
        next.exclude_group ? 1 : 0, next.exclude_personal ? 1 : 0, next.blocklist, who],
    );
    const origin = new URL(c.req.url).origin;
    const now = new Date();

    if (!next.enabled) {
      if (before?.enabled) {
        await cancelScheduled(c.env, before);
        await purge(mailbox);
      }
    } else {
      const scopeChanged = !!before && (before.labels !== next.labels || before.history !== next.history || before.blocklist !== next.blocklist || before.exclude_group !== (next.exclude_group ? 1 : 0));
      const showsMore = !!before && VISIBILITIES.indexOf(next.visibility) > VISIBILITIES.indexOf(before.visibility) && before.visibility === "metadata";
      const createsMore = !!before && (AUTO_CREATES.indexOf(next.auto_create) > AUTO_CREATES.indexOf(before.auto_create) || (!!before.exclude_personal && !next.exclude_personal));
      if (!before?.enabled) {
        await restartImport(mailbox, firstStep(next), now);
      } else if (scopeChanged) {
        // What counts changed: forget what was imported under the old scope and read it again.
        await purge(mailbox);
        await restartImport(mailbox, firstStep(next), now);
      } else if (createsMore) {
        await restartImport(mailbox, firstStep(next), now);
      } else if (showsMore) {
        // Subjects were never stored at "metadata": read the contacts' emails again to fill them in.
        await restartImport(mailbox, "people", now);
      }
      if (next.visibility === "metadata" && before && before.visibility !== "metadata") await forgetSubjects(mailbox);
      await scheduleRun(c.env, origin, mailbox, now);
    }

    const saved = (await accountFor(mailbox))!;
    return c.json({ account: accountView(saved), counts: await counts(mailbox) }, 200);
  } catch (err: unknown) {
    if (err instanceof SettingsError) return c.json({ error: err.message }, 400);
    return c.json({ error: (err as Error).message }, 500);
  }
});

class SettingsError extends Error {}

// The mailbox's Gmail labels, for choosing "Some labels" to import.
app.get("/api/email-sync/labels", async (c) => {
  try {
    if (!mayConfigure(c)) return c.json({ error: "Only a signed-in person can change email sync settings." }, 403);
    const mail = await mailConnection(c.env);
    if (!mail) return c.json({ error: "Connect Gmail in Clawnify first." }, 409);
    return c.json({ labels: await listLabels(mail) }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// One bounded sync run, then book the next: at once while the first import has
// work left, otherwise in LIVE_INTERVAL_MS.
async function syncAndBook(env: Env["Bindings"], origin: string, raw: string): Promise<Record<string, unknown>> {
  let mailbox: string | undefined;
  try {
    mailbox = (JSON.parse(raw || "{}") as { mailbox?: string }).mailbox;
  } catch {
    mailbox = undefined;
  }
  mailbox = mailbox ?? (await currentAccount())?.mailbox;
  if (!mailbox) return { status: "off" };

  const result = await runSync(env, mailbox);
  if (result.status === "ran" || result.status === "error") {
    const delay = result.status === "error" ? 10 * 60_000 : result.more ? 0 : LIVE_INTERVAL_MS;
    await scheduleRun(env, origin, mailbox, new Date(Date.now() + delay));
  }
  const account = await accountFor(mailbox);
  return { ...result, account: account ? accountView(account) : null, counts: await counts(mailbox) };
}

// The platform queue's target: a signed delivery on a declared public route.
// A browser's request to a public route reaches the app with no identity (the
// platform drops it, so no other site can post here as you), which is why
// "Sync now" has its own route. Callers through the platform's API proxy keep theirs.
app.post("/api/email-sync/run", async (c) => {
  const raw = await c.req.text();
  const signed = await verifyDelivery(raw, {
    signature: c.req.header("X-Queue-Signature") ?? null,
    timestamp: c.req.header("X-Queue-Timestamp") ?? null,
    keyId: c.req.header("X-Queue-Key-Id") ?? null,
  }).catch(() => false);
  const who = caller(c);
  if (!signed && who !== "user" && who !== "api" && who !== "agent") {
    return c.json({ error: "Sign in to run a sync." }, 403);
  }
  try {
    return c.json(await syncAndBook(c.env, new URL(c.req.url).origin, raw), 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// "Sync now", for a person or an agent. Anonymous callers cannot make the app read a mailbox.
app.post("/api/email-sync/sync-now", async (c) => {
  const who = caller(c);
  if (who !== "user" && who !== "api" && who !== "agent") {
    return c.json({ error: "Sign in to run a sync." }, 403);
  }
  try {
    return c.json(await syncAndBook(c.env, new URL(c.req.url).origin, await c.req.text()), 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// A contact's synced emails, as the mailbox's visibility allows. A contact added
// after the first import has its history read here, once.
app.get("/api/contacts/:id/emails", async (c) => {
  try {
    const id = c.req.param("id");
    try {
      await importContactIfNeeded(c.env, id);
    } catch {
      /* Gmail unreachable: show what is already synced */
    }
    return c.json({ ...(await contactEmails(id)), sync_on: !!(await currentAccount())?.enabled }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// One email's text, read live from Gmail when the mailbox shares everything. Never stored.
app.get("/api/emails/:mailbox/:id", async (c) => {
  try {
    const result = await openEmail(c.env, decodeURIComponent(c.req.param("mailbox")).toLowerCase(), c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Meetings, tasks, insights, customers ───────────────────────────
//
// The calendar and Granola read into the CRM (meetings.ts), what calls produce
// (tasks and insights), and how each customer is doing (customers.ts). Turning
// the sync on and what it reads are a signed-in person's decisions, as for
// email; people, agents and other apps read everything and work the tasks.

const mayWrite = (c: Parameters<typeof caller>[0]) => ["user", "api", "agent"].includes(caller(c) ?? "");

function meetingSyncView(s: MeetingSync | null) {
  if (!s) return null;
  return {
    enabled: !!s.enabled,
    history_days: s.history_days,
    about: s.about,
    calendar_owner: s.calendar_owner,
    phase: s.phase,
    calendar_synced_at: s.calendar_synced_at,
    last_run_at: s.last_run_at,
    last_error: s.last_error,
    next_run_at: s.next_run_at,
    updated_by: s.updated_by,
    updated_at: s.updated_at,
  };
}

// Which sources are connected, the settings, and where the sync is. Also the
// watchdog: sync that is on with no run booked gets one.
app.get("/api/meetings/sync", async (c) => {
  try {
    const [status, s] = await Promise.all([connectionStatus(c.env), syncSettings()]);
    if (s?.enabled) await ensureMeetingsScheduled(c.env, new URL(c.req.url).origin, s);
    return c.json({
      sources: { calendar: status.meeting, notes: status.notes },
      settings: meetingSyncView(s),
      counts: await meetingCounts(),
      history_choices: HISTORY_DAYS,
      can_configure: mayConfigure(c),
    }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Turn the sync on or off, how far back it reads, and what we sell (it frames
// the ideas and expansion the AI notes). Off stops reading; what is in the CRM stays.
app.put("/api/meetings/sync", async (c) => {
  try {
    if (!mayConfigure(c)) return c.json({ error: "Only a signed-in person can change meeting sync settings." }, 403);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    if (body.history_days !== undefined && !HISTORY_DAYS.includes(body.history_days as number)) return c.json({ error: `history_days must be one of ${HISTORY_DAYS.join(", ")}` }, 400);
    if (body.about !== undefined && (typeof body.about !== "string" || body.about.length > 1000)) return c.json({ error: "about must be text under 1,000 characters" }, 400);
    if (body.enabled === true && !(await connectionStatus(c.env)).meeting) return c.json({ error: "Connect Google Calendar in Clawnify first." }, 409);
    const who = user(c)?.email ?? user(c)?.id ?? null;
    const { before, after } = await saveSettings({
      enabled: body.enabled as boolean | undefined,
      history_days: body.history_days as number | undefined,
      about: typeof body.about === "string" ? body.about.trim() : undefined,
    }, who);
    if (!after.enabled && before?.enabled) await cancelMeetingsScheduled(c.env, after);
    if (after.enabled && (!before?.enabled || after.phase === "importing")) await scheduleMeetingsRun(c.env, new URL(c.req.url).origin, new Date());
    return c.json({ settings: meetingSyncView(await syncSettings()), counts: await meetingCounts() }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// One bounded run, then book the next: at once while work is left, otherwise in MEETINGS_INTERVAL_MS.
async function meetingsRunAndBook(env: Env["Bindings"], origin: string, sync: boolean): Promise<Record<string, unknown>> {
  const result = await runMeetings(env, new Date(), { sync });
  if (result.status !== "busy" && result.status !== "off") {
    const delay = result.status === "error" ? 10 * 60_000 : result.more ? 0 : MEETINGS_INTERVAL_MS;
    await scheduleMeetingsRun(env, origin, new Date(Date.now() + delay));
  }
  return { ...result, settings: meetingSyncView(await syncSettings()), counts: await meetingCounts() };
}

// The platform queue's target: a signed delivery on a declared public route
// (see /api/email-sync/run for why people use the route below instead).
app.post("/api/meetings/run", async (c) => {
  const raw = await c.req.text();
  const signed = await verifyDelivery(raw, {
    signature: c.req.header("X-Queue-Signature") ?? null,
    timestamp: c.req.header("X-Queue-Timestamp") ?? null,
    keyId: c.req.header("X-Queue-Key-Id") ?? null,
  }).catch(() => false);
  if (!signed && !mayWrite(c)) return c.json({ error: "Sign in to run a sync." }, 403);
  try {
    return c.json(await meetingsRunAndBook(c.env, new URL(c.req.url).origin, false), 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// "Sync now", for a person or an agent: reads the calendar and Granola even when no read is due.
app.post("/api/meetings/sync-now", async (c) => {
  if (!mayWrite(c)) return c.json({ error: "Sign in to run a sync." }, 403);
  try {
    return c.json(await meetingsRunAndBook(c.env, new URL(c.req.url).origin, true), 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const PersonSchema = z.object({ email: z.string(), name: z.string().nullable() });
const MeetingSchema = z.object({
  id: z.string(),
  title: z.string(),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  attendees: z.array(PersonSchema).openapi({ description: "The people from outside the team" }),
  company_id: z.string().nullable(),
  company_name: z.string().nullable(),
  company_domain: z.string().nullable(),
  link_status: z.enum(["auto", "manual", "unmatched", "ignored"]).openapi({ description: "auto = linked by its attendees; manual = linked by a person; unmatched = waiting for a person; ignored = not an account meeting" }),
  calendar_url: z.string().nullable(),
  note_url: z.string().nullable().openapi({ description: "The Granola note, where the transcript is" }),
  has_note: z.boolean(),
  summary: z.string().nullable(),
  sentiment: z.number().int().nullable().openapi({ description: "How the call went, -2 (badly) to 2 (very well)" }),
  sentiment_reason: z.string().nullable(),
  digest_status: z.enum(["none", "queued", "running", "done", "error"]),
  digest_error: z.string().nullable(),
}).openapi("Meeting");

const listMeetingsRoute = createRoute({
  method: "get",
  path: "/api/meetings",
  tags: ["Meetings"],
  summary: "List meetings with people from outside (calendar + Granola), newest first",
  request: {
    query: z.object({
      company_id: z.string().optional().openapi({ description: "One company's meetings" }),
      link: z.enum(["unmatched", "ignored"]).optional().openapi({ description: "unmatched: meetings waiting to be linked to a company" }),
      when: z.enum(["upcoming", "past"]).optional().openapi({ description: "upcoming lists soonest first" }),
      limit: z.string().optional().openapi({ description: "Default 25, max 100" }),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Meetings", content: { "application/json": { schema: z.object({ meetings: z.array(MeetingSchema), total: z.number().int() }) } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listMeetingsRoute, async (c) => {
  try {
    const q = c.req.valid("query");
    return c.json(await listMeetings({
      company_id: q.company_id || undefined,
      link: q.link,
      when: q.when,
      limit: q.limit ? parseInt(q.limit, 10) || 25 : 25,
      offset: q.offset ? parseInt(q.offset, 10) || 0 : 0,
    }), 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const getMeetingRoute = createRoute({
  method: "get",
  path: "/api/meetings/{id}",
  tags: ["Meetings"],
  summary: "Get a meeting",
  request: { params: IdParam },
  responses: {
    200: { description: "The meeting", content: { "application/json": { schema: z.object({ meeting: MeetingSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getMeetingRoute, async (c) => {
  const meeting = await getMeeting(c.req.valid("param").id);
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);
  return c.json({ meeting }, 200);
});

const linkMeetingRoute = createRoute({
  method: "patch",
  path: "/api/meetings/{id}",
  tags: ["Meetings"],
  summary: "Link a meeting to a company, unlink it, or mark it as not an account meeting",
  description: "Linking reads the call (when it has a Granola note) and links the other unmatched meetings with people from the same domain. A company with no domain takes the domain of the people met.",
  request: {
    params: IdParam,
    body: { required: true, content: { "application/json": { schema: z.object({
      company_id: z.string().nullable().optional().openapi({ description: "The company; null unlinks" }),
      ignored: z.boolean().optional().openapi({ description: "true: not an account meeting (hidden from the unmatched list)" }),
    }) } } },
  },
  responses: {
    200: { description: "The meeting", content: { "application/json": { schema: z.object({ meeting: MeetingSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not allowed", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(linkMeetingRoute, async (c) => {
  if (!mayWrite(c)) return c.json({ error: "Sign in to change meetings." }, 403);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  if (body.ignored === undefined && body.company_id === undefined) return c.json({ error: "Send company_id or ignored" }, 400);
  if (body.company_id && !(await get("SELECT id FROM companies WHERE id = ?", [body.company_id]))) return c.json({ error: "Company not found" }, 400);
  const meeting = await linkMeeting(id, body.ignored ? { ignored: true } : { company_id: body.company_id ?? null });
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);
  if (meeting.digest_status === "queued") c.executionCtx.waitUntil(scheduleMeetingsRun(c.env, new URL(c.req.url).origin, new Date()));
  return c.json({ meeting }, 200);
});

const retryDigestRoute = createRoute({
  method: "post",
  path: "/api/meetings/{id}/digest",
  tags: ["Meetings"],
  summary: "Read a call again after its digest failed",
  request: { params: IdParam },
  responses: {
    200: { description: "Queued", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Not allowed", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Nothing to read", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(retryDigestRoute, async (c) => {
  if (!mayWrite(c)) return c.json({ error: "Sign in to change meetings." }, 403);
  if (!(await retryDigest(c.req.valid("param").id))) return c.json({ error: "This meeting has no Granola note, no company, or was already read." }, 409);
  c.executionCtx.waitUntil(scheduleMeetingsRun(c.env, new URL(c.req.url).origin, new Date()));
  return c.json({ ok: true }, 200);
});

// ── Tasks ──

const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  company_id: z.string().nullable(),
  company_name: z.string().nullable(),
  contact_id: z.string().nullable(),
  deal_id: z.string().nullable(),
  meeting_id: z.string().nullable().openapi({ description: "The call it was promised in" }),
  meeting_title: z.string().nullable(),
  meeting_starts_at: z.string().nullable(),
  owed_by: z.enum(["us", "them"]).openapi({ description: "us = we promised it; them = we're waiting on them" }),
  due_date: z.string().nullable().openapi({ description: "YYYY-MM-DD" }),
  done: z.boolean(),
  done_at: z.string().nullable(),
  quote: z.string().nullable().openapi({ description: "The words in the call it came from" }),
  created_by: z.string().nullable().openapi({ description: "ai while the task follows its call's company; otherwise the person who created it or moved it" }),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Task");

const TASK_SELECT = `SELECT t.*, co.name AS company_name, m.title AS meeting_title, m.starts_at AS meeting_starts_at
  FROM tasks t LEFT JOIN companies co ON co.id = t.company_id LEFT JOIN meetings m ON m.id = t.meeting_id`;

function taskView(r: Record<string, unknown>) {
  return { ...r, owed_by: r.owed_by === "them" ? "them" : "us", done: !!r.done_at } as z.infer<typeof TaskSchema>;
}

const listTasksRoute = createRoute({
  method: "get",
  path: "/api/tasks",
  tags: ["Tasks"],
  summary: "List tasks: open ones by due date (undated last), done ones newest first",
  request: {
    query: z.object({
      company_id: z.string().optional(),
      deal_id: z.string().optional().openapi({ description: "One deal's tasks: its own, and its company's that are on no deal" }),
      status: z.enum(["open", "done", "all"]).optional().openapi({ description: "Default open" }),
      owed_by: z.enum(["us", "them"]).optional(),
      limit: z.string().optional().openapi({ description: "Default 50, max 200" }),
    }),
  },
  responses: {
    200: { description: "Tasks", content: { "application/json": { schema: z.object({ tasks: z.array(TaskSchema) }) } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listTasksRoute, async (c) => {
  try {
    const q = c.req.valid("query");
    const where: string[] = [];
    const params: unknown[] = [];
    const status = q.status ?? "open";
    if (status === "open") where.push("t.done_at IS NULL");
    if (status === "done") where.push("t.done_at IS NOT NULL");
    if (q.company_id) { where.push("t.company_id = ?"); params.push(q.company_id); }
    if (q.deal_id) {
      // The deal's own tasks, and its company's (its own, else its contact's) on no deal.
      where.push(`(t.deal_id = ? OR (t.deal_id IS NULL AND t.company_id = (
        SELECT COALESCE(d.company_id, ct.company_id) FROM deals d LEFT JOIN contacts ct ON ct.id = d.contact_id WHERE d.id = ?)))`);
      params.push(q.deal_id, q.deal_id);
    }
    if (q.owed_by) { where.push("t.owed_by = ?"); params.push(q.owed_by); }
    const limit = Math.min(200, Math.max(1, parseInt(q.limit || "50", 10) || 50));
    const rows = await query<Record<string, unknown>>(
      `${TASK_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.done_at IS NOT NULL, CASE WHEN t.done_at IS NULL THEN COALESCE(t.due_date, '9999-12-31') END, t.done_at DESC, t.created_at DESC
       LIMIT ?`,
      [...params, limit],
    );
    return c.json({ tasks: rows.map(taskView) }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const TaskWrite = {
  title: z.string().optional(),
  company_id: z.string().nullable().optional(),
  contact_id: z.string().nullable().optional(),
  deal_id: z.string().nullable().optional(),
  owed_by: z.enum(["us", "them"]).optional(),
  due_date: z.string().nullable().optional().openapi({ description: "YYYY-MM-DD, or null for none" }),
};

/** A task write's links and date, checked; the error to answer, or the values to store. */
async function checkTaskWrite(body: { company_id?: string | null; contact_id?: string | null; deal_id?: string | null; due_date?: string | null }): Promise<string | null> {
  if (body.due_date && !isDay(body.due_date)) return "due_date must be a date as YYYY-MM-DD";
  if (body.company_id && !(await get("SELECT id FROM companies WHERE id = ?", [body.company_id]))) return "Company not found";
  if (body.contact_id && !(await get("SELECT id FROM contacts WHERE id = ?", [body.contact_id]))) return "Contact not found";
  if (body.deal_id && !(await get("SELECT id FROM deals WHERE id = ?", [body.deal_id]))) return "Deal not found";
  return null;
}

const createTaskRoute = createRoute({
  method: "post",
  path: "/api/tasks",
  tags: ["Tasks"],
  summary: "Create a task",
  request: { body: { required: true, content: { "application/json": { schema: z.object({ ...TaskWrite, title: z.string().min(1) }) } } } },
  responses: {
    201: { description: "Created task", content: { "application/json": { schema: z.object({ task: TaskSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not allowed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createTaskRoute, async (c) => {
  if (!mayWrite(c)) return c.json({ error: "Sign in to add tasks." }, 403);
  const body = c.req.valid("json");
  const title = body.title.trim().slice(0, 300);
  if (!title) return c.json({ error: "A task needs a title" }, 400);
  const problem = await checkTaskWrite(body);
  if (problem) return c.json({ error: problem }, 400);
  const id = crypto.randomUUID();
  await run(
    "INSERT INTO tasks (id, title, company_id, contact_id, deal_id, owed_by, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, title, body.company_id ?? null, body.contact_id ?? null, body.deal_id ?? null, body.owed_by ?? "us", body.due_date || null, user(c)?.email ?? caller(c) ?? null],
  );
  return c.json({ task: taskView((await get<Record<string, unknown>>(`${TASK_SELECT} WHERE t.id = ?`, [id]))!) }, 201);
});

const updateTaskRoute = createRoute({
  method: "put",
  path: "/api/tasks/{id}",
  tags: ["Tasks"],
  summary: "Update a task, or mark it done (done: true) or open again (done: false)",
  request: { params: IdParam, body: { required: true, content: { "application/json": { schema: z.object({ ...TaskWrite, done: z.boolean().optional() }) } } } },
  responses: {
    200: { description: "Updated task", content: { "application/json": { schema: z.object({ task: TaskSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not allowed", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateTaskRoute, async (c) => {
  if (!mayWrite(c)) return c.json({ error: "Sign in to change tasks." }, 403);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  if (!(await get("SELECT id FROM tasks WHERE id = ?", [id]))) return c.json({ error: "Task not found" }, 404);
  const problem = await checkTaskWrite(body);
  if (problem) return c.json({ error: problem }, 400);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.title !== undefined) {
    const title = body.title.trim().slice(0, 300);
    if (!title) return c.json({ error: "A task needs a title" }, 400);
    sets.push("title = ?"); params.push(title);
  }
  for (const key of ["company_id", "contact_id", "deal_id", "owed_by"] as const) {
    if (body[key] !== undefined) { sets.push(`${key} = ?`); params.push(body[key]); }
  }
  // A task moved to another company is the mover's: it no longer follows its call's company.
  // Only a real move counts (SET reads the row as it was), so resending the same company changes nothing.
  if (body.company_id !== undefined) {
    sets.push("created_by = CASE WHEN company_id IS NOT ? THEN ? ELSE created_by END");
    params.push(body.company_id, user(c)?.email ?? caller(c) ?? null);
  }
  if (body.due_date !== undefined) { sets.push("due_date = ?"); params.push(body.due_date || null); }
  if (body.done !== undefined) sets.push(body.done ? "done_at = COALESCE(done_at, datetime('now'))" : "done_at = NULL");
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);
  await run(`UPDATE tasks SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, [...params, id]);
  return c.json({ task: taskView((await get<Record<string, unknown>>(`${TASK_SELECT} WHERE t.id = ?`, [id]))!) }, 200);
});

const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/api/tasks/{id}",
  tags: ["Tasks"],
  summary: "Delete a task",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    403: { description: "Not allowed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteTaskRoute, async (c) => {
  if (!mayWrite(c)) return c.json({ error: "Sign in to change tasks." }, 403);
  await run("DELETE FROM tasks WHERE id = ?", [c.req.valid("param").id]);
  return c.json({ ok: true }, 200);
});

// ── Deal updates ──
//
// What happened on a deal that the CRM can't read on its own: a phone call, a
// WhatsApp or text message, an email from another inbox, a meeting moved or
// held in person. Usually logged by an agent the user told about it. A call,
// message, email or meeting is contact with the deal's company (deal-progress.ts);
// a note is not.

const DEAL_UPDATE_KINDS = ["call", "message", "email", "meeting", "note"] as const;

const dealUpdateRoute = createRoute({
  method: "post",
  path: "/api/deals/{id}/updates",
  tags: ["Deals"],
  summary: "Log what happened on a deal, what it finished, and its next step",
  description: "One call for an update the CRM can't read on its own (a phone call, a message, an email from another inbox, a meeting moved or held in person, or a note). It goes on the deal's timeline at the time it happened. done_task_ids marks open tasks the update finished. next_step adds what happens next as a task on the deal, with its date and who owes it. close_date moves the expected close. A call, message, email or meeting counts as contact with the deal's company; a note does not. Move the stage with PUT /api/deals/{id}.",
  request: {
    params: IdParam,
    body: { required: true, content: { "application/json": { schema: z.object({
      kind: z.enum(DEAL_UPDATE_KINDS).openapi({ description: "call, message, email, meeting: contact with them. note: anything else worth keeping." }),
      summary: z.string().min(1).max(2000).openapi({ description: "What happened, in a sentence or two: who, and what was said or agreed" }),
      at: z.string().optional().openapi({ description: "When it happened: ISO 8601, or YYYY-MM-DD. Default now. Never in the future: what will happen goes in next_step." }),
      done_task_ids: z.array(z.string()).max(20).optional().openapi({ description: "Open tasks of this deal (GET /api/tasks?deal_id=) that the update finished" }),
      next_step: z.object({
        title: z.string().min(1).max(300),
        due_date: z.string().openapi({ description: "YYYY-MM-DD" }),
        owed_by: z.enum(["us", "them"]).optional().openapi({ description: "Default us" }),
      }).optional().openapi({ description: "What happens next, by when, and who owes it: added as a task on the deal" }),
      close_date: z.string().optional().openapi({ description: "YYYY-MM-DD, when the expected close moved" }),
    }) } } },
  },
  responses: {
    201: { description: "Logged; the deal with its progress, and the next-step task", content: { "application/json": { schema: z.object({ deal: DealSchema, task: TaskSchema.nullable() }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not allowed", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/** "YYYY-MM-DD HH:MM:SS" (UTC), as SQLite's datetime('now') stores it, so the timeline sorts as one. */
function sqlTime(t: number): string {
  return new Date(t).toISOString().replace("T", " ").slice(0, 19);
}

app.openapi(dealUpdateRoute, async (c) => {
  if (!mayWrite(c)) return c.json({ error: "Sign in to log updates." }, 403);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const deal = await get<{ id: string; company_id: string | null; contact_id: string | null; account: string | null }>(
    `SELECT d.id, d.company_id, d.contact_id, COALESCE(d.company_id, ct.company_id) AS account
       FROM deals d LEFT JOIN contacts ct ON ct.id = d.contact_id WHERE d.id = ?`,
    [id],
  );
  if (!deal) return c.json({ error: "Deal not found" }, 404);
  const summary = body.summary.trim();
  if (!summary) return c.json({ error: "Say what happened in summary" }, 400);

  const now = Date.now();
  const future = "at is in the future: log what happened, and put what will happen in next_step";
  let at = now;
  if (body.at) {
    let t: number;
    if (isDay(body.at)) {
      // A day alone is judged against the viewer's today: today is now, an earlier day is its noon (UTC).
      const today = localDay(now, tzOffsetOf(c.req.query("tz")));
      if (body.at > today) return c.json({ error: future }, 400);
      t = body.at === today ? now : Date.parse(`${body.at}T12:00:00Z`);
    } else {
      t = Date.parse(body.at);
      if (Number.isNaN(t)) return c.json({ error: "at must be ISO 8601 or YYYY-MM-DD" }, 400);
      if (t > now + 5 * 60_000) return c.json({ error: future }, 400);
    }
    at = t;
  }
  if (body.next_step && !isDay(body.next_step.due_date)) return c.json({ error: "next_step.due_date must be a date as YYYY-MM-DD" }, 400);
  if (body.close_date && !isDay(body.close_date)) return c.json({ error: "close_date must be a date as YYYY-MM-DD" }, 400);
  const by = user(c)?.email ?? caller(c) ?? null;

  await run(
    "INSERT INTO activities (id, entity_type, entity_id, type, body, meta, created_at) VALUES (?, 'deal', ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), id, body.kind, summary, JSON.stringify({ logged_by: by }), sqlTime(at)],
  );
  // Only the deal's own open tasks, or its company's on no deal, can be closed from it.
  const done = [...new Set(body.done_task_ids ?? [])];
  if (done.length) {
    await run(
      `UPDATE tasks SET done_at = COALESCE(done_at, datetime('now')), updated_at = datetime('now')
        WHERE id IN (${done.map(() => "?").join(", ")}) AND done_at IS NULL
          AND (deal_id = ? OR (deal_id IS NULL AND company_id = ?))`,
      [...done, id, deal.account],
    );
  }
  let task: ReturnType<typeof taskView> | null = null;
  if (body.next_step) {
    const taskId = crypto.randomUUID();
    await run(
      "INSERT INTO tasks (id, title, company_id, contact_id, deal_id, owed_by, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [taskId, body.next_step.title.trim().slice(0, 300), deal.account, deal.contact_id, id, body.next_step.owed_by ?? "us", body.next_step.due_date, by],
    );
    task = taskView((await get<Record<string, unknown>>(`${TASK_SELECT} WHERE t.id = ?`, [taskId]))!);
  }
  if (body.close_date) await run("UPDATE deals SET close_date = ?, updated_at = datetime('now') WHERE id = ?", [body.close_date, id]);

  const fresh = (await get<Record<string, unknown>>(DEAL_SELECT + " WHERE d.id = ?", [id]))!;
  const { progress } = await progressOf([fresh as unknown as ProgressDeal], new Date(), tzOffsetOf(c.req.query("tz")));
  const view = { ...(await withRelationsOne("deal", fresh) as Record<string, unknown>), progress: progress.get(id) ?? null };
  return c.json({ deal: view as unknown as z.infer<typeof DealSchema>, task }, 201);
});

// ── Insights ──

const InsightSchema = z.object({
  id: z.string(),
  company_id: z.string().nullable().openapi({ description: "The call's company; null while the call is linked to none" }),
  company_name: z.string().nullable(),
  meeting_id: z.string().nullable(),
  meeting_title: z.string().nullable(),
  meeting_starts_at: z.string().nullable(),
  kind: z.enum(["idea", "expansion", "risk"]).openapi({ description: "idea = a use case worth proposing; expansion = room to grow the account; risk = a threat to the relationship" }),
  text: z.string(),
  quote: z.string().nullable(),
  status: z.enum(["open", "done", "dismissed"]),
  deal_id: z.string().nullable().openapi({ description: "The deal an expansion became" }),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Insight");

const INSIGHT_SELECT = `SELECT i.*, co.name AS company_name, m.title AS meeting_title, m.starts_at AS meeting_starts_at
  FROM insights i LEFT JOIN companies co ON co.id = i.company_id LEFT JOIN meetings m ON m.id = i.meeting_id`;

const listInsightsRoute = createRoute({
  method: "get",
  path: "/api/insights",
  tags: ["Insights"],
  summary: "List what calls said about accounts: ideas to propose, room to expand, risks. Newest first",
  request: {
    query: z.object({
      company_id: z.string().optional(),
      kind: z.enum(["idea", "expansion", "risk"]).optional(),
      status: z.enum(["open", "done", "dismissed", "all"]).optional().openapi({ description: "Default open" }),
      limit: z.string().optional().openapi({ description: "Default 50, max 200" }),
    }),
  },
  responses: {
    200: { description: "Insights", content: { "application/json": { schema: z.object({ insights: z.array(InsightSchema) }) } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listInsightsRoute, async (c) => {
  try {
    const q = c.req.valid("query");
    const where: string[] = [];
    const params: unknown[] = [];
    const status = q.status ?? "open";
    if (status !== "all") { where.push("i.status = ?"); params.push(status); }
    if (q.company_id) { where.push("i.company_id = ?"); params.push(q.company_id); }
    if (q.kind) { where.push("i.kind = ?"); params.push(q.kind); }
    const limit = Math.min(200, Math.max(1, parseInt(q.limit || "50", 10) || 50));
    const rows = await query<z.infer<typeof InsightSchema>>(
      `${INSIGHT_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(m.starts_at, i.created_at) DESC LIMIT ?`,
      [...params, limit],
    );
    return c.json({ insights: rows }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const updateInsightRoute = createRoute({
  method: "put",
  path: "/api/insights/{id}",
  tags: ["Insights"],
  summary: "Mark an insight done or dismissed, or open it again",
  request: { params: IdParam, body: { required: true, content: { "application/json": { schema: z.object({ status: z.enum(["open", "done", "dismissed"]) }) } } } },
  responses: {
    200: { description: "Updated insight", content: { "application/json": { schema: z.object({ insight: InsightSchema }) } } },
    403: { description: "Not allowed", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateInsightRoute, async (c) => {
  if (!mayWrite(c)) return c.json({ error: "Sign in to change insights." }, 403);
  const { id } = c.req.valid("param");
  await run("UPDATE insights SET status = ?, updated_at = datetime('now') WHERE id = ?", [c.req.valid("json").status, id]);
  const insight = await get<z.infer<typeof InsightSchema>>(`${INSIGHT_SELECT} WHERE i.id = ?`, [id]);
  if (!insight) return c.json({ error: "Insight not found" }, 404);
  return c.json({ insight }, 200);
});

const insightDealRoute = createRoute({
  method: "post",
  path: "/api/insights/{id}/deal",
  tags: ["Insights"],
  summary: "Turn an expansion into a deal at the first stage of the pipeline",
  request: { params: IdParam },
  responses: {
    201: { description: "The deal", content: { "application/json": { schema: z.object({ insight: InsightSchema, deal_id: z.string() }) } } },
    403: { description: "Not allowed", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Already a deal", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(insightDealRoute, async (c) => {
  if (!mayWrite(c)) return c.json({ error: "Sign in to create deals." }, 403);
  const { id } = c.req.valid("param");
  const insight = await get<z.infer<typeof InsightSchema>>(`${INSIGHT_SELECT} WHERE i.id = ?`, [id]);
  if (!insight) return c.json({ error: "Insight not found" }, 404);
  if (insight.deal_id) return c.json({ error: "This is already a deal" }, 409);
  if (!insight.company_id) return c.json({ error: "Link its call to a company first" }, 409);
  await ensureStagesSeeded();
  const first = await get<{ key: string }>("SELECT key FROM stages WHERE is_won = 0 AND is_lost = 0 ORDER BY position LIMIT 1");
  const dealId = crypto.randomUUID();
  await run(
    "INSERT INTO deals (id, name, company_id, stage, notes) VALUES (?, ?, ?, ?, ?)",
    [dealId, insight.text.slice(0, 120), insight.company_id, first?.key ?? "prospect", insight.quote ? `From a call: "${insight.quote}"` : ""],
  );
  await run("UPDATE insights SET deal_id = ?, status = 'done', updated_at = datetime('now') WHERE id = ?", [dealId, id]);
  return c.json({ insight: (await get<z.infer<typeof InsightSchema>>(`${INSIGHT_SELECT} WHERE i.id = ?`, [id]))!, deal_id: dealId }, 201);
});

// ── Customers ──


const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  customer_since: z.string(),
  renewal_date: z.string().nullable(),
  status: z.enum(["red", "yellow", "green", "unknown"]).openapi({ description: "unknown: nothing against the account, but the CRM can't see whether anyone has been in touch (the reasons say why)" }),
  reasons: z.array(z.string()).openapi({ description: "Why the status, worst first. Empty when on track" }),
  last_touch_at: z.string().nullable().openapi({ description: "The latest call or email" }),
  days_quiet: z.number().int().nullable(),
  last_meeting_at: z.string().nullable(),
  next_meeting_at: z.string().nullable(),
  last_summary: z.string().nullable(),
  last_sentiment: z.number().int().nullable(),
  ours_open: z.number().int(),
  ours_overdue: z.number().int(),
  theirs_open: z.number().int(),
  ideas: z.number().int(),
  expansion: z.number().int(),
  risks: z.number().int(),
}).openapi("Customer");

const customersRoute = createRoute({
  method: "get",
  path: "/api/customers",
  tags: ["Customers"],
  summary: "How each customer is doing (worst first), what to do first, and calls with customers in the next 7 days",
  description: "A customer is a company with customer_since set. Red: one of our promises is overdue, the last call went badly, a risk is open, or no contact in 45 days. Yellow: no contact in 21 days, waiting on them, the mood dropped, a renewal within 30 days (or past), or no contact yet. Silence is judged only through what the CRM can see (calls when the meeting sync is on, emails when the email sync is on and has read the account's contacts), and the reason names what it can't see. Unknown: nothing else against the account and no channel to judge it by.",
  request: { query: z.object({ tz: z.string().optional().openapi({ description: "Viewer's UTC offset in minutes (e.g. 120), for what counts as overdue today" }) }) },
  responses: {
    200: {
      description: "Customers",
      content: { "application/json": { schema: z.object({
        customers: z.array(CustomerSchema),
        focus: z.array(z.object({ kind: z.enum(["overdue", "reach_out", "renewal", "due_today", "risk"]), company_id: z.string(), company_name: z.string(), text: z.string(), task_id: z.string().optional() })),
        upcoming: z.array(z.object({ id: z.string(), title: z.string(), starts_at: z.string(), company_id: z.string(), company_name: z.string(), company_domain: z.string(), ours_open: z.number().int(), last_summary: z.string().nullable() })),
        counts: z.object({ red: z.number().int(), yellow: z.number().int(), unknown: z.number().int(), green: z.number().int() }),
        sight: z.object({
          calls: SyncStateSchema.openapi({ description: "The meeting sync" }),
          emails: SyncStateSchema.openapi({ description: "The email sync" }),
        }).openapi({ description: "Whether the CRM can see calls and emails at all" }),
      }) } },
    },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(customersRoute, async (c) => {
  try {
    await backfillCustomers();
    const tz = Number(c.req.valid("query").tz ?? 0);
    return c.json(await customersOverview(new Date(), Number.isFinite(tz) ? Math.max(-840, Math.min(840, tz)) : 0), 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── AI columns ─────────────────────────────────────────────────────
//
// A column whose empty cells the AI fills on request (ai-columns.ts). A fill
// takes at most FILL_LIMIT rows and only empty cells. Turning AI on or off for
// a column is a signed-in person's decision, since fills spend the org's
// credits; people and agents can then fill and regenerate cells.

const aiEntity = (v: string | undefined): EntityType | null =>
  (AI_ENTITIES as string[]).includes(v ?? "") ? (v as EntityType) : null;
const mayFill = (c: Parameters<typeof caller>[0]) => ["user", "api", "agent"].includes(caller(c) ?? "");

/** Fill now, in the background of this request, and book a queue run as the backstop. */
function startAiRun(c: { env: Env["Bindings"]; req: { url: string }; executionCtx: { waitUntil(p: Promise<unknown>): void } }) {
  const origin = new URL(c.req.url).origin;
  c.executionCtx.waitUntil(runQueued(c.env).then((r) => (r.more ? scheduleAiRun(c.env, origin, 0) : undefined)).catch(() => {}));
  c.executionCtx.waitUntil(scheduleAiRun(c.env, origin));
}

// The fields the AI may fill, the columns it fills, and cells in progress or failed.
app.get("/api/ai-columns", async (c) => {
  const entity = aiEntity(c.req.query("entity_type"));
  if (!entity) return c.json({ error: "entity_type must be company or contact" }, 400);
  const [fields, columns, cells] = await Promise.all([eligibleFields(entity), listColumns(entity), openCells(entity)]);
  return c.json({
    fields: fields.map(({ key, label, kind, options }) => ({ key, label, kind, options: options ?? null })),
    columns,
    cells,
    limit: FILL_LIMIT,
    can_configure: mayConfigure(c),
  }, 200);
});

// Turn AI on for a column, or change what it's told.
app.put("/api/ai-columns/:entity/:key", async (c) => {
  if (!mayConfigure(c)) return c.json({ error: "Only a signed-in person can set up AI for a column." }, 403);
  const entity = aiEntity(c.req.param("entity"));
  const key = c.req.param("key");
  if (!entity || !(await fieldSpec(entity, key))) return c.json({ error: "The AI can't fill this field." }, 400);
  const body = await c.req.json<{ prompt?: unknown; research?: unknown }>().catch(() => ({} as { prompt?: unknown; research?: unknown }));
  if (body.prompt !== undefined && typeof body.prompt !== "string") return c.json({ error: "prompt must be text" }, 400);
  const prompt = (body.prompt ?? "").trim();
  if (prompt.length > 2000) return c.json({ error: "Keep the instructions under 2,000 characters." }, 400);
  if (body.research !== undefined && typeof body.research !== "boolean") return c.json({ error: "research must be true or false" }, 400);
  // Left out, research keeps what the column had: saving instructions alone never switches it off.
  const research = body.research ?? !!(await getColumn(entity, key))?.research;
  const who = user(c)?.email ?? user(c)?.id ?? null;
  return c.json({ column: await saveColumn(entity, key, prompt, research, who) }, 200);
});

// Turn AI off for a column. Values it already wrote stay.
app.delete("/api/ai-columns/:entity/:key", async (c) => {
  if (!mayConfigure(c)) return c.json({ error: "Only a signed-in person can set up AI for a column." }, 403);
  const entity = aiEntity(c.req.param("entity"));
  if (!entity) return c.json({ error: "entity_type must be company or contact" }, 400);
  await removeColumn(entity, c.req.param("key"));
  return c.json({ ok: true }, 200);
});

// Fill the empty cells among these rows (the ones on screen, in order), at most FILL_LIMIT.
app.post("/api/ai-columns/:entity/:key/fill", async (c) => {
  if (!mayFill(c)) return c.json({ error: "Sign in to use AI." }, 403);
  const entity = aiEntity(c.req.param("entity"));
  if (!entity) return c.json({ error: "entity_type must be company or contact" }, 400);
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({} as { ids?: unknown }));
  if (!Array.isArray(body.ids)) return c.json({ error: "ids must be a list of record ids" }, 400);
  try {
    const result = await queueFill(entity, c.req.param("key"), body.ids.map(String));
    if (result.queued) startAiRun(c);
    return c.json(result, 200);
  } catch (err) {
    if (err instanceof FillError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// Write this one cell again, replacing its value.
app.post("/api/ai-columns/:entity/:key/cells/:id", async (c) => {
  if (!mayFill(c)) return c.json({ error: "Sign in to use AI." }, 403);
  const entity = aiEntity(c.req.param("entity"));
  const key = c.req.param("key");
  const id = c.req.param("id");
  if (!entity || !(await fieldSpec(entity, key))) return c.json({ error: "The AI can't fill this field." }, 400);
  if (!(await getColumn(entity, key))) return c.json({ error: "Turn on AI for this column first" }, 409);
  const exists = await get(`SELECT 1 AS ok FROM "${ENTITY_TABLES[entity]}" WHERE id = ?`, [id]);
  if (!exists) return c.json({ error: "Record not found" }, 404);
  await queueCell(entity, id, key, true);
  startAiRun(c);
  return c.json({ queued: 1 }, 200);
});

// One bounded run over the queued cells. Called by the platform queue (a
// signed delivery on a declared public route) or by a person or agent.
app.post("/api/ai-columns/run", async (c) => {
  const raw = await c.req.text();
  const signed = await verifyDelivery(raw, {
    signature: c.req.header("X-Queue-Signature") ?? null,
    timestamp: c.req.header("X-Queue-Timestamp") ?? null,
    keyId: c.req.header("X-Queue-Key-Id") ?? null,
  }).catch(() => false);
  if (!signed && !mayFill(c)) return c.json({ error: "Sign in to use AI." }, 403);
  const result = await runQueued(c.env);
  if (result.more) await scheduleAiRun(c.env, new URL(c.req.url).origin, 0);
  return c.json(result, 200);
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

app.get("/api/deals/:id", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Not found" }, 404);
    await backfillDealCompanies();
    const deal = await get<Record<string, unknown>>(DEAL_SELECT + " WHERE d.id = ?", [id]);
    if (!deal) return c.json({ error: "Deal not found" }, 404);
    const { progress } = await progressOf([deal as unknown as ProgressDeal], new Date(), tzOffsetOf(c.req.query("tz")));
    return c.json({ deal: { ...(await withRelationsOne("deal", deal) as Record<string, unknown>), progress: progress.get(id) ?? null } }, 200);
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
// A view's sort: a column, or "count:<many side>" (most contacts first).
const VIEW_SORT = /^(count:)?[a-z][a-z0-9_]*$/;
const DEFAULT_VIEW_NAMES: Record<EntityType, string> = { contact: "All contacts", company: "All companies", deal: "All deals" };

interface ViewRow {
  id: string; entity_type: string; name: string; icon: string; is_default: number; position: number;
  filters: string; sort: string | null; sort_order: string | null;
}
// The default view ("All contacts") is the whole list: it holds no filters or
// sort, and reads that way even if a row from before the lock holds some.
const viewJson = (v: ViewRow) => {
  const isDefault = v.is_default === 1;
  let filters: unknown = [];
  try { filters = JSON.parse(v.filters || "[]"); } catch { /* a bad row reads as no filters */ }
  return {
    id: v.id, entity: v.entity_type, name: v.name, icon: v.icon, isDefault, position: v.position,
    filters: !isDefault && Array.isArray(filters) ? filters : [],
    sort: isDefault ? null : v.sort,
    order: isDefault ? null : v.sort_order === "asc" ? "asc" : v.sort_order === "desc" ? "desc" : null,
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
  const sort = typeof body.sort === "string" && VIEW_SORT.test(body.sort) ? body.sort : null;
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
  if (prev.is_default === 1 && (body.filters !== undefined || body.sort !== undefined || body.order !== undefined)) {
    return c.json({ error: `"${prev.name}" is the whole list and is locked: save the filters and sort as a new view instead (POST /api/views)` }, 400);
  }
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
    sets.push("sort = ?"); params.push(typeof body.sort === "string" && VIEW_SORT.test(body.sort) ? body.sort : null);
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
