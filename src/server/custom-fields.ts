/**
 * Custom properties — server side.
 *
 * A custom property is a user-defined field on an entity type. Each def maps to
 * a REAL column on the entity's table (added via ALTER TABLE at definition
 * time), so values are native, indexable columns rather than a JSON blob — the
 * repo's own convention (every queryable field is a column; JSON only for the
 * opaque `activities.meta` bag).
 *
 * This module owns: the `custom_field_defs` registry CRUD, the schema-sync that
 * keeps each entity table's columns in step with its defs, and value coercion
 * for the entity write paths.
 */

import { get, query, run } from "./db.js";

export type EntityType = "contact" | "company" | "deal";

/** Base storage types. Widget flavours (score, badge, url…) ride on these via
 *  `custom_field` and are purely presentational — the server only sees the base. */
export type AttributeType =
  | "string"
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "enumeration"
  | "json"
  | "relation";

/** A relation's side: many_to_one holds the linked id in its own column;
 *  one_to_many lists the records whose many_to_one points back at this one. */
export type RelationType = "many_to_one" | "one_to_many";

export interface CustomFieldDef {
  id: string;
  entity_type: EntityType;
  key: string;
  label: string;
  field_type: AttributeType;
  custom_field: string; // widget registry uid, or "" for a bare base type
  options: Record<string, unknown>;
  position: number;
  relation_type: RelationType | null;
  target_entity: EntityType | null;
  inverse_def_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CustomFieldDefRow extends Omit<CustomFieldDef, "options"> {
  options: string;
}

// entity type → real table name.
export const ENTITY_TABLES: Record<EntityType, string> = {
  contact: "contacts",
  company: "companies",
  deal: "deals",
};

export function isEntityType(v: string): v is EntityType {
  return v === "contact" || v === "company" || v === "deal";
}

// Built-in columns per table — a custom key may never collide with these, so
// schema-sync can never add/drop a platform column.
const BUILTIN_COLUMNS: Record<EntityType, ReadonlySet<string>> = {
  company: new Set(["id", "name", "domain", "industry", "phone", "email", "notes", "created_at", "updated_at"]),
  contact: new Set(["id", "first_name", "last_name", "email", "phone", "company_id", "title", "status", "created_at", "updated_at"]),
  deal: new Set(["id", "name", "contact_id", "value", "stage", "close_date", "notes", "created_at", "updated_at"]),
};

const KEY_RE = /^[a-z][a-z0-9_]*$/;

/** Throws a human-readable Error if `key` is not a safe, non-reserved column. */
export function assertValidKey(entity: EntityType, key: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error(`Invalid field key "${key}" — use lowercase letters, digits, and underscores (must start with a letter).`);
  }
  if (BUILTIN_COLUMNS[entity].has(key)) {
    throw new Error(`"${key}" is a built-in ${entity} field and can't be used as a custom property.`);
  }
}

/**
 * Split a flat bag of candidate values into writable custom values (keys that
 * have a registered def) and unknown keys (keys that are neither a built-in
 * column nor a defined custom field). Built-in keys are handled by the caller's
 * base write path, so they are neither returned nor flagged.
 *
 * This is what makes writes agent-safe: a mistyped or unregistered field
 * surfaces as `unknown` (the caller rejects it loudly) instead of being
 * silently dropped — the failure mode that bit both operators and agents when
 * custom values could only be reached through a nested `custom` bag.
 */
export async function classifyCustomWrite(
  entity: EntityType,
  candidates: Record<string, unknown>,
): Promise<{ values: Record<string, unknown>; unknown: string[] }> {
  const known = new Set((await listDefs(entity)).map((d) => d.key));
  const builtins = BUILTIN_COLUMNS[entity];
  const values: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(candidates)) {
    if (known.has(k)) values[k] = v;
    else if (!builtins.has(k)) unknown.push(k);
  }
  return { values, unknown };
}

/**
 * Labels of required custom fields (`options.required === true`) that a write
 * violates. Create: the value must be present and non-empty. Update: only an
 * explicit unset (null / "") violates — absent keys keep their stored value.
 * Enforced on the create/update APIs only; bulk import stays lenient by design
 * (it coerces bad cells to null rather than aborting a 2000-row file).
 */
export async function missingRequiredCustom(
  entity: EntityType,
  values: Record<string, unknown>,
  mode: "create" | "update",
): Promise<string[]> {
  const required = (await listDefs(entity)).filter((d) => d.options.required === true);
  const missing: string[] = [];
  for (const def of required) {
    const v = values[def.key];
    const empty = v === null || v === undefined || v === "";
    if (mode === "create" ? empty : def.key in values && empty) missing.push(def.label || def.key);
  }
  return missing;
}

/** Human-facing list of writable field keys (built-ins + registered custom),
 *  for the error body when a write includes an unknown field. Omits the
 *  server-managed columns a caller can't set, and the one_to_many side of a
 *  relation (it is set from the other side). */
export async function writableFieldKeys(entity: EntityType): Promise<string[]> {
  const managed = new Set(["id", "created_at", "updated_at"]);
  const builtins = [...BUILTIN_COLUMNS[entity]].filter((k) => !managed.has(k));
  const custom = (await listDefs(entity)).filter(hasColumn).map((d) => d.key);
  return [...builtins, ...custom];
}

/** Whether a def has a column of its own: all do but a relation's one_to_many side. */
export function hasColumn(def: Pick<CustomFieldDef, "relation_type">): boolean {
  return def.relation_type !== "one_to_many";
}

function quote(ident: string): string {
  return '"' + ident.replace(/"/g, '""') + '"';
}

const indexName = (table: string, key: string) => quote(`idx_${table}_${key}`);

// ── Registry CRUD ─────────────────────────────────────────────────────

function rowToDef(row: CustomFieldDefRow): CustomFieldDef {
  return { ...row, options: parseOptions(row.options) };
}

function parseOptions(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function listDefs(entity?: EntityType): Promise<CustomFieldDef[]> {
  const rows = entity
    ? await query<CustomFieldDefRow>(
        "SELECT * FROM custom_field_defs WHERE entity_type = ? ORDER BY position, created_at",
        [entity],
      )
    : await query<CustomFieldDefRow>("SELECT * FROM custom_field_defs ORDER BY entity_type, position, created_at");
  return rows.map(rowToDef);
}

export async function getDef(id: string): Promise<CustomFieldDef | null> {
  const row = await get<CustomFieldDefRow>("SELECT * FROM custom_field_defs WHERE id = ?", [id]);
  return row ? rowToDef(row) : null;
}

export interface CustomFieldInput {
  entity_type: EntityType;
  key: string;
  label: string;
  field_type: AttributeType;
  custom_field?: string;
  options?: Record<string, unknown>;
  position?: number;
}

/** Create a def and add its column. Throws on bad/duplicate key. */
export async function createDef(input: CustomFieldInput): Promise<CustomFieldDef> {
  assertValidKey(input.entity_type, input.key);
  const existing = await get("SELECT id FROM custom_field_defs WHERE entity_type = ? AND key = ?", [
    input.entity_type,
    input.key,
  ]);
  if (existing) throw new Error(`A "${input.key}" property already exists on ${input.entity_type}.`);

  const id = crypto.randomUUID();
  await run(
    "INSERT INTO custom_field_defs (id, entity_type, key, label, field_type, custom_field, options, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      input.entity_type,
      input.key,
      input.label,
      input.field_type,
      input.custom_field ?? "",
      JSON.stringify(input.options ?? {}),
      input.position ?? 0,
    ],
  );
  await syncEntityColumns(input.entity_type);
  return (await getDef(id))!;
}

export interface RelationInput {
  entity_type: EntityType;
  key: string;
  label: string;
  relation_type: RelationType;
  target_entity: EntityType;
  /** The other side's key and label, on `target_entity`. */
  inverse_key: string;
  inverse_label: string;
  position?: number;
}

/**
 * Create a relation: a def on each side, pointing at each other, and a column
 * on the many_to_one side holding the linked record's id, indexed. "Each
 * contact has one partner company" is many_to_one on contacts (column
 * contacts.partner_company_id) with a one_to_many "Partner contacts" on
 * companies. The column has no foreign key, because SQLite can't drop a
 * column that has one: deleting a record clears links to it instead
 * (detachRelations). Returns the def on `entity_type`.
 */
export async function createRelation(input: RelationInput): Promise<CustomFieldDef> {
  const { entity_type: source, target_entity: target } = input;
  if (!isEntityType(target)) throw new Error(`Invalid target_entity "${String(target)}".`);
  if (input.relation_type !== "many_to_one" && input.relation_type !== "one_to_many") {
    throw new Error('relation_type must be "many_to_one" or "one_to_many".');
  }
  assertValidKey(source, input.key);
  assertValidKey(target, input.inverse_key);
  if (source === target && input.key === input.inverse_key) throw new Error("The two sides of a relation need different keys.");
  const column = input.relation_type === "many_to_one" ? { entity: source, key: input.key } : { entity: target, key: input.inverse_key };
  if (!column.key.endsWith("_id")) {
    throw new Error(`"${column.key}" holds the linked record's id, so its key must end in _id.`);
  }
  for (const [entity, key] of [[source, input.key], [target, input.inverse_key]] as const) {
    if (await get("SELECT id FROM custom_field_defs WHERE entity_type = ? AND key = ?", [entity, key])) {
      throw new Error(`A "${key}" property already exists on ${entity}.`);
    }
  }

  const id = crypto.randomUUID();
  const inverseId = crypto.randomUUID();
  const next = await get<{ n: number }>("SELECT COALESCE(MAX(position) + 1, 0) AS n FROM custom_field_defs WHERE entity_type = ?", [target]);
  const insert = "INSERT INTO custom_field_defs (id, entity_type, key, label, field_type, position, relation_type, target_entity, inverse_def_id) VALUES (?, ?, ?, ?, 'relation', ?, ?, ?, ?)";
  const inverseType: RelationType = input.relation_type === "many_to_one" ? "one_to_many" : "many_to_one";
  // shortcut: sequential writes with a manual undo, since the db helper has no
  // batch; a crash between them can leave a def without its column (a later
  // syncEntityColumns adds it).
  const table = quote(ENTITY_TABLES[column.entity]);
  let added = false;
  await run(insert, [id, source, input.key, input.label, input.position ?? 0, input.relation_type, target, inverseId]);
  try {
    await run(insert, [inverseId, target, input.inverse_key, input.inverse_label, next?.n ?? 0, inverseType, source, id]);
    await run(`ALTER TABLE ${table} ADD COLUMN ${quote(column.key)} TEXT`);
    added = true;
    await run(`CREATE INDEX IF NOT EXISTS ${indexName(ENTITY_TABLES[column.entity], column.key)} ON ${table}(${quote(column.key)})`);
  } catch (err) {
    if (added) await run(`ALTER TABLE ${table} DROP COLUMN ${quote(column.key)}`).catch(() => {});
    await run("DELETE FROM custom_field_defs WHERE id IN (?, ?)", [id, inverseId]);
    throw err;
  }
  return (await getDef(id))!;
}

/** Update label/options/position/widget of a def. Key + field_type are immutable
 *  (changing storage would need a destructive column migration). */
export async function updateDef(
  id: string,
  patch: Partial<Pick<CustomFieldDef, "label" | "custom_field" | "options" | "position">>,
): Promise<CustomFieldDef | null> {
  const def = await getDef(id);
  if (!def) return null;
  await run(
    "UPDATE custom_field_defs SET label = ?, custom_field = ?, options = ?, position = ?, updated_at = datetime('now') WHERE id = ?",
    [
      patch.label ?? def.label,
      patch.custom_field ?? def.custom_field,
      JSON.stringify(patch.options ?? def.options),
      patch.position ?? def.position,
      id,
    ],
  );
  return getDef(id);
}

/** Delete a def and drop its column. A relation goes as a whole: both sides,
 *  and the many_to_one side's index before its column (SQLite won't drop an
 *  indexed column). */
export async function deleteDef(id: string): Promise<boolean> {
  const def = await getDef(id);
  if (!def) return false;
  const inverse = def.inverse_def_id ? await getDef(def.inverse_def_id) : null;
  for (const d of inverse ? [def, inverse] : [def]) {
    await run("DELETE FROM custom_field_defs WHERE id = ?", [d.id]);
    // Guard again before touching DDL — never drop a built-in.
    if (!hasColumn(d) || !KEY_RE.test(d.key) || BUILTIN_COLUMNS[d.entity_type].has(d.key)) continue;
    const table = ENTITY_TABLES[d.entity_type];
    if (d.relation_type === "many_to_one") await run(`DROP INDEX IF EXISTS ${indexName(table, d.key)}`).catch(() => {});
    await run(`ALTER TABLE ${quote(table)} DROP COLUMN ${quote(d.key)}`).catch(() => {
      /* column may already be gone; deletion of the def is the source of truth */
    });
  }
  return true;
}

// ── Schema-sync ───────────────────────────────────────────────────────

function sqliteAffinity(t: AttributeType): string {
  switch (t) {
    case "integer":
    case "boolean":
      return "INTEGER";
    case "decimal":
      return "REAL";
    default:
      return "TEXT";
  }
}

interface ColumnInfo {
  name: string;
  type: string;
}

/** Idempotently add a real column for every def on this entity that doesn't yet
 *  have one. Never drops here — deletion is explicit via deleteDef. */
export async function syncEntityColumns(entity: EntityType): Promise<void> {
  const table = ENTITY_TABLES[entity];
  const cols = await query<ColumnInfo>(`PRAGMA table_info(${quote(table)})`);
  const have = new Set(cols.map((c) => c.name));
  const defs = await listDefs(entity);
  for (const def of defs) {
    if (!hasColumn(def) || !KEY_RE.test(def.key) || BUILTIN_COLUMNS[entity].has(def.key) || have.has(def.key)) continue;
    await run(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(def.key)} ${sqliteAffinity(def.field_type)}`);
    if (def.relation_type === "many_to_one") {
      await run(`CREATE INDEX IF NOT EXISTS ${indexName(table, def.key)} ON ${quote(table)}(${quote(def.key)})`);
    }
  }
}

// ── Value coercion (entity write paths) ───────────────────────────────

/**
 * Coerce + validate one incoming custom value for its def. Returns a
 * SQL-bindable value (string | number | null). Throws on enum violation.
 */
export function coerceCustomValue(value: unknown, def: CustomFieldDef): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  switch (def.field_type) {
    case "boolean":
      return value ? 1 : 0;
    case "integer":
      return Math.trunc(Number(value));
    case "decimal":
      return Number(value);
    case "json":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "enumeration": {
      const enumVals = def.options.enum;
      const s = String(value);
      if (Array.isArray(enumVals) && enumVals.length && !enumVals.map(String).includes(s)) {
        throw new Error(`${def.key}: "${s}" is not one of [${enumVals.join(", ")}]`);
      }
      return s;
    }
    default:
      return String(value);
  }
}
