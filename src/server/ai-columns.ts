// AI columns: a column whose empty cells the AI fills from the rest of the
// record, on request. A fill takes at most FILL_LIMIT rows, so a wrong prompt
// on a long list spends little; filling more is another request. Nothing fills
// on its own (not a new record, not an import), and a fill only writes into a
// cell that is still empty, so it never overwrites what a person typed. Only
// "regenerate" on one cell replaces a value, because someone asked for it.
//
// Which fields can be AI: any field a person edits, except the record's name,
// its email, phone and company domain (the Gmail sync and email actions rely
// on them being real), links to other records, and system fields.
//
// The model is called through the Clawnify platform with the org's token, so
// each call is charged to the org's credits and follows its data region.

import { renderMarkdown } from "@clawnify/services";
import { complete, ModelError, type AiEnv } from "./model.js";
import { get, query, run } from "./db.js";
import { ENTITY_TABLES, listDefs, coerceCustomValue, type CustomFieldDef, type EntityType } from "./custom-fields.js";

/** At most this many rows per fill. */
export const FILL_LIMIT = 20;
/** Cells filled at once within a run. */
const CONCURRENCY = 5;
/** A cell left "running" this long was dropped by its run and is queued again. */
const STALE_MS = 3 * 60_000;
/** A run stops taking new cells after this long: a request's background work ends ~30s after it answers. */
const RUN_BUDGET_MS = 25_000;
/** How much of a company's homepage the model reads: enough for what they do, cheap in tokens. */
const PAGE_CHARS = 12_000;
/** A page read is kept this long, so one read serves every fill for that company. */
const PAGE_TTL_DAYS = 30;
/** A page that couldn't be read is tried again after this long. */
const PAGE_RETRY_DAYS = 1;

export const AI_ENTITIES: EntityType[] = ["company", "contact"];

export interface AiColumn {
  entity_type: EntityType;
  field_key: string;
  prompt: string;
  research: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiCell {
  entity_type: EntityType;
  record_id: string;
  field_key: string;
  status: "queued" | "running" | "done" | "error";
  error: string | null;
  overwrite: number;
  updated_at: string;
}

/** What the AI may write into a field, and how it's told to. */
export interface FieldSpec {
  key: string;
  label: string;
  kind: "text" | "longtext" | "number" | "integer" | "boolean" | "date" | "enum";
  options?: string[];
  def?: CustomFieldDef;
}

const BUILTIN_AI: Record<EntityType, FieldSpec[]> = {
  company: [
    { key: "industry", label: "Industry", kind: "text" },
    { key: "notes", label: "Notes", kind: "longtext" },
  ],
  contact: [
    { key: "title", label: "Title", kind: "text" },
    { key: "status", label: "Status", kind: "enum", options: ["lead", "active", "inactive", "churned"] },
  ],
  deal: [
    { key: "value", label: "Amount", kind: "number" },
    { key: "close_date", label: "Close date", kind: "date" },
    { key: "notes", label: "Notes", kind: "longtext" },
  ],
};

/** Custom widgets that hold contact points or links: never guessed. */
const NEVER_AI_WIDGETS = new Set(["clawnify::url.url", "clawnify::email.email", "clawnify::phone.phone"]);

function customSpec(def: CustomFieldDef): FieldSpec | null {
  if (NEVER_AI_WIDGETS.has(def.custom_field)) return null;
  switch (def.field_type) {
    case "string": return { key: def.key, label: def.label, kind: "text", def };
    case "text": return { key: def.key, label: def.label, kind: "longtext", def };
    case "integer": return { key: def.key, label: def.label, kind: "integer", def };
    case "decimal": return { key: def.key, label: def.label, kind: "number", def };
    case "boolean": return { key: def.key, label: def.label, kind: "boolean", def };
    case "date": return { key: def.key, label: def.label, kind: "date", def };
    case "enumeration": {
      const options = Array.isArray(def.options.enum) ? def.options.enum.map(String) : [];
      return options.length ? { key: def.key, label: def.label, kind: "enum", options, def } : null;
    }
    default: return null; // datetime, json, relation
  }
}

/** Every field of this record type the AI may fill. */
export async function eligibleFields(entity: EntityType): Promise<FieldSpec[]> {
  const custom = (await listDefs(entity)).map(customSpec).filter((s): s is FieldSpec => !!s);
  return [...BUILTIN_AI[entity], ...custom];
}

export async function fieldSpec(entity: EntityType, key: string): Promise<FieldSpec | null> {
  return (await eligibleFields(entity)).find((f) => f.key === key) ?? null;
}

// ── Columns ──────────────────────────────────────────────────────────

export async function listColumns(entity: EntityType): Promise<AiColumn[]> {
  return query<AiColumn>("SELECT * FROM ai_columns WHERE entity_type = ? ORDER BY field_key", [entity]);
}

export async function getColumn(entity: EntityType, key: string): Promise<AiColumn | null> {
  return (await get<AiColumn>("SELECT * FROM ai_columns WHERE entity_type = ? AND field_key = ?", [entity, key])) ?? null;
}

export async function saveColumn(entity: EntityType, key: string, prompt: string, research: boolean, who: string | null): Promise<AiColumn> {
  await run(
    `INSERT INTO ai_columns (entity_type, field_key, prompt, research, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (entity_type, field_key) DO UPDATE SET prompt = excluded.prompt, research = excluded.research,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [entity, key, prompt, research ? 1 : 0, who],
  );
  return (await getColumn(entity, key))!;
}

/** Turning AI off keeps every value it wrote; only pending fills are dropped. */
export async function removeColumn(entity: EntityType, key: string): Promise<void> {
  await run("DELETE FROM ai_cells WHERE entity_type = ? AND field_key = ? AND status IN ('queued', 'error')", [entity, key]);
  await run("DELETE FROM ai_columns WHERE entity_type = ? AND field_key = ?", [entity, key]);
}

// ── Cells ────────────────────────────────────────────────────────────

/** Cells still being filled, or that failed, for the table to show. */
export async function openCells(entity: EntityType): Promise<Array<Pick<AiCell, "record_id" | "field_key" | "status" | "error">>> {
  return query(
    "SELECT record_id, field_key, status, error FROM ai_cells WHERE entity_type = ? AND status != 'done' ORDER BY updated_at DESC LIMIT 500",
    [entity],
  );
}

async function pendingCount(entity: EntityType, key: string): Promise<number> {
  const r = await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM ai_cells WHERE entity_type = ? AND field_key = ? AND status IN ('queued', 'running')",
    [entity, key],
  );
  return r?.n ?? 0;
}

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export class FillError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

/**
 * Queue the empty cells of `key` among `ids` (the rows the person is looking
 * at, in their order), at most FILL_LIMIT. Refused while this column still has
 * a fill running, so one column never has more than FILL_LIMIT rows in flight.
 */
export async function queueFill(entity: EntityType, key: string, ids: string[]): Promise<{ queued: number }> {
  if (!(await fieldSpec(entity, key))) throw new FillError("The AI can't fill this field", 400);
  if (!(await getColumn(entity, key))) throw new FillError("Turn on AI for this column first", 409);
  if ((await pendingCount(entity, key)) > 0) throw new FillError(`Still filling the last ${FILL_LIMIT} rows. Wait for them to finish.`, 409);
  const table = ENTITY_TABLES[entity];
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id))].slice(0, 200);
  if (!wanted.length) return { queued: 0 };
  const rows = await query<{ id: string; v: unknown }>(
    `SELECT id, "${key}" AS v FROM "${table}" WHERE id IN (${wanted.map(() => "?").join(", ")})`,
    wanted,
  );
  const empty = new Set(rows.filter((r) => isEmpty(r.v)).map((r) => r.id));
  const picked = wanted.filter((id) => empty.has(id)).slice(0, FILL_LIMIT);
  for (const id of picked) await queueCell(entity, id, key, false);
  return { queued: picked.length };
}

/** Queue one cell; `overwrite` replaces a value that is already there. */
export async function queueCell(entity: EntityType, recordId: string, key: string, overwrite: boolean): Promise<void> {
  await run(
    `INSERT INTO ai_cells (entity_type, record_id, field_key, status, error, overwrite, updated_at)
     VALUES (?, ?, ?, 'queued', NULL, ?, datetime('now'))
     ON CONFLICT (entity_type, record_id, field_key) DO UPDATE SET status = 'queued', error = NULL,
       overwrite = excluded.overwrite, updated_at = excluded.updated_at`,
    [entity, recordId, key, overwrite ? 1 : 0],
  );
}

// ── Filling ──────────────────────────────────────────────────────────

export type { AiEnv };

function ruleFor(spec: FieldSpec): string {
  switch (spec.kind) {
    case "enum": return `Answer with exactly one of: ${spec.options!.map((o) => JSON.stringify(o)).join(", ")}.`;
    case "number": return "Answer with a number, without units or currency symbols.";
    case "integer": return "Answer with a whole number.";
    case "boolean": return "Answer with true or false.";
    case "date": return "Answer with a date as YYYY-MM-DD.";
    case "longtext": return "Answer with a few sentences at most.";
    default: return "Answer with a short value, a few words at most, the way it would be typed into a CRM.";
  }
}

/** The record as the AI sees it: labelled, non-empty values, without ids and links. */
async function describeRecord(entity: EntityType, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hide = new Set(["id", "created_at", "updated_at", "last_contacted_at", "company_id", "contact_id"]);
  const defs = new Map((await listDefs(entity)).map((d) => [d.key, d]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    const def = defs.get(k);
    if (hide.has(k) || isEmpty(v) || def?.field_type === "relation") continue;
    out[def?.label ?? k.replace(/_/g, " ")] = v;
  }
  return out;
}

function interpolate(template: string, record: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, k: string) => (isEmpty(record[k]) ? "(empty)" : String(record[k])));
}

/** The model's answer, checked and shaped for the field; null when it had none. */
export function coerceAnswer(spec: FieldSpec, raw: string): string | number | null {
  let value: unknown;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    value = (JSON.parse(m ? m[0] : raw) as { value?: unknown }).value;
  } catch {
    throw new Error("The AI's answer wasn't readable");
  }
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  switch (spec.kind) {
    case "enum": {
      const s = String(value).trim();
      const hit = spec.options!.find((o) => o.toLowerCase() === s.toLowerCase());
      if (!hit) throw new Error(`The AI answered "${s}", which isn't one of the options`);
      return spec.def ? coerceCustomValue(hit, spec.def) : hit;
    }
    case "number":
    case "integer": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.eE+\-]/g, ""));
      if (!Number.isFinite(n)) throw new Error(`The AI answered "${value}", which isn't a number`);
      return spec.kind === "integer" ? Math.trunc(n) : n;
    }
    case "boolean": {
      const s = String(value).trim().toLowerCase();
      if (!["true", "false", "yes", "no", "1", "0"].includes(s)) throw new Error(`The AI answered "${value}", not true or false`);
      return ["true", "yes", "1"].includes(s) ? 1 : 0;
    }
    case "date": {
      const s = String(value).trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`The AI answered "${value}", which isn't a date`);
      return s;
    }
    case "longtext": return String(value).trim().slice(0, 2000);
    default: return String(value).trim().replace(/\s+/g, " ").slice(0, 200);
  }
}

/**
 * Whether a fill also gets the company's homepage as context: when the
 * instructions quote its domain ({{domain}} on a company, {{company_domain}}
 * on a contact), or quote no field at all, since instructions that name
 * nothing get everything. There is no switch.
 */
export function readsWebsite(entity: EntityType, prompt: string): boolean {
  const quoted = [...prompt.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]);
  return quoted.length === 0 || quoted.includes(entity === "company" ? "domain" : "company_domain");
}

/** A company's site as `https://host`, from whatever was typed in Domain; null when there is none. */
export function homepageUrl(domain: unknown): string | null {
  if (typeof domain !== "string") return null;
  const host = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? `https://${host}` : null;
}

interface CompanyPage {
  company_id: string;
  url: string;
  markdown: string | null;
  error: string | null;
  fetched_at: string;
}

/**
 * The company's homepage as markdown, through Clawnify's page reader
 * (services.clawnify.com/markdown/render, on the workspace's quota). A read is
 * kept PAGE_TTL_DAYS and a failed one PAGE_RETRY_DAYS, so a column of fills
 * reads each company's site once.
 */
async function companyPage(env: AiEnv, company: { id: unknown; domain: unknown }): Promise<{ url: string; markdown: string | null; error: string | null } | null> {
  const url = homepageUrl(company.domain);
  const id = typeof company.id === "string" ? company.id : null;
  if (!url || !id) return null;
  const cached = await get<CompanyPage>(
    `SELECT * FROM company_pages WHERE company_id = ? AND url = ?
       AND fetched_at > datetime('now', CASE WHEN markdown IS NULL THEN ? ELSE ? END)`,
    [id, url, `-${PAGE_RETRY_DAYS} days`, `-${PAGE_TTL_DAYS} days`],
  );
  if (cached) return { url, markdown: cached.markdown, error: cached.error };

  let markdown: string | null = null;
  let error: string | null = null;
  try {
    const page = await renderMarkdown(env, { url, maxChars: PAGE_CHARS, signal: AbortSignal.timeout(RUN_BUDGET_MS) });
    if (page.markdown.trim()) markdown = page.markdown;
    else error = "the page rendered no text";
  } catch (err) {
    error = (err as Error).message;
  }
  await run(
    `INSERT INTO company_pages (company_id, url, markdown, error, fetched_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (company_id) DO UPDATE SET url = excluded.url, markdown = excluded.markdown, error = excluded.error, fetched_at = excluded.fetched_at`,
    [id, url, markdown, error ? error.slice(0, 300) : null],
  );
  return { url, markdown, error };
}

/** Fill one cell: read the record, its company and the company's site, ask, check the answer, write it. */
async function fillCell(env: AiEnv, cell: Pick<AiCell, "entity_type" | "record_id" | "field_key" | "overwrite">): Promise<void> {
  const { entity_type: entity, record_id: id, field_key: key } = cell;
  const table = ENTITY_TABLES[entity];
  const spec = await fieldSpec(entity, key);
  const column = await getColumn(entity, key);
  const record = await get<Record<string, unknown>>(`SELECT * FROM "${table}" WHERE id = ?`, [id]);
  if (!spec || !column || !record) {
    await run("DELETE FROM ai_cells WHERE entity_type = ? AND record_id = ? AND field_key = ?", [entity, id, key]);
    return;
  }
  const company = entity === "contact" && record.company_id
    ? await get<Record<string, unknown>>("SELECT id, name, domain, industry FROM companies WHERE id = ?", [record.company_id])
    : null;
  // The site of the company the record is, or belongs to, unless the instructions quote other fields only.
  const siteOf = entity === "company" ? record : company;
  const page = siteOf && readsWebsite(entity, column.prompt) ? await companyPage(env, { id: siteOf.id, domain: siteOf.domain }) : null;
  // A contact's instructions can quote its company too.
  const vars = entity === "contact" ? { ...record, company_name: company?.name, company_domain: company?.domain } : record;

  const system = [
    "You fill in one field of a record in a CRM.",
    `The field is "${spec.label}". ${ruleFor(spec)}`,
    column.research
      ? "Use what the record below says, the company's website when it is given, and what a web search finds about this record. If that is not enough to answer, answer null rather than guess. Never make up contact details."
      : "Use only what the record below says, the company's website when it is given, and what is common knowledge about well-known companies. If that is not enough to answer, answer null rather than guess. Never make up contact details.",
    'Reply with JSON only: {"value": <your answer, or null>}.',
  ].join("\n");
  const user = [
    column.prompt.trim() ? `Instructions for this field: ${interpolate(column.prompt, vars)}` : "",
    `The ${entity}:\n${JSON.stringify(await describeRecord(entity, record), null, 2)}`,
    company ? `Their company:\n${JSON.stringify(Object.fromEntries(Object.entries(company).filter(([k, v]) => k !== "id" && !isEmpty(v))), null, 2)}` : "",
    page?.markdown ? `The company's website (${page.url}), as markdown:\n${page.markdown}` : "",
  ].filter(Boolean).join("\n\n");

  const value = coerceAnswer(spec, await complete(env, system, user, { research: !!column.research, timeoutMs: RUN_BUDGET_MS }));
  if (value === null) throw new Error("Not enough in the record to answer");
  const onlyIfEmpty = cell.overwrite ? "" : ` AND ("${key}" IS NULL OR TRIM("${key}") = '')`;
  await run(`UPDATE "${table}" SET "${key}" = ?, updated_at = datetime('now') WHERE id = ?${onlyIfEmpty}`, [value, id]);
}

/**
 * One run: take queued cells (and any a dropped run left "running"),
 * CONCURRENCY at a time, until none are left or the budget is spent, and
 * record each outcome. Returns whether cells are still waiting, so the caller
 * books another run.
 */
export async function runQueued(env: AiEnv): Promise<{ filled: number; failed: number; more: boolean }> {
  await run(
    `UPDATE ai_cells SET status = 'queued' WHERE status = 'running' AND updated_at < datetime('now', ?)`,
    [`-${Math.round(STALE_MS / 1000)} seconds`],
  );
  const started = Date.now();
  let filled = 0;
  let failed = 0;
  let outOfCredits = false;
  while (!outOfCredits && Date.now() - started < RUN_BUDGET_MS) {
    const claimed = await query<AiCell>(
      `UPDATE ai_cells SET status = 'running', updated_at = datetime('now')
       WHERE rowid IN (SELECT rowid FROM ai_cells WHERE status = 'queued' ORDER BY updated_at LIMIT ?)
       RETURNING *`,
      [CONCURRENCY],
    );
    if (!claimed.length) break;
    await Promise.all(claimed.map(async (cell) => {
      const where = [cell.entity_type, cell.record_id, cell.field_key];
      try {
        await fillCell(env, cell);
        await run("UPDATE ai_cells SET status = 'done', error = NULL, updated_at = datetime('now') WHERE entity_type = ? AND record_id = ? AND field_key = ?", where);
        filled++;
      } catch (err) {
        failed++;
        if (err instanceof ModelError && err.outOfCredits) outOfCredits = true;
        await run("UPDATE ai_cells SET status = 'error', error = ?, updated_at = datetime('now') WHERE entity_type = ? AND record_id = ? AND field_key = ?",
          [(err as Error).message.slice(0, 300), ...where]);
      }
    }));
  }
  if (outOfCredits) {
    // Stop every fill: nothing left can succeed until the org adds credits.
    await run("UPDATE ai_cells SET status = 'error', error = 'Out of Clawnify credits', updated_at = datetime('now') WHERE status IN ('queued', 'running')");
  }
  const left = await get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_cells WHERE status IN ('queued', 'running')");
  return { filled, failed, more: (left?.n ?? 0) > 0 };
}

/** Book a run on the platform queue, a minute out: the backstop for a run the request couldn't finish. */
export async function scheduleRun(env: AiEnv & { CLAWNIFY_QUEUE_URL?: string }, origin: string, delayMs = 60_000): Promise<void> {
  try {
    const { enqueueJob } = await import("@clawnify/queue");
    const runAt = new Date(Date.now() + delayMs);
    await enqueueJob(env, {
      targetUrl: `${origin}/api/ai-columns/run`,
      payload: {},
      runAt,
      idempotencyKey: `crm-ai-${new URL(origin).host}-${runAt.toISOString().slice(0, 16)}`,
      maxAttempts: 3,
    });
  } catch {
    /* no queue: the next fill or a page view picks the cells up */
  }
}
