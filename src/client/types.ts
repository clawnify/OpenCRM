import type { FilterNode } from "./lib/filters";

export type View = "contacts" | "companies" | "deals";
export type EntityType = "contact" | "company" | "deal";

/** Base storage type for a custom property. Widget flavours ride on top. */
export type AttributeType =
  | "string"
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "enumeration"
  | "json";

/** A user-defined field on an entity type. Maps to a real column on the table. */
export interface CustomFieldDef {
  id: string;
  entity_type: EntityType;
  key: string;
  label: string;
  field_type: AttributeType;
  custom_field: string; // widget registry uid, or "" for a bare base type
  options: Record<string, unknown>;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Company {
  id: string;
  name: string;
  domain: string;
  industry: string;
  phone: string;
  email: string;
  notes: string;
  contact_count?: number;
  custom?: Record<string, unknown>; // write payload; on reads, values are flat columns
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company_id: string | null;
  title: string;
  status: string;
  company_name?: string | null;
  company_domain?: string | null;
  custom?: Record<string, unknown>; // write payload; on reads, values are flat columns
  created_at: string;
  updated_at: string;
}

export interface Deal {
  id: string;
  name: string;
  contact_id: string | null;
  value: number;
  stage: string;
  close_date: string;
  notes: string;
  contact_first_name?: string | null;
  contact_last_name?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  custom?: Record<string, unknown>; // write payload; on reads, values are flat columns
  created_at: string;
  updated_at: string;
}

/** A pipeline stage — data, not code. `key` is immutable and stored on
 *  deals.stage; behavior hangs on is_won/is_lost, never on names. */
export interface StageDef {
  key: string;
  label: string;
  color: string; // palette token (sky, emerald, …)
  position: number;
  is_won: number; // 0 | 1
  is_lost: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface Stats {
  contacts: number;
  companies: number;
  deals: number;
  dealValue: number;
}

export interface PaginatedState {
  page: number;
  limit: number;
  total: number;
  sort: string;
  order: "asc" | "desc";
  search: string;
  filters: FilterNode[];
}

export interface Activity {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  type: string; // note | email | meeting | slack | stage_change
  body: string;
  meta: string; // JSON string
  created_at: string;
}

export interface ConnectionStatus {
  email: boolean;
  meeting: boolean;
  slack: boolean;
}

// Entities that support bulk spreadsheet import.
export type ImportEntity = "contact" | "company";

// A row handed to the import API: a flat bag of built-in columns plus an
// optional `custom` sub-bag of custom-field values. The concrete shape is
// validated server-side per entity, so this is intentionally loose.
export type ImportRow = Record<string, unknown> & { custom?: Record<string, unknown> };

// Import outcome — fields vary by entity (contacts report companiesCreated,
// companies report duplicates skipped).
export interface ImportResult {
  imported: number;
  skipped: number;
  companiesCreated?: number;
  duplicates?: number;
}
