// How each open deal is moving: its next step and the reasons to look at it,
// worked out on every read like the Customers page (customers.ts). A deal's
// calls, emails and logged touches are its company's (its own company, else
// its contact's), so a meeting imported before the deal existed counts, and a
// company with two open deals shows the same calls on both. The rules live in
// meetings-rules.ts (nextStep, dealHealth).

import { query } from "./db.js";
import { inChunks, localDay, readAccounts, TOUCH_KINDS } from "./customers.js";
import { dealHealth, type DealProgress, type Health, type SyncState } from "./meetings-rules.js";

export interface ProgressDeal {
  id: string;
  stage: string;
  company_id: string | null;
  contact_id: string | null;
  close_date: string | null;
}

/** Stages that end a deal: won or lost. Any other stage, a renamed or unknown one included, is open. */
export async function closedStages(): Promise<Set<string>> {
  const rows = await query<{ key: string }>("SELECT key FROM stages WHERE is_won = 1 OR is_lost = 1");
  return new Set(rows.map((r) => r.key));
}

/**
 * The progress of each open deal among `deals`, by deal id; won and lost deals
 * are left out. `tz` is the viewer's offset from UTC in minutes, for what
 * counts as today and overdue. Also says whether the CRM can see calls and
 * emails at all.
 */
export async function dealsProgress(
  deals: ProgressDeal[],
  now = new Date(),
  tz = 0,
): Promise<{ progress: Map<string, DealProgress>; sight: { calls: SyncState; emails: SyncState } }> {
  const closed = await closedStages();
  const open = deals.filter((d) => !closed.has(d.stage));

  // A deal with no company of its own takes its contact's.
  const contactIds = [...new Set(open.filter((d) => !d.company_id && d.contact_id).map((d) => d.contact_id!))];
  const viaContact = new Map(
    (await inChunks<{ id: string; company_id: string | null }>(contactIds, (m) => `SELECT id, company_id FROM contacts WHERE id IN (${m})`))
      .map((c) => [c.id, c.company_id]),
  );
  const accountOf = (d: ProgressDeal) => d.company_id ?? (d.contact_id ? viaContact.get(d.contact_id) ?? null : null);
  const accountIds = [...new Set(open.map(accountOf).filter((id): id is string => !!id))];
  const accounts = await readAccounts(accountIds, now);

  // Open tasks: the deal's own, and its company's that are on no deal.
  const dealIds = open.map((d) => d.id);
  type OpenTask = { deal_id: string | null; company_id: string | null; title: string; owed_by: "us" | "them"; due_date: string | null };
  const ownTasks = await inChunks<OpenTask>(dealIds, (m) =>
    `SELECT deal_id, company_id, title, owed_by, due_date FROM tasks WHERE done_at IS NULL AND deal_id IN (${m})`);
  const companyTasks = await inChunks<OpenTask>(accountIds, (m) =>
    `SELECT deal_id, company_id, title, owed_by, due_date FROM tasks WHERE done_at IS NULL AND deal_id IS NULL AND company_id IN (${m})`);
  // A deal with no company: touches logged on the deal itself are all there is.
  const loose = open.filter((d) => !accountOf(d)).map((d) => d.id);
  const looseLogged = await inChunks<{ deal_id: string; at: string | null }>(loose, (m) =>
    `SELECT entity_id AS deal_id, strftime('%Y-%m-%dT%H:%M:%SZ', MAX(created_at)) AS at FROM activities
      WHERE entity_type = 'deal' AND type IN (${TOUCH_KINDS.map(() => "?").join(", ")}) AND entity_id IN (${m}) GROUP BY entity_id`,
    TOUCH_KINDS);

  const today = localDay(now, tz);
  const progress = new Map<string, DealProgress>();
  for (const d of open) {
    const account = accountOf(d);
    const a = account ? accounts.of(account) : null;
    const tasks = [
      ...ownTasks.filter((t) => t.deal_id === d.id),
      ...(account ? companyTasks.filter((t) => t.company_id === account) : []),
    ].map((t) => ({ title: t.title, due_date: t.due_date, owed_by: t.owed_by === "them" ? "them" as const : "us" as const }));
    progress.set(d.id, dealHealth({
      last_meeting_at: a?.last_meeting_at ?? null,
      last_email_at: a?.last_email_at ?? null,
      last_logged_at: a?.last_logged_at ?? looseLogged.find((l) => l.deal_id === d.id)?.at ?? null,
      sight: a?.sight ?? { calls: accounts.calls, emails: accounts.emails, addressed: 0, all_blocked: false, unread: [] },
      next_meeting: a?.next_meeting ? { ...a.next_meeting, day: localDay(new Date(a.next_meeting.starts_at), tz) } : null,
      tasks,
      sentiments: (a?.moods ?? [])
        .filter((m): m is typeof m & { sentiment: number } => m.sentiment !== null)
        .map((m) => ({ value: m.sentiment, reason: m.sentiment_reason })),
      risks: (a?.insights ?? []).filter((i) => i.kind === "risk").map((i) => i.text),
      close_date: d.close_date?.trim() || null,
      no_company: !account,
    }, now, today));
  }
  return { progress, sight: { calls: accounts.calls, emails: accounts.emails } };
}

export const SEVERITY: Record<Health, number> = { red: 0, yellow: 1, unknown: 2, green: 3 };
