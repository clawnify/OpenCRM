// Customers: every company with a `customer_since`, and how each is doing. The
// facts come from the CRM (meetings and their digests, emails, tasks, insights)
// in a few grouped reads, with what the CRM can see of each account (whether the
// meeting and email syncs are on and working, and which contacts' emails have
// been read); the status and its reasons from meetings-rules.ts. Nothing here is
// stored: it is worked out on every read.

import { query } from "./db.js";
import { blocklistOf, currentAccount } from "./email-sync.js";
import { isBlocked } from "./email-sync-rules.js";
import { syncSettings } from "./meetings.js";
import { health, focus, type AccountHealth, type FocusAccount, type FocusItem, type Health, type Sight, type SyncState } from "./meetings-rules.js";

export interface CustomerRow extends Omit<AccountHealth, "silence"> {
  id: string;
  name: string;
  domain: string;
  customer_since: string;
  renewal_date: string | null;
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

/** Reads `sql` (its `?`s for `before`, then an `IN (…)` list) for the ids, 90 at a time: D1 binds at most 100 values. */
export async function inChunks<T>(ids: string[], sql: (marks: string) => string, before: unknown[] = []): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    out.push(...(await query<T>(sql(part.map(() => "?").join(", ")), [...before, ...part])));
  }
  return out;
}

/** Today as a calendar day where the viewer is: `tz` is their offset from UTC in minutes. */
export function localDay(now: Date, tz: number): string {
  return new Date(now.getTime() + tz * 60_000).toISOString().slice(0, 10);
}

const SEVERITY: Record<Health, number> = { red: 0, yellow: 1, unknown: 2, green: 3 };

/** Whether a sync is on, past its first import, and its latest run worked. */
function syncState(s: { enabled: number; phase: string; last_error: string | null } | null): SyncState {
  if (!s?.enabled) return "off";
  if (s.phase !== "live") return "importing";
  return s.last_error ? "failing" : "seen";
}

/** Activity types that are contact with the account, logged by hand or by an agent: not notes, stage changes or Slack posts. */
export const TOUCH_KINDS = ["call", "message", "email", "meeting"];
/** The latest of the rows' `created_at` (stored as SQLite's "YYYY-MM-DD HH:MM:SS", UTC) as ISO 8601. */
const ISO_MAX = "strftime('%Y-%m-%dT%H:%M:%SZ', MAX(a.created_at))";

/** What the CRM has seen of one company's contact with us. */
export interface AccountRead {
  last_meeting_at: string | null;
  next_meeting: { title: string; starts_at: string } | null;
  last_email_at: string | null;
  /** The latest call, message, email or meeting logged by hand on the company, its contacts or its deals. */
  last_logged_at: string | null;
  /** The last two digested calls, newest first. */
  moods: Array<{ sentiment: number | null; sentiment_reason: string | null; summary: string | null }>;
  /** Open insights, newest first. */
  insights: Array<{ kind: string; text: string }>;
  sight: Sight;
}

/**
 * What the CRM has seen of each company's contact with us, in a few grouped
 * reads: its calls (the last one and the next booked), emails, the moods of its
 * last calls, its open insights, and what the CRM can see of it (whether the
 * meeting and email syncs are on and working, and which contacts' emails have
 * been read). Shared by Customers and the deals' progress, so both judge an
 * account on the same facts.
 */
export async function readAccounts(ids: string[], now: Date): Promise<{ of: (id: string) => AccountRead; calls: SyncState; emails: SyncState }> {
  const nowIso = now.toISOString();
  const meetings = await inChunks<{ company_id: string; last_at: string | null; next_at: string | null }>(ids, (m) =>
    `SELECT company_id,
            MAX(CASE WHEN starts_at <= ? THEN starts_at END) AS last_at,
            MIN(CASE WHEN starts_at > ? THEN starts_at END) AS next_at
       FROM meetings WHERE link_status IN ('auto', 'manual') AND company_id IN (${m}) GROUP BY company_id`,
    [nowIso, nowIso],
  );
  const upcoming = await inChunks<{ company_id: string; title: string; starts_at: string }>(ids, (m) =>
    `SELECT company_id, title, starts_at FROM (
       SELECT company_id, title, starts_at, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY starts_at) AS rn
         FROM meetings WHERE link_status IN ('auto', 'manual') AND starts_at > ? AND company_id IN (${m})
     ) WHERE rn = 1`,
    [nowIso],
  );
  const emails = await inChunks<{ company_id: string; last_at: string | null }>(ids, (m) =>
    `SELECT company_id, MAX(last_contacted_at) AS last_at FROM contacts WHERE company_id IN (${m}) GROUP BY company_id`,
  );
  const moods = await inChunks<{ company_id: string; sentiment: number; sentiment_reason: string | null; summary: string | null; rn: number }>(ids, (m) =>
    `SELECT company_id, sentiment, sentiment_reason, summary, rn FROM (
       SELECT company_id, sentiment, sentiment_reason, summary,
              ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY starts_at DESC) AS rn
         FROM meetings
        WHERE digest_status = 'done' AND link_status IN ('auto', 'manual') AND company_id IN (${m})
     ) WHERE rn <= 2`,
  );
  const insights = await inChunks<{ company_id: string; kind: string; text: string }>(ids, (m) =>
    `SELECT company_id, kind, text FROM insights WHERE status = 'open' AND company_id IN (${m}) ORDER BY created_at DESC`,
  );
  // Touches logged by hand or by an agent, on the company, its contacts or its
  // deals; one IN list per read, so each stays inside D1's bound-value cap.
  const touched = (sql: (m: string) => string) =>
    inChunks<{ company_id: string; at: string | null }>(ids, sql, TOUCH_KINDS);
  const kinds = TOUCH_KINDS.map(() => "?").join(", ");
  const logged = [
    ...(await touched((m) => `SELECT entity_id AS company_id, ${ISO_MAX} AS at FROM activities a
        WHERE a.entity_type = 'company' AND a.type IN (${kinds}) AND a.entity_id IN (${m}) GROUP BY a.entity_id`)),
    ...(await touched((m) => `SELECT c.company_id, ${ISO_MAX} AS at FROM activities a JOIN contacts c ON c.id = a.entity_id
        WHERE a.entity_type = 'contact' AND a.type IN (${kinds}) AND c.company_id IN (${m}) GROUP BY c.company_id`)),
    ...(await touched((m) => `SELECT d.company_id, ${ISO_MAX} AS at FROM activities a JOIN deals d ON d.id = a.entity_id
        WHERE a.entity_type = 'deal' AND a.type IN (${kinds}) AND d.company_id IN (${m}) GROUP BY d.company_id`)),
  ];

  const calls = syncState(await syncSettings());
  const mailbox = await currentAccount();
  const emailSight = syncState(mailbox);
  // Which contacts the email sync reads, and whose history it has read: a
  // contact added after the first import is read the first time it is opened.
  const people = mailbox && (emailSight === "seen" || emailSight === "failing")
    ? await inChunks<{ company_id: string; first_name: string; email: string; imported: string | null }>(ids, (m) =>
      `SELECT c.company_id, c.first_name, lower(trim(c.email)) AS email,
              (SELECT i.email FROM email_contact_imports i WHERE i.mailbox = ? AND i.contact_id = c.id) AS imported
         FROM contacts c WHERE c.email IS NOT NULL AND TRIM(c.email) != '' AND c.company_id IN (${m})
        ORDER BY c.first_name`,
      [mailbox.mailbox],
    )
    : [];
  const blocklist = mailbox ? blocklistOf(mailbox) : [];

  const by = <T extends { company_id: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const r of rows) map.set(r.company_id, [...(map.get(r.company_id) ?? []), r]);
    return map;
  };
  const meetingsBy = by(meetings);
  const upcomingBy = by(upcoming);
  const emailsBy = by(emails);
  const moodsBy = by(moods);
  const insightsBy = by(insights);
  const peopleBy = by(people);
  const loggedBy = by(logged);

  const of = (id: string): AccountRead => {
    const mt = meetingsBy.get(id)?.[0];
    const next = upcomingBy.get(id)?.[0];
    const read = (peopleBy.get(id) ?? []).filter((p) => !isBlocked(p.email, blocklist));
    return {
      last_meeting_at: mt?.last_at ?? null,
      next_meeting: next ? { title: next.title, starts_at: next.starts_at } : null,
      last_email_at: emailsBy.get(id)?.[0]?.last_at ?? null,
      last_logged_at: (loggedBy.get(id) ?? []).map((l) => l.at).filter((at): at is string => !!at).sort().pop() ?? null,
      moods: (moodsBy.get(id) ?? []).sort((a, b) => a.rn - b.rn),
      insights: insightsBy.get(id) ?? [],
      sight: {
        calls,
        emails: emailSight,
        addressed: read.length,
        all_blocked: read.length === 0 && (peopleBy.get(id)?.length ?? 0) > 0,
        unread: read.filter((p) => p.imported !== p.email).map((p) => p.first_name),
      },
    };
  };
  return { of, calls, emails: emailSight };
}

/**
 * Every customer with its status and reasons, worst first; the few things worth
 * doing first; the calls with customers in the next seven days; and whether the
 * CRM can see calls and emails at all.
 */
export async function customersOverview(now = new Date(), tz = 0): Promise<{
  customers: CustomerRow[];
  focus: FocusItem[];
  upcoming: UpcomingCall[];
  counts: Record<Health, number>;
  sight: { calls: SyncState; emails: SyncState };
}> {
  const companies = await query<{ id: string; name: string; domain: string; customer_since: string; renewal_date: string | null }>(
    "SELECT id, name, domain, customer_since, renewal_date FROM companies WHERE customer_since IS NOT NULL AND TRIM(customer_since) != '' ORDER BY name",
  );
  const ids = companies.map((c) => c.id);
  const nowIso = now.toISOString();
  const today = localDay(now, tz);

  const accounts = await readAccounts(ids, now);
  const tasks = await inChunks<{ id: string; company_id: string; title: string; owed_by: string; due_date: string | null }>(ids, (m) =>
    `SELECT id, company_id, title, owed_by, due_date FROM tasks WHERE done_at IS NULL AND company_id IN (${m}) ORDER BY due_date`,
  );
  const tasksBy = new Map<string, typeof tasks>();
  for (const t of tasks) tasksBy.set(t.company_id, [...(tasksBy.get(t.company_id) ?? []), t]);

  const focusInput: FocusAccount[] = [];
  const customers: CustomerRow[] = [];
  for (const c of companies) {
    const a = accounts.of(c.id);
    const next_at = a.next_meeting?.starts_at ?? null;
    const mood = a.moods;
    const open = tasksBy.get(c.id) ?? [];
    const ours = open.filter((t) => t.owed_by !== "them");
    const theirs = open.filter((t) => t.owed_by === "them");
    const overdue = (list: typeof open) => list.filter((t): t is typeof t & { due_date: string } => !!t.due_date && t.due_date < today);
    const notes = a.insights;
    const risks = notes.filter((i) => i.kind === "risk").map((i) => i.text);
    const { silence, ...h } = health({
      last_meeting_at: a.last_meeting_at,
      last_email_at: a.last_email_at,
      last_logged_at: a.last_logged_at,
      next_meeting_at: next_at,
      ours_overdue: overdue(ours),
      theirs_overdue: overdue(theirs),
      sentiments: mood.filter((m): m is typeof m & { sentiment: number } => m.sentiment !== null).map((m) => ({ value: m.sentiment, reason: m.sentiment_reason })),
      risks,
      sight: a.sight,
      renewal_date: c.renewal_date,
    }, now, today);
    customers.push({
      id: c.id,
      name: c.name,
      domain: c.domain,
      customer_since: c.customer_since,
      renewal_date: c.renewal_date || null,
      ...h,
      last_meeting_at: a.last_meeting_at,
      next_meeting_at: next_at,
      last_summary: mood[0]?.summary ?? null,
      last_sentiment: mood[0]?.sentiment ?? null,
      ours_open: ours.length,
      ours_overdue: overdue(ours).length,
      theirs_open: theirs.length,
      ideas: notes.filter((i) => i.kind === "idea").length,
      expansion: notes.filter((i) => i.kind === "expansion").length,
      risks: risks.length,
    });
    focusInput.push({
      id: c.id,
      name: c.name,
      status: h.status,
      next_meeting_at: next_at,
      silence,
      renewal_date: c.renewal_date,
      ours_overdue: overdue(ours).map((t) => ({ id: t.id, title: t.title, due_date: t.due_date })),
      ours_due_today: ours.filter((t) => t.due_date === today).map((t) => ({ id: t.id, title: t.title })),
      risks,
    });
  }
  customers.sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || (b.days_quiet ?? Infinity) - (a.days_quiet ?? Infinity) || a.name.localeCompare(b.name));

  const week = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const calls = await inChunks<{ id: string; title: string; starts_at: string; company_id: string }>(ids, (m) =>
    `SELECT id, title, starts_at, company_id FROM meetings
      WHERE link_status IN ('auto', 'manual') AND starts_at > ? AND starts_at <= ? AND company_id IN (${m})`,
    [nowIso, week],
  );
  const named = new Map(customers.map((c) => [c.id, c]));
  const upcoming = calls
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .map((m) => {
      const c = named.get(m.company_id)!;
      return { id: m.id, title: m.title, starts_at: m.starts_at, company_id: m.company_id, company_name: c.name, company_domain: c.domain, ours_open: c.ours_open, last_summary: c.last_summary };
    });

  const counts: Record<Health, number> = { red: 0, yellow: 0, unknown: 0, green: 0 };
  for (const c of customers) counts[c.status]++;
  return { customers, focus: focus(focusInput, 3, today), upcoming, counts, sight: { calls: accounts.calls, emails: accounts.emails } };
}
