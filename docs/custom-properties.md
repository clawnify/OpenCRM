# Custom Properties — Design Plan

HubSpot-style **custom properties**: user-defined fields on `contacts` /
`companies` / `deals` beyond the built-in columns. A definition is scoped to an
entity *type*, not a record, so properties are created and edited with an empty
database and exist before any record does.

Status: **design only** — build after the `feat/integrations` refactor lands,
branched off the committed base so the two don't entangle.

---

## 1. Storage — real columns via schema-sync (not a JSON blob)

Each entity keeps its typed base columns. A custom property becomes a **real
column** on the entity table, added at definition time:

```
ALTER TABLE contacts ADD COLUMN "<key>" <affinity>
```

A small **schema-sync** step (ported from the sibling `open-cms` template, where
it is already implemented and verified against D1) owns this: it diffs the
desired property set against the live `PRAGMA table_info(<table>)`, emits
non-destructive `ADD COLUMN`s, and surfaces destructive ops (drops / type
changes) behind an explicit confirmation. Affinity map: `integer`/`score` →
`INTEGER`, `decimal` → `REAL`, everything else → `TEXT`.

Values are written and read through the entity's **already-dynamic** column
builder — `server/index.ts` already composes `UPDATE <entity> SET <fields…>`
from a dynamic list, so custom columns slot into the existing pattern; only the
`INSERT` column list needs to become dynamic.

**Safety:** property `key` is validated to `^[a-z][a-z0-9_]*$` and every
identifier is quoted (`"` doubled) before interpolation — no injection surface
from user-named fields.

### Why real columns, not a JSON `custom` column

1. **The repo's own precedent.** Every *queryable* business field here is a real
   typed column (`contacts.status`, `deals.stage`, `deals.value`,
   `companies.industry`). JSON is used in exactly one place — `activities.meta`,
   an opaque bag that is never filtered or sorted. Custom properties are
   queryable fields, so by the codebase's own rule they belong in columns.
2. **The core operation.** Filter / sort / segment / report *by property* is the
   primary CRM workload, not an edge case. Under a JSON column every one of those
   is an un-indexed `json_extract(custom,'$.key')` full scan; as real columns
   they are native and indexable from day one.
3. **Prior art.** Baserow, NocoDB, and Salesforce custom fields all store
   user-defined queryable fields as real columns (dynamic DDL) precisely to index
   and filter at the DB layer. JSON-blob custom fields are the known
   anti-pattern for anything you query.
4. **Efficiency over the feature's life.** JSON looks smaller *today* but forces
   schema-sync later anyway (once segmentation matters) plus a blob→column data
   migration. Real columns reuse machinery that already exists and is verified,
   and align with the already-dynamic write path — less total work, not more.

**Ceiling (priced, not blocking):** each deployed app has its own D1 database, so
column count is bounded by one organisation's custom fields — comfortably under
SQLite's per-table limit. If one property becomes a hot cross-entity filter it
can gain an index; nothing needs to move.

## 2. Definitions table

`custom_field_defs` is the per-entity property registry and the domain object
(rename / reorder / retype / delete lifecycle):

| column         | notes                                              |
| -------------- | -------------------------------------------------- |
| `id`           | UUID (app-generated, matches the entity tables)    |
| `entity_type`  | `contact` \| `company` \| `deal`                   |
| `key`          | column name; `^[a-z][a-z0-9_]*$`                    |
| `label`        | display name                                       |
| `field_type`   | base type (drives affinity + coercion)             |
| `custom_field` | widget registry uid, nullable (see §3)             |
| `options`      | JSON — widget config (score min/max, badge colors) |
| `position`     | ordering in tables / forms                         |
| timestamps     | `created_at`, `updated_at`                         |

`UNIQUE(entity_type, key)`.

## 3. Widget registry (reused)

The widget registry from `open-cms` (`custom-fields.tsx`: Score, Badge, URL,
Email, Phone, Tags + `badgeColor` + the `<Pill>` primitive) ports nearly as-is.
An attribute references a widget by `custom_field` uid over its base
`field_type`. **One change:** badge/score colors map to this repo's `DESIGN.md`
tokens (`success` / `warning` / `danger` tints) instead of raw values, so they
match the design system. Badge remains an `enumeration`-typed field so it keeps
server-side value validation for free.

## 4. API

- `GET/POST/PATCH/DELETE /api/custom-fields?entity=contact` — CRUD the defs.
  Create/delete drive schema-sync (`ADD COLUMN` / confirmed `DROP COLUMN`).
- Entity write paths accept the property columns present on the request,
  validated against their defs (badge → enum check, score/number → coercion).
- Entity read paths return the property columns alongside the built-ins.

## 5. Where you create them — a record-independent Properties screen

Custom fields are entity-type-scoped, so their management UI **cannot** live
inside a record view (`contact-dialog`, a contact's detail). It lives in a
dedicated **Properties** screen reachable from the sidebar — HubSpot's *Settings
→ Properties → object* model — and works with an empty database.

- **`sidebar.tsx`** — add a second nav group under the existing "Records" group:

  ```
  Records     Contacts · Companies · Deals
  Settings    Properties  → /settings/properties
  ```

- **`use-router.ts`** — add `{ name: "properties" }` parsing `/settings/properties`.
- **Properties page** — tabs Contact | Company | Deal, each listing that entity's
  `custom_field_defs` with a "＋ New property" editor (the open-crm analog of
  open-cms's `field-editor`). This is the canonical, always-available home and
  the natural first-run starting point: define properties, then add or import
  records. It also becomes the home for future schema-level settings (deal
  stages, import mappings).

## 6. Client dispatch (two touch points per entity)

- **Tables** (`contacts-page`, `companies-page`, `deals-board`): render one column
  per def after the built-ins → registry `Cell`.
- **Dialogs** (`contact-dialog`, `company-dialog`, `deal-dialog`): render one
  input per def after the built-in fields → registry `Input`.

## 7. Import inference (the payoff)

The Contacts and Companies import dialogs suggest **Create new field** for
unmapped, named columns with meaningful values. The review lets the user edit
the label and type, map to an existing field, or skip the column. Empty, unnamed,
and placeholder-only columns default to Skip. Reading a file or cancelling the
review never creates fields.

Suggestions run locally: URLs, emails, international phone numbers, ISO dates,
semicolon-delimited tags, scores (integers 0–100), numbers, and badges (at most
12 short distinct values); other content stays text. Identifier-like headers
and leading-zero numbers stay text. CSV values are read without automatic date
or number conversion. Excel cells retain their formatted display text.
The type choices come from the same catalog as Attributes, excluding relations.
Badge options include every non-empty value in the column, not only the preview.

**Create N fields & import** explicitly confirms the new fields. Type overrides
are checked before writes, then the existing `/api/custom-fields` endpoint
creates the approved definitions and schema columns before the normal import
request. Tags become arrays and checkbox strings become booleans. Keys use a
`custom_` prefix and numeric suffixes to avoid system fields and existing keys.

Field creation is sequential, not an atomic import transaction. If a later
creation fails, no records are imported; successful fields remain visible and
are reused when the user retries within the review. They also remain in
Attributes if the user cancels. No existing fields or values are changed to make
an inferred definition fit. AI-assisted mapping remains a separate follow-up.

### 7a. Company columns on import (shipped)

The first slice of #3 to land is company-attribute capture. `/api/contacts/import`
already dedupes companies by name, but only ever created a **name-only stub** —
any `domain`/`industry`/`phone` in the file was dropped. The importer now exposes
`Company domain`, `Company industry`, and `Company phone` mapping targets (auto-
mapped from `domain`/`website`/`industry`/`sector` headers; `Company phone` is
manual-only so a bare `Phone` column stays the contact's). A **newly created**
company lands with those attributes filled from the first row that carries each
one; an **existing** company is reused untouched — dedupe-by-name wins, so an
import never overwrites an established company.

### 7b. Company association from work-email domains (shipped, opt-in)

HubSpot's mechanism — derive/associate a company from a contact's email domain
(`sandra@example.com` → company `example.com`) — is now supported, **opt-in per
import** via a checkbox (default off; auto-creating companies is invasive, so it's
explicit and only offered when an email column is mapped and no Company column is).

The cost that kept this out of the first slice — a maintained free-email exclusion
list — turned out to be **solved reference data, not hand-curation**: the
`free-email-domains` package (~12.8k providers, zero deps, pure JSON) is loaded
once into a `Set`, so a personal-provider email never spawns a "Gmail" company and
the list stays current via dependency bumps. Per import, distinct non-freemail
domains are resolved set-based (same shape as the name path): match an existing
company by `domain` first — including one the name phase just created, so a mapped
`Acme`/`acme.com` absorbs an `@acme.com` contact — else create a company named from
the domain (`acme.com` → "Acme", editable). The freemail fallback (HubSpot checks a
contact's Website URL when the email is a free provider) is skipped — import rows
carry no website field. A persistent org-level toggle and user-editable exclusions
are the natural next step *if* live per-contact association (outside import) is added;
the resolver is a shared helper, so that reuse is a one-liner.

### 7c. Custom fields on import + per-entity import (shipped)

Import is now generalized. The dialog (`import-dialog.tsx`, driven by an
`EntityImportConfig` per entity in `lib/import-config.ts`) is **per-entity** —
an **Import** button lives on both the Contacts and Companies list pages, not in
a separate section. Mapping to where the data lives beats a central hub for a CRM
this size (the pattern Attio/Airtable/Notion use); the one thing a hub buys —
relationship-aware multi-object import — is already covered because contact import
creates/associates companies.

**Existing custom fields are mapping targets.** The dialog reads the entity's
`custom_field_defs` and lists them under a "Custom fields" group in each column's
target picker (auto-mapped when a header matches a def's key or label). On import
the mapped values ride along in the same bulk `INSERT` as real columns — chunk
size is derived from the live column count so bound params stay ≤ 100 (D1's cap).
Coercion is **lenient for import**: a bad cell (invalid enum, unparseable number)
becomes `null` rather than aborting the batch, unlike the create/update path which
rejects. This is *mapping to fields you already created*; §7 describes the review
that creates new definitions for unmapped columns before using this same path.

**Company import** dedupes by name (case-insensitive): a name that already exists,
or repeats within the file, is skipped and reported (`duplicates`), never
duplicated or overwritten; new companies land with built-ins + mapped custom fields.
(Deals import is deferred — it's a board and needs contact-matching.)

## 8. Scope boundaries (opinionated)

- No relations-as-custom-property — contact→company is already native.
- No range type — a `"13–15"` value is a `string` or two number properties.
- Server-side sort/filter uses real columns; no `json_extract` path exists.

## 9. First-run / empty state

The create-a-property flow must not depend on records existing:

- The zero-row list view (e.g. Contacts with no contacts) shows an empty-state
  card that links **"Set up properties"** alongside "＋ New contact", guiding a
  fresh CRM to schema before data.
- Each list view's column/gear menu carries an **"Add property"** shortcut that
  deep-links into the Properties screen for that entity. The list *page* renders
  its header even at zero rows, so this is reachable when empty.
- Because defs are entity-type-scoped and `ADD COLUMN` runs on an empty table,
  "properties before records" is the intended onboarding order — the manual
  screen and the importer converge on the same path.

## 10. Sequencing

Build after `feat/integrations` is committed, branched off that base. Rough
shape once it lands: one migration (`custom_field_defs` + schema-sync port), the
`/api/custom-fields` endpoints + dynamic INSERT, the widget registry copy with
token remap, the Properties screen (+ sidebar/router entry), two dispatch points
per entity, and the import inference.
