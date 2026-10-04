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
  | "json"
  | "relation";

/** A relation's side: many_to_one holds one linked record's id in its own
 *  column; one_to_many lists the records whose many_to_one points back here. */
export type RelationType = "many_to_one" | "one_to_many";

/** A linked record as a chip shows it. `domain` is a company's, for its logo. */
export interface RelationRecord {
  id: string;
  label: string;
  domain: string | null;
}

/** A relation's value on a read row (`row.relations[key]`): the linked record,
 *  or for a one_to_many side the first few and how many there are. */
export type RelationValue = RelationRecord | null | { items: RelationRecord[]; total: number };

/** A user-defined field on an entity type. Maps to a real column on the table,
 *  except a relation's one_to_many side, which is read from the other side. */
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

export interface Company {
  id: string;
  name: string;
  domain: string;
  industry: string;
  phone: string;
  email: string;
  notes: string;
  /** The day they became a customer (YYYY-MM-DD); null = not a customer. */
  customer_since?: string | null;
  contact_count?: number;
  custom?: Record<string, unknown>; // write payload; on reads, values are flat columns
  relations?: Record<string, RelationValue>; // reads only, keyed by relation field
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
  /** Newest synced email with this contact (Gmail sync); read-only. */
  last_contacted_at?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  custom?: Record<string, unknown>; // write payload; on reads, values are flat columns
  relations?: Record<string, RelationValue>; // reads only, keyed by relation field
  created_at: string;
  updated_at: string;
}

// ── Gmail sync ──

export type EmailVisibility = "metadata" | "subject" | "everything";
export type EmailAutoCreate = "none" | "sent" | "sent_and_received";
export type EmailHistory = "3m" | "12m" | "all";

/** A synced mailbox's settings and where its sync is. */
export interface EmailAccountSettings {
  mailbox: string;
  enabled: boolean;
  labels: string[];
  history: EmailHistory;
  visibility: EmailVisibility;
  auto_create: EmailAutoCreate;
  exclude_group: boolean;
  exclude_personal: boolean;
  blocklist: string[];
  phase: "idle" | "importing" | "live";
  synced_until: string | null;
  contacts_created: number;
  last_run_at: string | null;
  last_error: string | null;
  next_run_at: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface EmailSyncStatus {
  /** Gmail, or Google Workspace, is connected in Clawnify. */
  connected: boolean;
  mailbox: string | null;
  /** The connection now signs in as another account than the one synced. */
  mailbox_changed: boolean;
  account: EmailAccountSettings | null;
  counts: { emails: number; contacts: number };
  /** A signed-in person: agents and apps can read, not change settings. */
  can_configure: boolean;
}

/** One synced email with a contact, as its mailbox's visibility allows. */
export interface ContactEmail {
  id: string;
  mailbox: string;
  thread_id: string;
  sent_at: string;
  direction: "sent" | "received";
  from_email: string;
  from_name: string | null;
  to_emails: string[];
  subject: string | null;
  can_open: boolean;
  gmail_url: string;
}

export interface Deal {
  id: string;
  name: string;
  contact_id: string | null;
  company_id: string | null;
  value: number;
  stage: string;
  close_date: string;
  notes: string;
  contact_first_name?: string | null;
  contact_last_name?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  custom?: Record<string, unknown>; // write payload; on reads, values are flat columns
  relations?: Record<string, RelationValue>; // reads only, keyed by relation field
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
  customers: number;
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
  /** Granola: call notes and transcripts. */
  notes: boolean;
  /** The address email goes out from, once email sync is set up. */
  mailbox?: string | null;
}

export interface EmailAddress {
  email: string;
  name: string | null;
}

/** An email opened from the timeline: its text (read live from Gmail) and who it went between. */
export interface OpenedEmail {
  text: string;
  subject: string;
  sent_at: string;
  direction: "sent" | "received";
  thread_id: string;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
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

/** A field the AI may fill (GET /api/ai-columns). */
export interface AiField {
  key: string;
  label: string;
  kind: string;
  options: string[] | null;
}

/** A column the AI fills, and what it is told. */
export interface AiColumnConfig {
  entity_type: string;
  field_key: string;
  prompt: string;
  research: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A cell the AI is filling, or failed to fill. */
export interface AiCellState {
  record_id: string;
  field_key: string;
  status: "queued" | "running" | "error";
  error: string | null;
}

// ── Meetings, tasks, insights, customers ──

export interface MeetingPerson {
  email: string;
  name: string | null;
}

export type MeetingLink = "auto" | "manual" | "unmatched" | "ignored";
export type DigestStatus = "none" | "queued" | "running" | "done" | "error";

export interface Meeting {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  attendees: MeetingPerson[];
  company_id: string | null;
  company_name: string | null;
  company_domain: string | null;
  link_status: MeetingLink;
  calendar_url: string | null;
  note_url: string | null;
  has_note: boolean;
  summary: string | null;
  /** -2 (badly) to 2 (very well). */
  sentiment: number | null;
  sentiment_reason: string | null;
  digest_status: DigestStatus;
  digest_error: string | null;
}

export interface MeetingSyncSettings {
  enabled: boolean;
  history_days: number;
  about: string;
  calendar_owner: string | null;
  phase: "idle" | "importing" | "live";
  calendar_synced_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  next_run_at: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface MeetingCounts {
  meetings: number;
  linked: number;
  unmatched: number;
  with_notes: number;
  digested: number;
  waiting: number;
  failed: number;
}

export interface MeetingSyncStatus {
  sources: { calendar: boolean; notes: boolean };
  settings: MeetingSyncSettings | null;
  counts: MeetingCounts;
  history_choices: number[];
  can_configure: boolean;
}

export type OwedBy = "us" | "them";

export interface Task {
  id: string;
  title: string;
  company_id: string | null;
  company_name: string | null;
  contact_id: string | null;
  deal_id: string | null;
  meeting_id: string | null;
  meeting_title: string | null;
  meeting_starts_at: string | null;
  owed_by: OwedBy;
  due_date: string | null;
  done: boolean;
  done_at: string | null;
  quote: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type InsightKind = "idea" | "expansion" | "risk";

export interface Insight {
  id: string;
  /** The call's company; null while the call is linked to none. */
  company_id: string | null;
  company_name: string | null;
  meeting_id: string | null;
  meeting_title: string | null;
  meeting_starts_at: string | null;
  kind: InsightKind;
  text: string;
  quote: string | null;
  status: "open" | "done" | "dismissed";
  deal_id: string | null;
  created_at: string;
  updated_at: string;
}

export type HealthStatus = "red" | "yellow" | "green";

export interface CustomerRow {
  id: string;
  name: string;
  domain: string;
  customer_since: string;
  status: HealthStatus;
  reasons: string[];
  last_touch_at: string | null;
  days_quiet: number | null;
  last_meeting_at: string | null;
  next_meeting_at: string | null;
  last_summary: string | null;
  last_sentiment: number | null;
  ours_open: number;
  ours_overdue: number;
  theirs_open: number;
  ideas: number;
  expansion: number;
  risks: number;
}

export interface FocusItem {
  kind: "overdue" | "reach_out" | "due_today" | "risk";
  company_id: string;
  company_name: string;
  text: string;
  task_id?: string;
}

export interface UpcomingCall {
  id: string;
  title: string;
  starts_at: string;
  company_id: string;
  company_name: string;
  company_domain: string;
  ours_open: number;
  last_summary: string | null;
}

export interface CustomersOverview {
  customers: CustomerRow[];
  focus: FocusItem[];
  upcoming: UpcomingCall[];
  counts: Record<HealthStatus, number>;
}
