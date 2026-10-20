import { run } from "./db.js";

/** Newest email with a contact, whether synced or logged by the CRM/an agent. */
export async function recomputeLastContacted(contactIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(contactIds)];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    await run(
      `UPDATE contacts SET last_contacted_at = (
         SELECT MAX(at) FROM (
           SELECT strftime('%Y-%m-%dT%H:%M:%fZ', sent_at) AS at
             FROM email_message_contacts WHERE contact_id = contacts.id
           UNION ALL
           SELECT strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AS at
             FROM activities WHERE entity_type = 'contact' AND entity_id = contacts.id AND type = 'email'
         )
       ) WHERE id IN (${part.map(() => "?").join(", ")})`,
      part,
    );
  }
}

/** Explicit logging must surface failures; integration callers may choose best-effort logging. */
export async function appendActivity(
  entity_type: string,
  entity_id: string,
  type: string,
  body: string,
  meta: Record<string, unknown> = {},
  at?: string,
): Promise<void> {
  await run(
    "INSERT INTO activities (id, entity_type, entity_id, type, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))",
    [crypto.randomUUID(), entity_type, entity_id, type, body, JSON.stringify(meta), at ?? null],
  );
  if (entity_type === "contact" && type === "email") await recomputeLastContacted([entity_id]);
}
