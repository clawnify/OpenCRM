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
wired first: `GET /api/integrations/status` → `{ email, meeting, slack, notes, mailbox }` (`notes`:
Granola; `mailbox`: the address email goes out from, once email sync is set up).

- **Send an email** — `POST /api/integrations/email`
  `{ to: [addresses], cc?, bcc?, subject, body }`, or `{ contact_id, subject, body }`
  to email one contact. Sends from the org's Gmail connection (`gmail`), or its
  Google Workspace one (`googlesuper`) when Gmail isn't connected, and logs it on
  every recipient who is a contact. At most 50 recipients.
  - **Reply** inside a synced thread: add `reply_to: { mailbox, id }` (an email from
    `GET /api/contacts/{id}/emails`). The thread keeps its subject; `body` is required.
  - **Forward** a synced email: add `forward: { mailbox, id }`; `body` is an optional
    note above it. Only when the mailbox shares everything; 403 otherwise.
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
- `GET /api/emails/{mailbox}/{id}`: one email's text, read live from Gmail, with
  `subject`, `from`, `to` and `cc` (for Reply all). Only when the mailbox shares
  everything (`can_open: true` on the email); 403 otherwise.
- Contacts carry `last_contacted_at` (read-only), so "who haven't we emailed in a
  month" is a filter on the contacts list: `last_contacted_at` `before` a date.
- `GET /api/email-sync` shows the settings and progress; `POST /api/email-sync/sync-now`
  syncs now.

You can read synced emails and run a sync, but not change what a mailbox shares
or turn sync on or off: that is a person's decision, made in Settings → Email.
Don't work around a hidden subject by opening the email in the browser.

## Meetings, tasks, insights and customers

The org's calendar and Granola call notes can be synced (Settings → **Meetings**).
Every meeting with people from outside is linked to its company (by the people
invited), and each linked call with a Granola note is read once by the AI: a
summary, how it went (`sentiment`, -2 to 2), tasks promised in it and insights.
Transcripts stay in Granola. Meetings with only the team are never listed.

- `GET /api/meetings?company_id=&when=upcoming|past&link=unmatched`: meetings,
  newest first (upcoming: soonest first). `link=unmatched` lists the ones waiting
  for a person to link. `PATCH /api/meetings/{id}` `{ company_id }` links one
  (its other unmatched meetings from the same domain follow), `{ company_id: null }`
  unlinks, `{ ignored: true }` marks it as not an account meeting.
- `GET /api/tasks?company_id=&status=open|done|all&owed_by=us|them`: tasks, open
  ones by due date. `owed_by: us` is something we promised; `them` is something
  we're waiting on. `POST /api/tasks` `{ title, company_id?, due_date?, owed_by? }`,
  `PUT /api/tasks/{id}` `{ done: true }` to complete one, `DELETE /api/tasks/{id}`.
- `GET /api/insights?company_id=&kind=idea|expansion|risk`: what calls said beyond
  tasks, each with the `quote` it came from. `PUT /api/insights/{id}`
  `{ status: done|dismissed }`; `POST /api/insights/{id}/deal` turns an expansion
  into a deal at the first stage.
- `GET /api/customers`: every company with `customer_since` set, worst first,
  each with `status` (red/yellow/green, or `unknown` when nothing is against it
  but the CRM can't see whether anyone has been in touch) and the `reasons` in
  plain words; `focus` (the few things to do first) and `upcoming` (calls with
  customers this week). Silence is only judged through what the CRM can see:
  calls when the meeting sync is on, emails when the email sync is on and has
  read that contact's history. `sight` says whether each sync is `seen`, `off`,
  `importing` or `failing`, and a reason names what it can't see ("No contact in
  30 days (calls aren't synced)"). Say that part too: never report an account
  as quiet when the CRM can't see it.
  A company becomes a customer with `PUT /api/companies/{id}` `{ customer_since: "YYYY-MM-DD" }`,
  or from the close date of its first won deal (never later than today). A date
  already set stays: if a deal was marked won by mistake, clear `customer_since`
  by hand. `{ renewal_date: "YYYY-MM-DD" }` sets the next renewal: within 30 days
  it shows as a reason and in `focus`, and once passed it asks for the next date.
- `GET /api/lookup?email=&domain=`: what the CRM knows about an address before
  anyone writes to it. The contact with exactly that address; their company (else
  the one on `domain`, else on the address's own work domain), with
  `customer_since` when it is a customer; its and the contact's `deals` (open
  first, each with `state` open, won or lost); `last_call_at`; and the
  `next_meeting` booked. Check it before a cold email: a customer, an open deal or
  a booked call means a person should decide whether it goes out.
  `POST /api/lookup` `{ "addresses": [{ "email", "domain"? }] }` answers up to 100
  at once, in order (`results`), to check a batch before they join a campaign.

To answer "how is <customer> doing" or "what did we promise <company>", read
these, and quote the reasons and the call's words rather than paraphrasing them.
Turning the sync on or off, and what it reads, is a person's decision made in
Settings → Meetings; you can run it (`POST /api/meetings/sync-now`).

## Deals: next steps and updates

Every open deal (stage neither won nor lost) has a next step: the soonest of the
next call booked with its company and its open tasks with a date, ours or
theirs. A task without a date is not a next step.

- `GET /api/deals/progress`: open deals, worst first, each with `progress`:
  `status` (red/yellow/green/unknown), the `reasons` in plain words, `next_step`,
  and `days_quiet`. `GET /api/deals/{id}` and the board carry `progress` too.
  Red: one of our promises is overdue, the last call went badly, a risk is
  open, or no next step and no contact in 14 days. Yellow: no next step, no
  contact in 14 days, waiting on them, or the close date has passed. As for
  customers, silence is only judged through what the CRM can see: say so.
- `GET /api/tasks?deal_id=`: the deal's tasks, and its company's on no deal.

When the user tells you what happened on a deal (a phone call, a WhatsApp or
text message, an email from an inbox the CRM doesn't read, a meeting moved or
held in person), log it in one call:
`POST /api/deals/{id}/updates`
`{ kind: call|message|email|meeting|note, summary, at?, done_task_ids?, next_step?: { title, due_date, owed_by }, close_date? }`.

- `at` is when it happened (ISO 8601 or `YYYY-MM-DD`), never in the future: what
  will happen goes in `next_step`, with the date agreed and who owes it.
- Read the deal's open tasks first, and put the ones this update finished in
  `done_task_ids` ("they sent the contract" closes "Signed contract").
- Find the deal through its company: `GET /api/companies?search=<name>`, then
  `GET /api/deals?company_id=<id>` (`search` on deals matches only a deal's name
  and notes). Ask when two deals could match; never log an update on a guess.
- Don't log what the CRM already reads: calendar meetings and Gmail are synced
  when `GET /api/integrations/status` says so, and a moved meeting updates on
  its own there.
- Next steps are this CRM's tasks, not your own task list. Move the stage with
  `PUT /api/deals/{id}` `{ stage }`.

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
