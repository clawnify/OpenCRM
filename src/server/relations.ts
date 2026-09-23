/**
 * Relations: reading and keeping links between records.
 *
 * A relation is a pair of custom-field defs (see createRelation in
 * custom-fields.ts). The many_to_one side is a column holding the linked
 * record's id; the one_to_many side is that column read from the other end.
 * This module names records for chips and pickers, attaches linked records to
 * rows read from the API, validates writes, sorts by a linked record's name,
 * and clears links when records are deleted.
 */

import { get, query, run } from "./db.js";
import { ENTITY_TABLES, getDef, listDefs, type CustomFieldDef, type EntityType } from "./custom-fields.js";

/** A linked record as a chip shows it. `domain` is a company's, for its logo. */
export interface RelationRecord {
  id: string;
  label: string;
  domain: string | null;
}

const qid = (col: string) => `"${col.replace(/"/g, '""')}"`;

/** A record's name, as SQL over table alias `a`. */
const LABEL: Record<EntityType, (a: string) => string> = {
  company: (a) => `${a}.name`,
  contact: (a) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`,
  deal: (a) => `${a}.name`,
};

const recordColumns = (entity: EntityType, a: string) =>
  `${a}.id AS id, ${LABEL[entity](a)} AS label, ${entity === "company" ? `${a}.domain` : "NULL"} AS domain`;

/** Stays under D1's 100 bound parameters per query. */
function chunk<T>(arr: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

const relationDefs = async (entity?: EntityType) =>
  (await listDefs(entity)).filter((d) => d.field_type === "relation" && d.target_entity && d.relation_type);

/** Records of `entity` for a picker: by name (`search`), or the given `ids`. */
export async function searchRecords(entity: EntityType, search: string, ids: string[]): Promise<RelationRecord[]> {
  const table = ENTITY_TABLES[entity];
  if (ids.length) {
    return query<RelationRecord>(`SELECT ${recordColumns(entity, "t")} FROM ${table} t WHERE t.id IN (${marks(ids.length)})`, ids);
  }
  const s = search.trim();
  return query<RelationRecord>(
    `SELECT ${recordColumns(entity, "t")} FROM ${table} t${s ? ` WHERE ${LABEL[entity]("t")} LIKE ?` : ""} ORDER BY label COLLATE NOCASE LIMIT 20`,
    s ? [`%${s}%`] : [],
  );
}

/**
 * Adds `relations` to each row: for every relation on `entity`, the linked
 * record (many_to_one, or null) or the first `manyLimit` linked records and
 * their total (one_to_many). One query per relation per 90 rows.
 */
export async function withRelations<T extends Record<string, unknown>>(entity: EntityType, rows: T[], manyLimit = 3): Promise<T[]> {
  const defs = await relationDefs(entity);
  if (!rows.length || !defs.length) return rows;
  const out = rows.map((r) => ({ ...r, relations: {} as Record<string, unknown> }));

  for (const def of defs) {
    const target = def.target_entity!;
    const table = ENTITY_TABLES[target];
    if (def.relation_type === "many_to_one") {
      const ids = [...new Set(rows.map((r) => r[def.key]).filter((v): v is string => typeof v === "string" && v !== ""))];
      const found = new Map<string, RelationRecord>();
      for (const part of chunk(ids)) {
        for (const rec of await query<RelationRecord>(`SELECT ${recordColumns(target, "t")} FROM ${table} t WHERE t.id IN (${marks(part.length)})`, part)) {
          found.set(rec.id, rec);
        }
      }
      for (const r of out) r.relations[def.key] = found.get(r[def.key] as string) ?? null;
      continue;
    }

    const inverse = def.inverse_def_id ? await getDef(def.inverse_def_id) : null;
    if (!inverse) continue;
    const col = `t.${qid(inverse.key)}`;
    const byParent = new Map<string, { items: RelationRecord[]; total: number }>();
    for (const part of chunk(out.map((r) => String(r.id)), 89)) {
      const found = await query<RelationRecord & { parent: string; total: number }>(
        `SELECT id, label, domain, parent, total FROM (
           SELECT ${recordColumns(target, "t")}, ${col} AS parent,
                  ROW_NUMBER() OVER (PARTITION BY ${col} ORDER BY ${LABEL[target]("t")} COLLATE NOCASE) AS n,
                  COUNT(*) OVER (PARTITION BY ${col}) AS total
           FROM ${table} t WHERE ${col} IN (${marks(part.length)})
         ) WHERE n <= ?`,
        [...part, manyLimit],
      );
      for (const { parent, total, ...rec } of found) {
        const entry = byParent.get(parent) ?? { items: [], total };
        entry.items.push(rec);
        byParent.set(parent, entry);
      }
    }
    for (const r of out) r.relations[def.key] = byParent.get(String(r.id)) ?? { items: [], total: 0 };
  }
  return out;
}

/**
 * Why a write's relation values can't be saved, or null. A many_to_one value
 * must be an existing record's id (null or "" clears it). A one_to_many side is
 * not written here: link a record by setting the other side on it.
 */
export async function relationWriteError(entity: EntityType, values: Record<string, unknown>): Promise<string | null> {
  for (const def of await relationDefs(entity)) {
    const v = values[def.key];
    // An empty value is no write at all (a form sends every field it shows).
    if (v === null || v === undefined || v === "") continue;
    const target = def.target_entity!;
    if (def.relation_type === "one_to_many") {
      const inverse = def.inverse_def_id ? await getDef(def.inverse_def_id) : null;
      return `${def.key} lists linked ${ENTITY_TABLES[target]} and can't be written here. Set ${inverse?.key ?? "the other side"} on each ${target} instead.`;
    }
    if (typeof v !== "string") return `${def.key} takes a ${target} id, or null to clear it.`;
    if (!(await get(`SELECT id FROM ${ENTITY_TABLES[target]} WHERE id = ?`, [v]))) return `${def.key}: no ${target} with id "${v}".`;
  }
  return null;
}

/** The built-in links, which predate relation defs: column → the entity it holds. */
const BUILTIN_LINKS: Partial<Record<EntityType, Record<string, EntityType>>> = {
  contact: { company_id: "company" },
  deal: { contact_id: "contact" },
};

/** ORDER BY for a column holding a linked record's id (a many_to_one relation,
 *  or the built-in company_id / contact_id): the linked record's name. Null
 *  for any other column. */
export async function relationSortSQL(entity: EntityType, alias: string, column: string): Promise<string | null> {
  const target = BUILTIN_LINKS[entity]?.[column]
    ?? (await relationDefs(entity)).find((d) => d.key === column && d.relation_type === "many_to_one")?.target_entity;
  if (!target) return null;
  return `(SELECT ${LABEL[target]("r")} FROM ${ENTITY_TABLES[target]} r WHERE r.id = ${alias}.${qid(column)}) COLLATE NOCASE`;
}

/**
 * Clears links to deleted records of `entity`. The built-in company_id and
 * contact_id are cleared by their foreign keys; custom relation columns have
 * none (see createRelation), so they are cleared here.
 */
export async function detachRelations(entity: EntityType, ids: string[]): Promise<void> {
  const defs: CustomFieldDef[] = (await relationDefs()).filter((d) => d.relation_type === "many_to_one" && d.target_entity === entity);
  for (const def of defs) {
    const col = qid(def.key);
    for (const part of chunk(ids)) {
      await run(`UPDATE ${ENTITY_TABLES[def.entity_type]} SET ${col} = NULL WHERE ${col} IN (${marks(part.length)})`, part);
    }
  }
}
