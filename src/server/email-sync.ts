// Gmail sync: reads the org's connected mailbox and keeps, for every email with
// a contact, who wrote to whom and when. The body never leaves Gmail; the
// subject is stored only while the mailbox's visibility shows it. The rules
// (who counts, which searches) live in email-sync-rules.ts; this file is the
// I/O around them.
//
// First import, in steps, resumable from `import_cursor`:
//   1. sent      people you emailed become contacts (auto_create sent or wider)
//   2. received  people who emailed you become contacts (sent_and_received)
//   3. people    every contact's emails, 20 contacts per Gmail search
// Then `live`: every run reads the mail that arrived since `synced_until`.
// Runs are short (RUN_BUDGET_MS) and chained through the platform queue, so an
// import of a large mailbox continues after the page that started it closes.

import type { ConnectionsEnv } from "@clawnify/connections";
import { get, query, run } from "./db.js";
import { mailConnection, type GoogleConnection } from "./integrations.js";
import { workEmailDomain, findOrCreateCompanyByDomain, FREEMAIL_DOMAINS } from "./email-domains.js";
import {
  parseAddresses, isGroupAddress, isBlocked, normaliseBlocklist, creationCandidates, splitName,
  historyStart, sentQuery, receivedQuery, peopleQuery, sinceQuery,
  type Address, type AutoCreate, type History, type CreateRules, type Scope,
} from "./email-sync-rules.js";

export type Visibility = "metadata" | "subject" | "everything";
export const VISIBILITIES: Visibility[] = ["metadata", "subject", "everything"];
export const AUTO_CREATES: AutoCreate[] = ["none", "sent", "sent_and_received"];
export const HISTORIES: History[] = ["3m", "12m", "all"];

export interface EmailAccount {
  mailbox: string;
  enabled: number;
  labels: string;
  history: History;
  visibility: Visibility;
  auto_create: AutoCreate;
  exclude_group: number;
  exclude_personal: number;
  blocklist: string;
  phase: "idle" | "importing" | "live";
  import_cursor: string | null;
  synced_until: string | null;
  contacts_created: number;
  last_run_at: string | null;
  last_error: string | null;
  running_until: string | null;
  job_id: string | null;
  next_run_at: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

interface Cursor {
  step: "sent" | "received" | "people" | "live";
  page?: string | null;
  after_contact?: string;
  batch?: Array<{ id: string; email: string }>;
  /** When this import began. Live sync starts here, so mail that arrives while
   *  a long import runs is read afterwards rather than skipped. */
  started_at?: string;
  /** The newest message a live pass has seen; becomes synced_until when the pass ends. */
  max_seen?: string;
  /** Checking stored sent mail against Gmail: the last row checked (`sent_at|id`), or "done". */
  check?: string;
}

function firstStep(a: Pick<EmailAccount, "auto_create">): Cursor["step"] {
  return a.auto_create === "none" ? "people" : "sent";
}

/** Wall-clock budget of one run. Gmail reads are I/O, so this bounds waiting, not CPU. */
const RUN_BUDGET_MS = 20_000;
/** A run's lease outlives its budget, so a crashed run frees the mailbox soon after. */
const LEASE_MS = 90_000;
const PAGE_SIZE = 100;
const PEOPLE_BATCH = 20;
/** Once live, how often new mail is read. */
export const LIVE_INTERVAL_MS = 15 * 60_000;
/** How far back live reads start again when the mark is found in the future. */
const REWIND_MS = 30 * 86_400_000;
/** Stored sent rows one run checks against Gmail, at most. */
const CHECKS_PER_RUN = 20;

// shortcut: the org's one mail connection (Gmail, else Google Workspace). Once
// an org can connect several accounts (platform: multi-account connections),
// pass { account: mailbox } so each email_accounts row reads its own connection.
/** The org's mail connection, refused when it now signs in as another mailbox:
 *  one mailbox's mail is never written under another's settings. */
async function mailFor(env: ConnectionsEnv, mailbox: string): Promise<GoogleConnection> {
  const mail = await mailConnection(env);
  if (!mail) throw new Error("Gmail is not connected. Connect it in Clawnify to keep syncing.");
  const connected = await connectedMailbox(mail);
  if (connected !== mailbox) {
    throw new Error(`The connected Google account is now ${connected}, not ${mailbox}. Open Email settings to switch.`);
  }
  return mail;
}

/** The address of the mailbox a Google connection signs in as. */
export async function connectedMailbox(mail: GoogleConnection): Promise<string> {
  const data = (await mail.run("GET_PROFILE", { user_id: "me" })) as { emailAddress?: string } | null;
  const address = (data?.emailAddress ?? "").trim().toLowerCase();
  if (!address) throw new Error("The connected Google account did not report its address");
  return address;
}

/** The mailbox's labels, for choosing which ones to import. System labels
 *  (INBOX, SENT, CATEGORY_*…) are left out: "Everything" already covers them. */
export async function listLabels(mail: GoogleConnection): Promise<Array<{ id: string; name: string }>> {
  const data = (await mail.run("LIST_LABELS", { user_id: "me" })) as {
    labels?: Array<{ id?: string; name?: string; type?: string }>;
  } | null;
  return (data?.labels ?? [])
    .filter((l) => l.type !== "system" && l.id && l.name)
    .map((l) => ({ id: l.id!, name: l.name! }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

interface GmailMessage {
  messageId: string;
  threadId: string;
  messageTimestamp: string;
  sender?: string;
  to?: string;
  subject?: string;
  labelIds?: string[];
}

/** One page of a Gmail search, headers only. The preview snippet the API also
 *  returns is dropped here, so no body text reaches this app. */
async function fetchPage(mail: GoogleConnection, q: string, page: string | null | undefined, max = PAGE_SIZE) {
  const data = (await mail.run("FETCH_EMAILS", {
    query: q,
    max_results: max,
    verbose: false,
    include_payload: false,
    ...(page ? { page_token: page } : {}),
  })) as { messages?: GmailMessage[]; nextPageToken?: string } | null;
  const messages = (data?.messages ?? []).map((m) => ({
    messageId: m.messageId,
    threadId: m.threadId,
    messageTimestamp: m.messageTimestamp,
    sender: m.sender,
    to: m.to,
    subject: m.subject,
    labelIds: m.labelIds ?? [],
  }));
  return { messages, next: data?.nextPageToken || null };
}

interface Parsed {
  id: string;
  threadId: string;
  sentAt: string;
  direction: "sent" | "received";
  from: Address | null;
  to: Address[];
  subject: string;
  labelIds: string[];
}

/** Clock skew allowed before a message's date counts as the future. */
const FUTURE_SKEW_MS = 5 * 60_000;

function parse(m: GmailMessage & { labelIds: string[] }, mailbox: string, now: Date): Parsed | null {
  if (!m.messageId || !m.threadId || !m.messageTimestamp) return null;
  // Only what Gmail has sent is sent. A draft (Gmail saves one under a new id as
  // you type) and a scheduled send (no label until it goes out, dated when it
  // will) haven't happened, so neither is kept, links a contact or creates one.
  if (m.labelIds.includes("DRAFT") || Date.parse(m.messageTimestamp) > now.getTime() + FUTURE_SKEW_MS) return null;
  const from = parseAddresses(m.sender)[0] ?? null;
  const sent = m.labelIds.includes("SENT");
  if (!sent && from?.email === mailbox) return null;
  return {
    id: m.messageId,
    threadId: m.threadId,
    sentAt: m.messageTimestamp,
    direction: sent ? "sent" : "received",
    from,
    to: parseAddresses(m.to),
    subject: m.subject ?? "",
    labelIds: m.labelIds,
  };
}

// ── Settings rows ──────────────────────────────────────────────────

/** v1 syncs one mailbox at a time, the org's default connection; the table
 *  allows more. The enabled one wins, then the most recently changed. */
export async function currentAccount(): Promise<EmailAccount | null> {
  return (await get<EmailAccount>("SELECT * FROM email_accounts ORDER BY enabled DESC, updated_at DESC LIMIT 1")) ?? null;
}

export async function accountFor(mailbox: string): Promise<EmailAccount | null> {
  return (await get<EmailAccount>("SELECT * FROM email_accounts WHERE mailbox = ?", [mailbox])) ?? null;
}

function scopeOf(a: EmailAccount, now: Date): Scope {
  return { labels: jsonArray(a.labels).filter((l): l is string => typeof l === "string"), since: historyStart(a.history, now) };
}

/** The addresses and @domains this mailbox never imports. */
export function blocklistOf(a: EmailAccount): string[] {
  return normaliseBlocklist(jsonArray(a.blocklist));
}

function rulesOf(a: EmailAccount): CreateRules {
  return {
    mailbox: a.mailbox,
    policy: a.auto_create,
    excludeGroup: !!a.exclude_group,
    excludePersonal: !!a.exclude_personal,
    blocklist: blocklistOf(a),
    isPersonalDomain: (d) => FREEMAIL_DOMAINS.has(d),
  };
}

function jsonArray(v: string | null): unknown[] {
  try {
    const parsed = JSON.parse(v ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Contacts ───────────────────────────────────────────────────────

/** Every contact's address → id, read once per run and kept current as the run adds contacts. */
async function contactIndex(): Promise<Map<string, string>> {
  const rows = await query<{ id: string; email: string }>("SELECT id, email FROM contacts WHERE email IS NOT NULL AND email != ''");
  const index = new Map<string, string>();
  for (const r of rows) index.set(r.email.trim().toLowerCase(), r.id);
  return index;
}

/** A contact for someone the mailbox wrote to (or heard from), linked to their
 *  company by work domain the way import and create already do. */
async function createContact(person: Address): Promise<string> {
  const { first, last } = splitName(person);
  const domain = workEmailDomain(person.email);
  const companyId = domain ? await findOrCreateCompanyByDomain(domain) : null;
  const id = crypto.randomUUID();
  await run("INSERT INTO contacts (id, first_name, last_name, email, company_id) VALUES (?, ?, ?, ?, ?)", [id, first, last, person.email, companyId]);
  return id;
}

async function recomputeLastContacted(contactIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(contactIds)];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    await run(
      `UPDATE contacts SET last_contacted_at =
         (SELECT MAX(l.sent_at) FROM email_message_contacts l WHERE l.contact_id = contacts.id)
       WHERE id IN (${part.map(() => "?").join(", ")})`,
      part,
    );
  }
}

// ── Storing ────────────────────────────────────────────────────────

/** Keeps the messages that involve a contact, links them, and returns the contacts touched. */
async function storeAndLink(a: EmailAccount, messages: Parsed[], index: Map<string, string>): Promise<Set<string>> {
  const rules = rulesOf(a);
  const touched = new Set<string>();
  for (const m of messages) {
    if (m.from && isBlocked(m.from.email, rules.blocklist)) continue;
    if (m.direction === "received" && rules.excludeGroup && m.from && isGroupAddress(m.from.email)) continue;
    const people = [m.from, ...m.to].filter((p): p is Address => !!p && p.email !== a.mailbox && !isBlocked(p.email, rules.blocklist));
    const contactIds = [...new Set(people.map((p) => index.get(p.email)).filter((id): id is string => !!id))];
    if (!contactIds.length) continue;
    const subject = a.visibility === "metadata" ? null : m.subject;
    await run(
      `INSERT INTO email_messages (mailbox, id, thread_id, sent_at, direction, from_email, from_name, to_emails, subject)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (mailbox, id) DO UPDATE SET subject = excluded.subject`,
      [a.mailbox, m.id, m.threadId, m.sentAt, m.direction, m.from?.email ?? "", m.from?.name ?? null, JSON.stringify(m.to.map((t) => t.email)), subject],
    );
    for (const cid of contactIds) {
      await run("INSERT OR IGNORE INTO email_message_contacts (mailbox, message_id, contact_id, sent_at) VALUES (?, ?, ?, ?)", [a.mailbox, m.id, cid, m.sentAt]);
      touched.add(cid);
    }
  }
  return touched;
}

/** Adds contacts for the people these messages bring in under the account's policy. */
async function createFrom(a: EmailAccount, messages: Parsed[], index: Map<string, string>): Promise<number> {
  const rules = rulesOf(a);
  let created = 0;
  for (const m of messages) {
    for (const person of creationCandidates(m, rules)) {
      if (index.has(person.email)) continue;
      index.set(person.email, await createContact(person));
      created++;
    }
  }
  return created;
}

function later(a: string | undefined, b: string): string {
  return !a || b > a ? b : a;
}

/** Removes stored messages and their links; returns the contacts whose last contact may change. */
async function forget(mailbox: string, ids: string[]): Promise<string[]> {
  const affected: string[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const marks = part.map(() => "?").join(", ");
    const links = await query<{ contact_id: string }>(`SELECT DISTINCT contact_id FROM email_message_contacts WHERE mailbox = ? AND message_id IN (${marks})`, [mailbox, ...part]);
    affected.push(...links.map((l) => l.contact_id));
    await run(`DELETE FROM email_message_contacts WHERE mailbox = ? AND message_id IN (${marks})`, [mailbox, ...part]);
    await run(`DELETE FROM email_messages WHERE mailbox = ? AND id IN (${marks})`, [mailbox, ...part]);
  }
  return affected;
}

// ── Checking stored sent mail ──────────────────────────────────────

/** Gmail's answer for a message id it no longer has. */
const gone = (e: unknown) => e instanceof Error && /"code":\s*404|NOT_FOUND|Requested entity was not found/.test(e.message);

/**
 * Sent rows stored before "sent" meant "labelled SENT" can be drafts or
 * scheduled mail. Walks them newest first, a few per run, asking Gmail about
 * each: a row Gmail no longer has, or has not sent, is forgotten. Any other
 * failure stops the walk until the next run and forgets nothing.
 */
async function checkSent(mail: GoogleConnection, mailbox: string, from: string | undefined, deadline: number): Promise<{ check: string; dropped: number; affected: string[]; failed: boolean }> {
  const [at, id] = (from ?? "9999-12-31T23:59:59Z|").split("|");
  const rows = await query<{ id: string; sent_at: string }>(
    `SELECT id, sent_at FROM email_messages
      WHERE mailbox = ? AND direction = 'sent' AND (sent_at < ? OR (sent_at = ? AND id < ?))
      ORDER BY sent_at DESC, id DESC LIMIT ?`,
    [mailbox, at, at, id, CHECKS_PER_RUN],
  );
  const drop: string[] = [];
  let check = `${at}|${id}`;
  let checked = 0;
  let failed = false;
  for (const r of rows) {
    if (Date.now() > deadline) break;
    try {
      const data = (await mail.run("FETCH_MESSAGE_BY_MESSAGE_ID", { message_id: r.id, format: "minimal", user_id: "me" })) as { labelIds?: unknown } | null;
      if (Array.isArray(data?.labelIds) && !data.labelIds.includes("SENT")) drop.push(r.id);
    } catch (e) {
      if (!gone(e)) { failed = true; break; }
      drop.push(r.id);
    }
    check = `${r.sent_at}|${r.id}`;
    checked++;
  }
  if (!failed && checked === rows.length && rows.length < CHECKS_PER_RUN) check = "done";
  return { check, dropped: drop.length, affected: await forget(mailbox, drop), failed };
}

// ── Running ────────────────────────────────────────────────────────

/** Takes the mailbox for one run, or null when another run holds it. */
async function claim(mailbox: string, now: Date): Promise<boolean> {
  const rows = await query<{ mailbox: string }>(
    `UPDATE email_accounts SET running_until = ?
      WHERE mailbox = ? AND enabled = 1 AND (running_until IS NULL OR running_until < ?)
      RETURNING mailbox`,
    [new Date(now.getTime() + LEASE_MS).toISOString(), mailbox, now.toISOString()],
  );
  return rows.length === 1;
}

export interface RunResult {
  status: "ran" | "busy" | "off" | "error";
  phase?: EmailAccount["phase"];
  step?: Cursor["step"];
  created?: number;
  stored?: number;
  /** Stored rows removed because Gmail no longer has them or never sent them. */
  forgotten?: number;
  more?: boolean;
  error?: string;
}

/**
 * One bounded run: continue the first import, or read new mail once live.
 * `more` says whether work is left that should run again right away.
 */
export async function runSync(env: ConnectionsEnv, mailbox: string, now = new Date()): Promise<RunResult> {
  const a = await accountFor(mailbox);
  if (!a || !a.enabled) return { status: "off" };
  if (!(await claim(mailbox, now))) return { status: "busy" };

  const started = Date.now();
  let created = 0;
  let stored = 0;
  let forgotten = 0;
  // A first import keeps only mail Gmail labelled SENT, so it has nothing to check.
  let cursor: Cursor = parseCursor(a.import_cursor) ?? { step: firstStep(a), started_at: now.toISOString(), check: "done" };
  let check = cursor.check; // outlives the cursor's rebuilds below
  let phase = a.phase === "idle" ? "importing" : a.phase;
  try {
    const mail = await mailFor(env, a.mailbox);

    const scope = scopeOf(a, now);
    const index = await contactIndex();
    const touched = new Set<string>();

    if (phase === "live") {
      // The mark once followed a scheduled send into the future, and live reads
      // skipped the mail before it: read the last 30 days again (stores are idempotent).
      if (a.synced_until && a.synced_until > now.toISOString()) a.synced_until = new Date(now.getTime() - REWIND_MS).toISOString();
      const future = await query<{ id: string }>("SELECT id FROM email_messages WHERE mailbox = ? AND sent_at > ?", [a.mailbox, new Date(now.getTime() + FUTURE_SKEW_MS).toISOString()]);
      for (const cid of await forget(a.mailbox, future.map((f) => f.id))) touched.add(cid);
      forgotten += future.length;
    }

    while (Date.now() - started < RUN_BUDGET_MS) {
      if (cursor.step === "sent" || cursor.step === "received") {
        const q = cursor.step === "sent" ? sentQuery(scope) : receivedQuery(scope);
        const { messages, next } = await fetchPage(mail, q, cursor.page);
        created += await createFrom(a, messages.map((m) => parse(m, a.mailbox, now)).filter((m): m is Parsed => !!m), index);
        if (next) cursor = { ...cursor, page: next };
        else cursor = { step: cursor.step === "sent" && a.auto_create === "sent_and_received" ? "received" : "people", started_at: cursor.started_at };
        continue;
      }

      if (cursor.step === "people") {
        if (!cursor.batch?.length) {
          const batch = await query<{ id: string; email: string }>(
            `SELECT id, lower(trim(email)) AS email FROM contacts
              WHERE email IS NOT NULL AND email != '' AND id > ?
              ORDER BY id LIMIT ?`,
            [cursor.after_contact ?? "", PEOPLE_BATCH],
          );
          if (!batch.length) {
            phase = "live";
            a.synced_until = cursor.started_at ?? now.toISOString();
            cursor = { step: "live" };
            break; // the first live read runs on the next delivery
          }
          cursor = { ...cursor, batch, page: null };
        }
        const emails = cursor.batch!.map((b) => b.email).filter((e) => !isBlocked(e, rulesOf(a).blocklist));
        const { messages, next } = emails.length ? await fetchPage(mail, peopleQuery(emails, scope), cursor.page) : { messages: [], next: null };
        const parsed = messages.map((m) => parse(m, a.mailbox, now)).filter((m): m is Parsed => !!m);
        for (const cid of await storeAndLink(a, parsed, index)) touched.add(cid);
        stored += parsed.length;
        if (next) {
          cursor = { ...cursor, page: next };
        } else {
          for (const b of cursor.batch!) {
            await run(
              `INSERT INTO email_contact_imports (mailbox, contact_id, email) VALUES (?, ?, ?)
               ON CONFLICT (mailbox, contact_id) DO UPDATE SET email = excluded.email, imported_at = datetime('now')`,
              [a.mailbox, b.id, b.email],
            );
          }
          cursor = { step: "people", after_contact: cursor.batch![cursor.batch!.length - 1].id, started_at: cursor.started_at };
        }
        continue;
      }

      // live: everything since the last sync, all pages, then move the mark.
      const since = new Date(a.synced_until ?? now.toISOString());
      const { messages, next } = await fetchPage(mail, sinceQuery(since, scope), cursor.page);
      const parsed = messages.map((m) => parse(m, a.mailbox, now)).filter((m): m is Parsed => !!m);
      created += await createFrom(a, parsed, index);
      for (const cid of await storeAndLink(a, parsed, index)) touched.add(cid);
      stored += parsed.length;
      for (const m of parsed) cursor.max_seen = later(cursor.max_seen, m.sentAt);
      if (next) {
        cursor = { ...cursor, page: next };
        continue;
      }
      if (cursor.max_seen) a.synced_until = later(a.synced_until ?? undefined, cursor.max_seen);
      // The mark never passes the present, whatever a message's date says.
      if (a.synced_until && a.synced_until > now.toISOString()) a.synced_until = now.toISOString();
      cursor = { step: "live" };
      break;
    }

    let checkFailed = false;
    if (phase === "live" && cursor.step === "live" && !cursor.page && check !== "done") {
      try {
        const r = await checkSent(mail, a.mailbox, check, started + RUN_BUDGET_MS);
        check = r.check;
        forgotten += r.dropped;
        for (const cid of r.affected) touched.add(cid);
        checkFailed = r.failed;
      } catch {
        checkFailed = true; // checking is a cleanup: it never fails the sync
      }
    }

    await recomputeLastContacted(touched);
    const more = phase === "importing" || !!cursor.page || (phase === "live" && check !== "done" && !checkFailed);
    await run(
      `UPDATE email_accounts SET phase = ?, import_cursor = ?, synced_until = ?, contacts_created = contacts_created + ?,
              last_run_at = ?, last_error = NULL, running_until = NULL WHERE mailbox = ?`,
      [phase, JSON.stringify({ ...cursor, check }), a.synced_until, created, now.toISOString(), a.mailbox],
    );
    return { status: "ran", phase, step: cursor.step, created, stored, forgotten, more };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sync failed";
    await run(
      "UPDATE email_accounts SET import_cursor = ?, contacts_created = contacts_created + ?, last_run_at = ?, last_error = ?, running_until = NULL WHERE mailbox = ?",
      [JSON.stringify({ ...cursor, check }), created, now.toISOString(), message, a.mailbox],
    );
    return { status: "error", phase, step: cursor.step, created, stored, error: message };
  }
}

function parseCursor(v: string | null): Cursor | null {
  try {
    const c = JSON.parse(v ?? "null");
    return c && typeof c === "object" && typeof c.step === "string" ? (c as Cursor) : null;
  } catch {
    return null;
  }
}

// ── Scheduling ─────────────────────────────────────────────────────

type QueueEnv = { CLAWNIFY_TOKEN?: string; CLAWNIFY_QUEUE_URL?: string };

/**
 * Books the next run on the platform queue. The key is the app's host, the
 * mailbox and the target minute, so two requests noticing the same gap book one
 * job. Unavailable queue (local dev, an outage) is not an error: the next page
 * load or "Sync now" books again.
 */
export async function scheduleRun(env: QueueEnv, origin: string, mailbox: string, runAt: Date): Promise<void> {
  try {
    const { enqueueJob } = await import("@clawnify/queue");
    const job = await enqueueJob(env, {
      targetUrl: `${origin}/api/email-sync/run`,
      payload: { mailbox },
      runAt,
      idempotencyKey: `crm-email-${new URL(origin).host}-${mailbox}-${runAt.toISOString().slice(0, 16)}`,
      maxAttempts: 3,
    });
    await run("UPDATE email_accounts SET job_id = ?, next_run_at = ? WHERE mailbox = ?", [job.id, runAt.toISOString(), mailbox]);
  } catch {
    /* no queue: the watchdog in ensureScheduled books it later */
  }
}

/** Books a run when an enabled mailbox has none coming, or its booking is long overdue. */
export async function ensureScheduled(env: QueueEnv, origin: string, a: EmailAccount, now = new Date()): Promise<void> {
  if (!a.enabled) return;
  const overdue = !a.next_run_at || new Date(a.next_run_at).getTime() < now.getTime() - 5 * 60_000;
  if (overdue) await scheduleRun(env, origin, a.mailbox, now);
}

export async function cancelScheduled(env: QueueEnv, a: EmailAccount): Promise<void> {
  if (!a.job_id) return;
  try {
    const { cancelJob } = await import("@clawnify/queue");
    await cancelJob(env, a.job_id);
  } catch {
    /* already delivered or gone */
  }
}

// ── Changing settings ──────────────────────────────────────────────

/** Deletes everything synced from a mailbox and resets its progress. */
export async function purge(mailbox: string): Promise<void> {
  const affected = await query<{ contact_id: string }>("SELECT DISTINCT contact_id FROM email_message_contacts WHERE mailbox = ?", [mailbox]);
  await run("DELETE FROM email_message_contacts WHERE mailbox = ?", [mailbox]);
  await run("DELETE FROM email_messages WHERE mailbox = ?", [mailbox]);
  await run("DELETE FROM email_contact_imports WHERE mailbox = ?", [mailbox]);
  await recomputeLastContacted(affected.map((r) => r.contact_id));
  await run(
    "UPDATE email_accounts SET phase = 'idle', import_cursor = NULL, synced_until = NULL, next_run_at = NULL, job_id = NULL WHERE mailbox = ?",
    [mailbox],
  );
}

/** Restarts the first import at `step` (messages already stored are kept and refreshed). */
export async function restartImport(mailbox: string, step: Cursor["step"], now = new Date()): Promise<void> {
  // The rows a restart keeps were checked against Gmail before it, or still need
  // to be. No cursor means nothing is stored yet (new or purged), so nothing to check.
  const prev = parseCursor((await accountFor(mailbox))?.import_cursor ?? null);
  const cursor: Cursor = { step, started_at: now.toISOString(), check: prev ? prev.check : "done" };
  await run(
    "UPDATE email_accounts SET phase = 'importing', import_cursor = ?, next_run_at = NULL WHERE mailbox = ?",
    [JSON.stringify(cursor), mailbox],
  );
}

export { firstStep };

export async function forgetSubjects(mailbox: string): Promise<void> {
  await run("UPDATE email_messages SET subject = NULL WHERE mailbox = ?", [mailbox]);
}

// ── Reading ────────────────────────────────────────────────────────

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

/**
 * A contact's synced emails, newest first, as the mailbox's visibility allows:
 * the subject only above "metadata", the body (via openEmail) only at
 * "everything". Every caller gets this same view, people and agents alike.
 */
export async function contactEmails(contactId: string, limit = 50): Promise<{ emails: ContactEmail[]; total: number }> {
  const rows = await query<{
    id: string; mailbox: string; thread_id: string; sent_at: string; direction: "sent" | "received";
    from_email: string; from_name: string | null; to_emails: string; subject: string | null; visibility: Visibility;
  }>(
    `SELECT m.id, m.mailbox, m.thread_id, m.sent_at, m.direction, m.from_email, m.from_name, m.to_emails, m.subject, a.visibility
       FROM email_message_contacts l
       JOIN email_messages m ON m.mailbox = l.mailbox AND m.id = l.message_id
       JOIN email_accounts a ON a.mailbox = m.mailbox AND a.enabled = 1
      WHERE l.contact_id = ?
      ORDER BY m.sent_at DESC
      LIMIT ?`,
    [contactId, limit],
  );
  const total = (await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM email_message_contacts l JOIN email_accounts a ON a.mailbox = l.mailbox AND a.enabled = 1 WHERE l.contact_id = ?`,
    [contactId],
  ))?.n ?? 0;
  return {
    total,
    emails: rows.map((r) => ({
      id: r.id,
      mailbox: r.mailbox,
      thread_id: r.thread_id,
      sent_at: r.sent_at,
      direction: r.direction,
      from_email: r.from_email,
      from_name: r.from_name,
      to_emails: jsonArray(r.to_emails).filter((e): e is string => typeof e === "string"),
      subject: r.visibility === "metadata" ? null : r.subject,
      can_open: r.visibility === "everything",
      // authuser picks the signed-in account by address; Gmail doesn't decode an address in the /u/ path.
      gmail_url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(r.mailbox)}#all/${r.thread_id}`,
    })),
  };
}

/**
 * A contact added after the first import (or whose address changed) has no
 * history yet: read it now with one search. Runs only once per address.
 */
export async function importContactIfNeeded(env: ConnectionsEnv, contactId: string, now = new Date()): Promise<void> {
  const a = await currentAccount();
  if (!a || !a.enabled || a.phase !== "live") return;
  const contact = await get<{ email: string }>("SELECT lower(trim(email)) AS email FROM contacts WHERE id = ?", [contactId]);
  if (!contact?.email) return;
  const done = await get<{ email: string }>("SELECT email FROM email_contact_imports WHERE mailbox = ? AND contact_id = ?", [a.mailbox, contactId]);
  if (done?.email === contact.email) return;
  if (isBlocked(contact.email, rulesOf(a).blocklist)) return;

  const mail = await mailFor(env, a.mailbox);
  const { messages } = await fetchPage(mail, peopleQuery([contact.email], scopeOf(a, now)), null);
  const parsed = messages.map((m) => parse(m, a.mailbox, now)).filter((m): m is Parsed => !!m);
  const index = new Map([[contact.email, contactId]]);
  await storeAndLink(a, parsed, index);
  await recomputeLastContacted([contactId]);
  await run(
    `INSERT INTO email_contact_imports (mailbox, contact_id, email) VALUES (?, ?, ?)
     ON CONFLICT (mailbox, contact_id) DO UPDATE SET email = excluded.email, imported_at = datetime('now')`,
    [a.mailbox, contactId, contact.email],
  );
}

/** One opened email: its text, read live from Gmail and never stored, and who it went between. */
export interface OpenedEmail {
  text: string;
  subject: string;
  sent_at: string;
  direction: "sent" | "received";
  thread_id: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
}

/** One email's text, read live from Gmail and never stored. Only at "everything". */
export async function openEmail(env: ConnectionsEnv, mailbox: string, id: string): Promise<OpenedEmail | { error: string; status: 403 | 404 | 409 }> {
  const a = await accountFor(mailbox);
  if (!a || !a.enabled) return { error: "Email sync is off for this mailbox", status: 404 };
  if (a.visibility !== "everything") return { error: "This mailbox shares metadata only; open the email in Gmail", status: 403 };
  const known = await get("SELECT 1 AS ok FROM email_message_contacts WHERE mailbox = ? AND message_id = ? LIMIT 1", [mailbox, id]);
  if (!known) return { error: "Email not found", status: 404 };
  const row = await get<{ thread_id: string; sent_at: string; direction: "sent" | "received"; from_email: string; from_name: string | null; to_emails: string; subject: string | null }>(
    "SELECT thread_id, sent_at, direction, from_email, from_name, to_emails, subject FROM email_messages WHERE mailbox = ? AND id = ?",
    [mailbox, id],
  );
  if (!row) return { error: "Email not found", status: 404 };
  const mail = await mailConnection(env);
  if (!mail) return { error: "Gmail is not connected", status: 409 };
  const data = (await mail.run("FETCH_MESSAGE_BY_MESSAGE_ID", { message_id: id, format: "full", user_id: "me" })) as {
    messageText?: string;
    preview?: { body?: string };
    payload?: { headers?: Array<{ name?: string; value?: string }> };
  } | null;
  // Cc is only in the raw headers; the sync stores To but never Cc.
  const header = (name: string) => data?.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value;
  const storedTo = jsonArray(row.to_emails).filter((e): e is string => typeof e === "string").map((email) => ({ email, name: null }));
  const to = parseAddresses(header("to"));
  return {
    text: (data?.messageText || data?.preview?.body || "").trim(),
    subject: row.subject ?? "",
    sent_at: row.sent_at,
    direction: row.direction,
    thread_id: row.thread_id,
    from: row.from_email ? { email: row.from_email, name: row.from_name } : null,
    to: to.length ? to : storedTo,
    cc: parseAddresses(header("cc")),
  };
}

/** A synced email the CRM may reply to or forward: one it has linked to a contact, in an enabled mailbox. */
export async function knownEmail(mailbox: string, id: string): Promise<{ thread_id: string; subject: string | null; visibility: Visibility } | null> {
  return (await get<{ thread_id: string; subject: string | null; visibility: Visibility }>(
    `SELECT m.thread_id, m.subject, a.visibility
       FROM email_messages m
       JOIN email_accounts a ON a.mailbox = m.mailbox AND a.enabled = 1
      WHERE m.mailbox = ? AND m.id = ?
        AND EXISTS (SELECT 1 FROM email_message_contacts l WHERE l.mailbox = m.mailbox AND l.message_id = m.id)`,
    [mailbox, id],
  )) ?? null;
}

export async function counts(mailbox: string): Promise<{ emails: number; contacts: number }> {
  const e = await get<{ n: number }>("SELECT COUNT(*) AS n FROM email_messages WHERE mailbox = ?", [mailbox]);
  const c = await get<{ n: number }>("SELECT COUNT(DISTINCT contact_id) AS n FROM email_message_contacts WHERE mailbox = ?", [mailbox]);
  return { emails: e?.n ?? 0, contacts: c?.n ?? 0 };
}
