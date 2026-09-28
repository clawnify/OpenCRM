# OpenCRM — agent guide

A CRM with **companies**, **contacts**, and a **deals** pipeline, plus an activity
timeline and Clawnify integrations. Preact + Hono + D1.

## Core entities

- `GET/POST/PUT/DELETE /api/contacts` · `/api/companies` · `/api/deals`
- Contacts belong to companies. A deal has its own `company_id` and `contact_id`,
  both optional. Setting a contact on a deal with no company gives it the
  contact's company; send `company_id` to set or clear it yourself.
- `GET /api/stats` — counts + total pipeline value (excludes lost deals).
- `GET /api/widgets` — the tiles the Clawnify home page shows: deals created
  this month, open pipeline value and by stage, deals per week, latest deals.

## Pipeline stages (data, not code)

Stages live in the database — `GET /api/stages` is the vocabulary. Defaults:
`prospect → qualified → proposal → negotiation → won`, plus `lost`. Deal writes
validate the stage key (400 lists valid keys).

- `POST /api/stages` `{ label, key?, color?, position?, is_won?, is_lost? }` — add a stage.
- `PUT /api/stages/{key}` — rename, recolor, reorder, or change flags. Key is immutable.
- `DELETE /api/stages/{key}?reassign_to=<key>` — reassign_to is required when
  the stage still has deals.
- **Semantics ride on flags, not names**: moving a deal to an `is_won: 1` stage
  fires the Slack celebration; `is_lost: 1` stages are excluded from pipeline value.

## Custom fields

Define real, typed columns at runtime: `POST /api/custom-fields`
`{ entity_type, key, label, field_type, options }` — then write values flat on
the entity or under `custom`. Unknown fields are rejected loudly (422) with the
valid-field list. Set `options.required: true` to make a field mandatory —
create/update then reject (400) when it's missing or being cleared. Bulk import
stays lenient and does not enforce required.

## Activity timeline

Every contact/company/deal has a timeline. Integrations and notes write to it.

- `GET /api/activities?entity_type=contact&entity_id=<id>` — newest first.
- `POST /api/activities` `{ entity_type, entity_id, type, body }` — log a note.

## Integrations (Clawnify connections)

These use the org's Clawnify connections — no keys live in this app. Check what's
wired first: `GET /api/integrations/status` → `{ email, meeting, slack }`.

- **Email a contact** — `POST /api/integrations/email` `{ contact_id, subject, body }`.
  Sends from the org's Gmail connection (`gmail`), or its Google Workspace one
  (`googlesuper`) when Gmail isn't connected, and logs it on the contact.
- **Schedule a meeting** — `POST /api/integrations/meeting`
  `{ contact_id, summary, start_datetime, timezone, duration_minutes }`.
  Creates a Google Calendar event (`googlecalendar`, or `googlesuper` when Calendar
  isn't connected) with the contact and logs it.
  `start_datetime` is local wall-clock, e.g. `2026-07-16T13:00:00`; `timezone` is
  an IANA zone, e.g. `America/New_York`.
- **Deal-won Slack alert** — when a deal moves to a stage with `is_won: 1`, if
  `SLACK_CHANNEL` is set and Slack is connected, the app posts automatically.

If a capability isn't connected, the endpoint returns an error — tell the user to
connect it in the Clawnify dashboard; don't try to work around it.

## Gmail sync

The org's connected Gmail can be synced (Settings → **Email**): for each email with
a contact, the CRM keeps who wrote to whom and when. Email bodies stay in Gmail.

- `GET /api/contacts/{id}/emails`: the contact's synced emails, newest first,
  `{ emails, total, sync_on }`. Each email has `direction` (`sent`/`received`),
  `from_email`, `to_emails`, `sent_at`, and `subject` only when the mailbox's
  visibility shares subjects (otherwise `null`).
- `GET /api/emails/{mailbox}/{id}`: one email's text, read live from Gmail. Only
  when the mailbox shares everything (`can_open: true` on the email); 403 otherwise.
- Contacts carry `last_contacted_at` (read-only), so "who haven't we emailed in a
  month" is a filter on the contacts list: `last_contacted_at` `before` a date.
- `GET /api/email-sync` shows the settings and progress; `POST /api/email-sync/run`
  syncs now.

You can read synced emails and run a sync, but not change what a mailbox shares
or turn sync on or off: that is a person's decision, made in Settings → Email.
Don't work around a hidden subject by opening the email in the browser.

## Import contacts (CSV / XLSX)

Users import via the dashboard UI (Contacts → **Import**): upload a CSV/XLSX, map
columns to fields, import. Programmatically: `POST /api/contacts/import`
`{ contacts: [{ first_name, last_name?, email?, phone?, title?, status?, company? }] }`.
Company names are resolved to existing companies or created. Rows without a first
name are skipped. Returns `{ imported, companiesCreated, skipped }`.

## AI columns

A column can be filled by AI from the rest of each record: on Companies,
Industry and Notes; on Contacts, Title and Status; and the org's own attributes
except URLs, emails, phones and relations. A person turns it on from the
column header's spark and may give instructions that quote fields as
`{{field}}` (e.g. `{{name}}`, `{{domain}}`). Instructions that quote the domain
(`{{domain}}` on companies, `{{company_domain}}` on contacts) also give the AI
that company's homepage, read through Clawnify's page reader and kept 30 days
per company.

- `GET /api/ai-columns?entity_type=company|contact`: the fields the AI can
  fill, the columns it fills (with their `prompt`), and cells being filled or
  that failed (`error` says why).
- `POST /api/ai-columns/{entity}/{field}/fill` `{ ids: [...] }`: fill the empty
  cells among these records, at most 20 per request. A column fills one batch
  at a time (409 while one runs). It never overwrites a value.
- `POST /api/ai-columns/{entity}/{field}/cells/{id}`: write one cell again,
  replacing its value.

Fills spend the org's Clawnify credits: fill what the user asked for, not more.

## Agent-mode UI

Append `?agent=true` for larger targets and always-visible action buttons.
