-- UUID text primary keys (not incremental) so ids aren't enumerable/IDOR-prone.
-- Ids are generated in the app layer with crypto.randomUUID().

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  -- The day they became a customer (YYYY-MM-DD); NULL = not a customer. Set by
  -- hand, or when one of their deals first reaches a won stage. Customers are
  -- the accounts on the Customers page.
  customer_since TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  title TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'lead',
  -- The newest synced email with this contact (email_message_contacts). Kept by
  -- the Gmail sync, read-only through the API; NULL when nothing is synced.
  last_contacted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  -- The deal's own company, independent of its contact: a deal can name a
  -- company before it has a person, and keeps it if the contact moves on.
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  value REAL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'prospect',
  close_date TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Pipeline stages — data, not code. `key` is the immutable identifier stored on
-- deals.stage; label/color/position are editable. Semantic flags drive behavior
-- with any vocabulary: is_won → celebrate + Slack, is_lost → excluded from
-- pipeline value. Colors are tokens from the client's category palette (sky,
-- emerald, amber, rose, violet, fuchsia, teal, orange, slate). The default
-- sales pipeline is seeded by the SERVER (ensureStagesSeeded in index.ts), only
-- when this table is empty — so re-running the schema never resurrects a stage
-- the user renamed or deleted, and we stay clear of D1's compound-SELECT limits.
CREATE TABLE IF NOT EXISTS stages (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'slate',
  position INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  is_lost INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Activity timeline: one row per interaction logged against a contact, company,
-- or deal. The substrate every integration writes into (email sent, meeting
-- scheduled, Slack notification) plus manual notes.
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,               -- 'contact' | 'company' | 'deal'
  entity_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'note',        -- 'note' | 'email' | 'meeting' | 'slack' | 'stage_change'
  body TEXT DEFAULT '',
  meta TEXT DEFAULT '',                     -- JSON: subject, recipient, event link, channel, etc.
  created_at TEXT DEFAULT (datetime('now'))
);

-- Custom-property definitions. One row per user-defined field on an entity
-- type. Each def maps to a REAL column on the entity's table, added via
-- ALTER TABLE at definition time (see custom-fields.ts) so values are native,
-- indexable columns — not a JSON blob. This table is only the registry.
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,                -- 'contact' | 'company' | 'deal'
  key TEXT NOT NULL,                        -- column name; ^[a-z][a-z0-9_]*$
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'string',-- base type; drives SQL affinity + coercion
  custom_field TEXT DEFAULT '',             -- widget registry uid (e.g. clawnify::score.score)
  options TEXT NOT NULL DEFAULT '{}',        -- JSON: widget config (score min/max, badge enum, colors)
  position INTEGER NOT NULL DEFAULT 0,
  -- A relation (field_type 'relation') is two defs, one per side, pointing at
  -- each other through inverse_def_id. Only the many_to_one side has a column:
  -- `key` holds the linked record's id (e.g. contacts.partner_id). The
  -- one_to_many side is read from that column and has none of its own.
  relation_type TEXT,                       -- 'many_to_one' | 'one_to_many'; NULL for other types
  target_entity TEXT,                       -- the entity on the other side
  inverse_def_id TEXT,                      -- the other side's def
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(entity_type, key)
);

-- A list's named views, shared by everyone in the org: its filters, sort and
-- (in view_fields) columns. Each list has one default view ("All contacts"),
-- created on first use, which can't be deleted. Editing filters or sort
-- changes only the page until someone updates the view.
CREATE TABLE IF NOT EXISTS views (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,                -- 'contact' | 'company'
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'table',
  is_default INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  filters TEXT NOT NULL DEFAULT '[]',       -- JSON filter tree (see buildFilters)
  sort TEXT,                                -- column; NULL = the list's default order
  sort_order TEXT,                          -- 'asc' | 'desc'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_views_entity ON views(entity_type, position);
-- One default per list, even if two first requests race to create it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_views_default ON views(entity_type) WHERE is_default = 1;

-- A view's column layout, one row per column someone has changed: whether it
-- shows, its width, and its footer calculation. Columns without a row use the
-- app's defaults. `field_key` is a built-in column id ('email', 'name') or a
-- custom field's key.
CREATE TABLE IF NOT EXISTS view_fields (
  view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  is_visible INTEGER NOT NULL DEFAULT 1,
  size INTEGER,                             -- px; NULL = the app's default
  aggregate TEXT,                           -- footer calculation (count, sum…); NULL = none
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (view_id, field_key)
);

-- One-time data fixes the server has applied, by name (see backfillOnce in
-- index.ts). This file is DDL only, so a fix that fills existing rows runs in
-- the app, once, and records itself here so it never runs again.
CREATE TABLE IF NOT EXISTS data_backfills (
  key TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

-- Gmail sync. A mailbox the CRM reads, keyed by its address: today the org's
-- default Google connection, later one row per connected account once an org
-- can connect several (platform: multi-account connections). Settings mirror
-- the choices made when turning sync on; the rest is where the sync is.
CREATE TABLE IF NOT EXISTS email_accounts (
  mailbox TEXT PRIMARY KEY,                 -- the Google account's address
  enabled INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]',        -- JSON label names; [] = all mail
  history TEXT NOT NULL DEFAULT '12m',      -- first import reaches back '3m' | '12m' | 'all'
  visibility TEXT NOT NULL DEFAULT 'metadata', -- 'metadata' | 'subject' | 'everything'
  auto_create TEXT NOT NULL DEFAULT 'sent', -- 'none' | 'sent' | 'sent_and_received'
  exclude_group INTEGER NOT NULL DEFAULT 1,
  exclude_personal INTEGER NOT NULL DEFAULT 1,
  blocklist TEXT NOT NULL DEFAULT '[]',     -- JSON: addresses and @domains never imported
  phase TEXT NOT NULL DEFAULT 'idle',       -- 'idle' | 'importing' | 'live'
  import_cursor TEXT,                       -- JSON: where the first import resumes
  synced_until TEXT,                        -- newest message seen; later syncs start here
  contacts_created INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_error TEXT,
  running_until TEXT,                       -- a run's lease; a second run waits it out
  job_id TEXT,                              -- the next scheduled run on the platform queue
  next_run_at TEXT,
  updated_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- One synced email: who, when and which way. Never the body; the subject only
-- while the mailbox's visibility shows subjects. Stored only for emails with a
-- contact, so the CRM holds its relationships, not the whole mailbox.
CREATE TABLE IF NOT EXISTS email_messages (
  mailbox TEXT NOT NULL,
  id TEXT NOT NULL,                         -- Gmail message id, unique within its mailbox
  thread_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,                    -- ISO 8601
  direction TEXT NOT NULL,                  -- 'sent' | 'received'
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_emails TEXT NOT NULL DEFAULT '[]',     -- JSON array of addresses
  subject TEXT,
  PRIMARY KEY (mailbox, id)
);

-- Which contacts an email involves. sent_at is copied so a contact's emails
-- read in order without a join.
CREATE TABLE IF NOT EXISTS email_message_contacts (
  mailbox TEXT NOT NULL,
  message_id TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (mailbox, message_id, contact_id)
);

-- Contacts whose history has been read from a mailbox, and for which address.
-- A contact added after the first import, or whose address changed, has no row
-- and is read on its own the first time its emails are opened.
CREATE TABLE IF NOT EXISTS email_contact_imports (
  mailbox TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  imported_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (mailbox, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_email_message_contacts_contact ON email_message_contacts(contact_id, sent_at);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact ON deals(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_custom_field_defs_entity ON custom_field_defs(entity_type, position);

-- AI columns: fields whose empty cells the AI fills on request, and the prompt it follows.
CREATE TABLE IF NOT EXISTS ai_columns (
  entity_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  research INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity_type, field_key)
);

-- One row per cell the AI was asked to fill: queued, running, done or error.
CREATE TABLE IF NOT EXISTS ai_cells (
  entity_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  overwrite INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity_type, record_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_cells_status ON ai_cells(status, updated_at);

-- A company's homepage as markdown, read when an AI column's instructions mention
-- its domain, and kept a while so one read serves every fill for that company.
-- `error` is set when it couldn't be read.
CREATE TABLE IF NOT EXISTS company_pages (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  markdown TEXT,
  error TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Meetings: the org's calendar and its Granola notes, read into the CRM
-- (meetings.ts). One row of settings and progress.
CREATE TABLE IF NOT EXISTS meeting_sync (
  id INTEGER PRIMARY KEY,                   -- always 1
  enabled INTEGER NOT NULL DEFAULT 0,
  history_days INTEGER NOT NULL DEFAULT 90, -- how far back the first import reads
  about TEXT NOT NULL DEFAULT '',           -- what we sell: frames the ideas and expansion the AI notes
  calendar_owner TEXT,                      -- the address whose calendar is read
  phase TEXT NOT NULL DEFAULT 'idle',       -- 'idle' | 'importing' | 'live'
  cursor TEXT,                              -- JSON: where the import resumes
  calendar_synced_at TEXT,                  -- when the calendar window was last read in full
  notes_synced_until TEXT,                  -- newest Granola note update read; later reads start here
  last_run_at TEXT,
  last_error TEXT,
  running_until TEXT,                       -- a run's lease
  job_id TEXT,
  next_run_at TEXT,
  updated_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- One meeting with people from outside: from the calendar, its Granola note, or
-- both. A meeting with no one from outside is kept only as a time slot
-- (link_status 'internal': no title, no people), so a note taken in it is known
-- to be internal; it is never shown. The transcript stays in Granola; the
-- summary and what the call produced (tasks, insights) are kept.
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  calendar_event_id TEXT UNIQUE,            -- Google Calendar event id
  note_id TEXT UNIQUE,                      -- Granola note id
  title TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,                  -- ISO 8601, UTC
  ends_at TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',     -- JSON [{email, name}]: the outside people
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  link_status TEXT NOT NULL DEFAULT 'unmatched', -- 'auto' | 'manual' | 'unmatched' | 'ignored' | 'internal'
  calendar_url TEXT,
  note_url TEXT,
  note_updated_at TEXT,
  summary TEXT,
  sentiment INTEGER,                        -- -2 (went badly) to 2 (went very well)
  sentiment_reason TEXT,
  digest_status TEXT NOT NULL DEFAULT 'none', -- 'none' | 'queued' | 'running' | 'done' | 'error'
  digest_error TEXT,
  digested_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meetings_company ON meetings(company_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_meetings_starts ON meetings(starts_at);
CREATE INDEX IF NOT EXISTS idx_meetings_link ON meetings(link_status, starts_at);
CREATE INDEX IF NOT EXISTS idx_meetings_digest ON meetings(digest_status, updated_at);

-- Something to do for an account: typed by a person, or promised in a call
-- (meeting_id, with the words it came from in `quote`). owed_by says whose
-- promise it is: 'us' (we owe it) or 'them' (we're waiting on them). A task the
-- AI took from a call (created_by 'ai') follows its call's company, as insights do.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  owed_by TEXT NOT NULL DEFAULT 'us',       -- 'us' | 'them'
  due_date TEXT,                            -- YYYY-MM-DD
  done_at TEXT,                             -- NULL = open
  quote TEXT,
  created_by TEXT,                          -- 'ai' (follows its call), or the person who created or moved it
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id, done_at);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(done_at, due_date);

-- What a call said about an account beyond tasks: an idea or use case worth
-- proposing, room to expand (upsell), or a risk. Open until someone acts on it.
-- It belongs to its call's company: company_id follows meetings.company_id, and
-- is NULL while the call is linked to no company.
CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                       -- 'idea' | 'expansion' | 'risk'
  text TEXT NOT NULL,
  quote TEXT,
  status TEXT NOT NULL DEFAULT 'open',      -- 'open' | 'done' | 'dismissed'
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL, -- the deal an expansion became
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_insights_company ON insights(company_id, status);
