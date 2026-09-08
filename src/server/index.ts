import { createApp, createRoute, z } from "@clawnify/app";
import freemailDomains from "free-email-domains";
import { query, get, run } from "./db.js";
import type { CredentialBinding } from "@clawnify/connections";
import { sendEmail, createMeeting, notifySlack, connectionStatus } from "./integrations.js";
import {
  listDefs,
  createDef,
  updateDef,
  deleteDef,
  coerceCustomValue,
  classifyCustomWrite,
  missingRequiredCustom,
  writableFieldKeys,
  isEntityType,
  type EntityType,
  type CustomFieldDef,
} from "./custom-fields.js";

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
    if (!def) continue; // ignore unknown keys — only defined properties are writable
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
  const defByKey = new Map((await listDefs(entity)).map((d) => [d.key, d]));
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
  title: "CRM App",
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
  filters: z.string().optional().openapi({ description: 'JSON array of {field, op, value} — op ∈ contains|is|is_not|is_empty|is_not_empty|gt|lt' }),
});

/** Real column names of a table (from sqlite). Used to validate sort/filter
 *  fields against actual columns — the safe allowlist for built-ins + custom. */
async function tableColumns(table: string): Promise<Set<string>> {
  const rows = await query<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => r.name));
}

const qid = (col: string) => `"${col.replace(/"/g, '""')}"`;

interface Filter { field: string; op: string; value?: string }

/** Build safe WHERE clauses from a JSON filter list. Fields are validated
 *  against `cols` (real columns), so identifiers are never user-controlled;
 *  values are always parameterised. */
function buildFilters(cols: Set<string>, raw: string | undefined, prefix = ""): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let filters: Filter[] = [];
  try { const a = JSON.parse(raw || "[]"); if (Array.isArray(a)) filters = a; } catch { /* ignore */ }
  for (const f of filters) {
    if (!f || typeof f.field !== "string" || !cols.has(f.field)) continue;
    const col = `${prefix}${qid(f.field)}`;
    const v = f.value ?? "";
    switch (f.op) {
      case "contains": clauses.push(`${col} LIKE ?`); params.push(`%${v}%`); break;
      case "is": clauses.push(`${col} = ?`); params.push(v); break;
      case "is_not": clauses.push(`(${col} IS NULL OR ${col} != ?)`); params.push(v); break;
      case "is_empty": clauses.push(`(${col} IS NULL OR ${col} = '')`); break;
      case "is_not_empty": clauses.push(`(${col} IS NOT NULL AND ${col} != '')`); break;
      case "gt": clauses.push(`${col} > ?`); params.push(Number(v)); break;
      case "lt": clauses.push(`${col} < ?`); params.push(Number(v)); break;
      default: break;
    }
  }
  return { clauses, params };
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
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listCompanies, async (c) => {
  try {
    const q = c.req.valid("query");
    const page = Math.max(1, parseInt(q.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10)));
    const offset = (page - 1) * limit;
    const search = (q.search || "").trim();
    const industry = (q.industry || "").trim();

    const cols = await tableColumns("companies");
    let sortCol = q.sort || "id";
    if (!cols.has(sortCol)) sortCol = "id";
    let order = (q.order || "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";

    const where: string[] = [];
    const params: unknown[] = [];

    if (search) {
      where.push("(name LIKE ? OR domain LIKE ? OR email LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (industry) {
      where.push("industry = ?");
      params.push(industry);
    }
    const flt = buildFilters(cols, q.filters);
    where.push(...flt.clauses);
    params.push(...flt.params);

    const whereSQL = where.length ? " WHERE " + where.join(" AND ") : "";

    const countResult = await get<{ total: number }>(
      "SELECT COUNT(*) as total FROM companies" + whereSQL,
      [...params],
    );
    const total = countResult?.total || 0;

    const rows = await query(
      `SELECT c.*, (SELECT COUNT(*) FROM contacts WHERE company_id = c.id) as contact_count
       FROM companies c${whereSQL} ORDER BY c.${qid(sortCol)} ${order}, c.id LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return c.json({ companies: rows, total, page, limit }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
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
    const name = body.name.trim();
    if (!name) return c.json({ error: "Name is required" }, 400);

    const id = crypto.randomUUID();
    await run(
      "INSERT INTO companies (id, name, domain, industry, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, name, (body.domain || "").trim(), (body.industry || "").trim(), (body.phone || "").trim(), (body.email || "").trim(), (body.notes || "").trim()],
    );

    await applyCustomValues("company", "companies", id, customValues);

    const inserted = await get("SELECT * FROM companies WHERE id = ?", [id]);
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

    const updated = await get("SELECT * FROM companies WHERE id = ?", [id]);
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
    return c.json({ ok: true }, 200);
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
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listContacts, async (c) => {
  try {
    const q = c.req.valid("query");
    const page = Math.max(1, parseInt(q.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10)));
    const offset = (page - 1) * limit;
    const search = (q.search || "").trim();
    const status = (q.status || "").trim();
    const companyId = q.company_id || "";

    const cols = await tableColumns("contacts");
    let sortCol = q.sort || "id";
    if (!cols.has(sortCol)) sortCol = "id";
    let order = (q.order || "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";

    const where: string[] = [];
    const params: unknown[] = [];

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
    const flt = buildFilters(cols, q.filters, "ct.");
    where.push(...flt.clauses);
    params.push(...flt.params);

    const whereSQL = where.length ? " WHERE " + where.join(" AND ") : "";

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
       ORDER BY ct.${qid(sortCol)} ${order}, ct.id
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return c.json({ contacts: rows, total, page, limit }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
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
    return c.json({ contact: inserted }, 201);
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
    return c.json({ contact: updated }, 200);
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
    return c.json({ ok: true }, 200);
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
  summary: "Get all deals for the pipeline board view",
  responses: {
    200: { description: "All deals with contact/company info", content: { "application/json": { schema: z.object({ deals: z.array(DealSchema) }) } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getDealsBoard, async (c) => {
  try {
    const rows = await query(
      `SELECT d.*,
              ct.first_name as contact_first_name, ct.last_name as contact_last_name,
              co.name as company_name, co.domain as company_domain
       FROM deals d
       LEFT JOIN contacts ct ON d.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id
       ORDER BY d.created_at ASC`,
    );
    return c.json({ deals: rows }, 200);
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

    return c.json({ deals: rows, total, page, limit, totalValue: agg?.total_value || 0 }, 200);
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
    return c.json({ deal: inserted }, 201);
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
    return c.json({ deal: updated }, 200);
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
    return c.json({ contact }, 200);
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
    return c.json({ company }, 200);
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

export default app;
