# Decisions

## Dated contact email activity contributes to last-contacted

Keep the existing activity API and its `created_at` timeline timestamp, as dated
deal updates do. Accept an optional `at`, normalize it to SQLite's UTC timestamp
format, and reject invalid/future dates. Date-only inputs follow the deal-update
convention: noon UTC for an earlier day, now for today.

Calculate `contacts.last_contacted_at` from both synced email links and contact
activities of type `email`, normalizing both timestamp formats before taking the
maximum. Share this calculation with Gmail import and purge so removing synced
mail cannot erase separately logged outreach. Notes and meeting invitations do
not prove an email exchange and are excluded.

Explicit activity logging propagates storage failures. Integration logging stays
best-effort after a provider action, so a logging failure does not ask callers to
repeat an email that already sent. The activity insert and recency update are
separate writes, following the existing database adapter; a failed recency update
returns an error on explicit logging but can leave the timeline entry saved.

No schema migration is needed. Existing logged emails participate when a contact
is next recalculated by an email activity write or sync; this change does not
attempt to reconstruct historical event dates that were previously ignored.
