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
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact ON deals(contact_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_custom_field_defs_entity ON custom_field_defs(entity_type, position);
