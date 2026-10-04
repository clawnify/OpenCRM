// Meetings: the org's calendar and its Granola notes, read into the CRM. For
// each meeting with people from outside: when, with whom, which company, and,
// once its Granola note is found, what the call produced (a summary, the mood,
// tasks and insights). The transcript is read when needed and never stored. The
// rules live in meetings-rules.ts; this file is the I/O around them.
//
// A run does one bounded job:
//   sync    read the calendar window, then the Granola notes updated since the
//           last read, placing each note on its meeting. The first import reads
//           `history_days` back; after that, every LIVE_INTERVAL_MS, the last
//           two days and the next two weeks. Resumable from `cursor`.
//   digest  when nothing is due, one queued call's transcript goes to the AI.
// Runs chain through the platform queue, so an import continues after the page
// that started it closes (as the Gmail sync does).

import type { ConnectionsEnv, GenericClient } from "@clawnify/connections";
import { get, query, run } from "./db.js";
import { calendarConnection, notesConnection, type GoogleConnection } from "./integrations.js";
import { FREEMAIL_DOMAINS } from "./email-domains.js";
import { complete, ModelError, type AiEnv } from "./model.js";
import {
  ownSide, eventMeeting, matchCompany, normaliseDomain, emailDomain, noteWindow, placeNote, notePeople,
  transcriptText, speakersKnown, coerceDigest, FRESH_DAYS,
  type Own, type GoogleEvent, type GranolaNote, type Person, type CompanyIndex, type Slot,
} from "./meetings-rules.js";

const isPersonal = (d: string) => FREEMAIL_DOMAINS.has(d);
const iso = (ms: number) => new Date(ms).toISOString();
const DAY_MS = 86_400_000;

/** Wall-clock budget of one sync run. Calendar and Granola reads are I/O, so this bounds waiting. */
const RUN_BUDGET_MS = 20_000;
/** A run's lease outlives its budget, so a crashed run frees the sync soon after. */
const LEASE_MS = 90_000;
/** Once live, how often the calendar and Granola are read again. */
export const LIVE_INTERVAL_MS = 15 * 60_000;
/** A live read covers the last two days (late edits) and the next two weeks (calls to prepare). */
const LIVE_BACK_MS = 2 * DAY_MS;
const AHEAD_MS = 14 * DAY_MS;
/** Notes are read again from an hour before the last read: one can update after a later one was read. */
const NOTES_OVERLAP_MS = 60 * 60_000;
const NOTES_PAGE = 30;
const EVENTS_PAGE = 250;
/** A digest left running this long was dropped by its run and is queued again. */
const STALE_DIGEST_SECONDS = 180;
const DIGEST_TIMEOUT_MS = 25_000;
/** Enough of a long call for the model; past it the middle goes (transcriptText). */
const TRANSCRIPT_CHARS = 150_000;
export const HISTORY_DAYS = [30, 90, 365];

export interface MeetingSync {
  id: number;
  enabled: number;
  history_days: number;
  about: string;
  calendar_owner: string | null;
  phase: "idle" | "importing" | "live";
  cursor: string | null;
  calendar_synced_at: string | null;
  notes_synced_until: string | null;
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
  step: "calendar" | "notes";
  from: string;
  to: string;
  page?: string | null;
  notes_since?: string;
  notes_page?: string | null;
  /** The newest note update this pass has read; becomes notes_synced_until when it ends. */
  max_seen?: string;
}

export type LinkStatus = "auto" | "manual" | "unmatched" | "ignored" | "internal";
export type DigestStatus = "none" | "queued" | "running" | "done" | "error";

export interface MeetingRow {
  id: string;
  calendar_event_id: string | null;
  note_id: string | null;
  title: string;
  starts_at: string;
  ends_at: string | null;
  attendees: string;
  company_id: string | null;
  link_status: LinkStatus;
  calendar_url: string | null;
  note_url: string | null;
  note_updated_at: string | null;
  summary: string | null;
  sentiment: number | null;
  sentiment_reason: string | null;
  digest_status: DigestStatus;
  digest_error: string | null;
  digested_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Settings ───────────────────────────────────────────────────────

export async function syncSettings(): Promise<MeetingSync | null> {
  return (await get<MeetingSync>("SELECT * FROM meeting_sync WHERE id = 1")) ?? null;
}

/**
 * Save settings. Turning sync on, or reaching further back, starts the import
 * over (stored meetings are kept and refreshed). Turning it off stops reading;
 * the meetings, tasks and insights already in the CRM stay.
 */
export async function saveSettings(
  patch: { enabled?: boolean; history_days?: number; about?: string },
  who: string | null,
): Promise<{ before: MeetingSync | null; after: MeetingSync }> {
  const before = await syncSettings();
  const enabled = patch.enabled ?? !!before?.enabled;
  const history = patch.history_days ?? before?.history_days ?? 90;
  const about = patch.about ?? before?.about ?? "";
  await run(
    `INSERT INTO meeting_sync (id, enabled, history_days, about, updated_by, updated_at) VALUES (1, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, history_days = excluded.history_days, about = excluded.about,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [enabled ? 1 : 0, history, about, who],
  );
  const reachesFurther = !!before && history > before.history_days;
  if (enabled && (!before?.enabled || reachesFurther)) {
    await run(
      "UPDATE meeting_sync SET phase = 'importing', cursor = NULL, calendar_synced_at = NULL, notes_synced_until = NULL, next_run_at = NULL WHERE id = 1",
    );
  }
  return { before, after: (await syncSettings())! };
}

// ── What the CRM knows ─────────────────────────────────────────────

/** Contacts and company domains, read once per run, for telling which company a meeting is with. */
async function companyIndex(): Promise<CompanyIndex> {
  const contacts = await query<{ email: string; company_id: string }>(
    "SELECT lower(trim(email)) AS email, company_id FROM contacts WHERE company_id IS NOT NULL AND email IS NOT NULL AND email != ''",
  );
  const companies = await query<{ id: string; domain: string }>("SELECT id, domain FROM companies WHERE domain IS NOT NULL AND domain != '' ORDER BY created_at");
  const index: CompanyIndex = { contacts: new Map(), contactDomains: new Map(), domains: new Map() };
  const perDomain = new Map<string, Map<string, number>>();
  for (const c of contacts) {
    index.contacts.set(c.email, c.company_id);
    const d = emailDomain(c.email);
    if (!d || isPersonal(d)) continue;
    const counts = perDomain.get(d) ?? new Map<string, number>();
    counts.set(c.company_id, (counts.get(c.company_id) ?? 0) + 1);
    perDomain.set(d, counts);
  }
  for (const [d, counts] of perDomain) {
    index.contactDomains.set(d, [...counts].sort((a, b) => b[1] - a[1])[0][0]);
  }
  for (const c of companies) {
    const d = normaliseDomain(c.domain);
    if (d && !index.domains.has(d)) index.domains.set(d, c.id);
  }
  return index;
}

function jsonPeople(v: string | null): Person[] {
  try {
    const parsed = JSON.parse(v ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is Person => !!p && typeof p.email === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Links unmatched meetings the CRM can now place: a contact or a company domain
 * added since (by a person, the Gmail sync, or linking one of them by hand).
 */
export async function relinkUnmatched(): Promise<number> {
  // A deleted company leaves its meetings linked to nothing: they wait to be linked again.
  await run("UPDATE meetings SET link_status = 'unmatched', updated_at = datetime('now') WHERE company_id IS NULL AND link_status IN ('auto', 'manual')");
  const rows = await query<{ id: string; attendees: string }>("SELECT id, attendees FROM meetings WHERE link_status = 'unmatched'");
  if (!rows.length) return 0;
  const index = await companyIndex();
  let linked = 0;
  for (const r of rows) {
    const company = matchCompany(jsonPeople(r.attendees), index, isPersonal);
    if (!company) continue;
    await run("UPDATE meetings SET company_id = ?, link_status = 'auto', updated_at = datetime('now') WHERE id = ? AND link_status = 'unmatched'", [company, r.id]);
    linked++;
  }
  return linked;
}

/** Every linked meeting with a note and no digest yet waits for one. */
async function queueDigests(): Promise<void> {
  await run(
    `UPDATE meetings SET digest_status = 'queued', digest_error = NULL, updated_at = datetime('now')
      WHERE digest_status = 'none' AND note_id IS NOT NULL AND company_id IS NOT NULL AND link_status IN ('auto', 'manual')`,
  );
}

// ── Calendar ───────────────────────────────────────────────────────

interface EventsPage {
  items?: GoogleEvent[];
  nextPageToken?: string;
  /** For the primary calendar, the owner's address. */
  summary?: string;
}

async function storeEvent(e: GoogleEvent, own: Own, index: CompanyIndex): Promise<void> {
  const m = eventMeeting(e, own);
  if (!m) return;
  if (m.internal) {
    await run(
      `INSERT INTO meetings (id, calendar_event_id, title, starts_at, ends_at, attendees, link_status) VALUES (?, ?, '', ?, ?, '[]', 'internal')
       ON CONFLICT (calendar_event_id) DO UPDATE SET title = '', starts_at = excluded.starts_at, ends_at = excluded.ends_at, attendees = '[]',
         calendar_url = NULL, company_id = NULL, link_status = 'internal', updated_at = datetime('now')`,
      [crypto.randomUUID(), m.id, m.starts_at, m.ends_at],
    );
    return;
  }
  const company = matchCompany(m.attendees, index, isPersonal);
  // A person's link (or "not a customer meeting") outlives every later read.
  await run(
    `INSERT INTO meetings (id, calendar_event_id, title, starts_at, ends_at, attendees, calendar_url, company_id, link_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (calendar_event_id) DO UPDATE SET title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
       attendees = excluded.attendees, calendar_url = excluded.calendar_url,
       company_id = CASE WHEN meetings.link_status IN ('manual', 'ignored') THEN meetings.company_id ELSE excluded.company_id END,
       link_status = CASE WHEN meetings.link_status IN ('manual', 'ignored') THEN meetings.link_status ELSE excluded.link_status END,
       updated_at = datetime('now')`,
    [crypto.randomUUID(), m.id, m.title, m.starts_at, m.ends_at, JSON.stringify(m.attendees), m.url, company, company ? "auto" : "unmatched"],
  );
}

/**
 * Meetings in a window the calendar no longer has: cancelled or moved out.
 * Only after the whole window came in one page, so every event in it was seen.
 * A meeting with a note keeps its row: the call happened.
 */
async function pruneWindow(from: string, to: string, seen: Set<string>): Promise<void> {
  const stored = await query<{ id: string; calendar_event_id: string }>(
    "SELECT id, calendar_event_id FROM meetings WHERE calendar_event_id IS NOT NULL AND note_id IS NULL AND starts_at >= ? AND starts_at <= ?",
    [from, to],
  );
  const gone = stored.filter((m) => !seen.has(m.calendar_event_id)).map((m) => m.id);
  for (let i = 0; i < gone.length; i += 90) {
    const part = gone.slice(i, i + 90);
    await run(`DELETE FROM meetings WHERE id IN (${part.map(() => "?").join(", ")})`, part);
  }
}

async function calendarPage(cal: GoogleConnection, c: Cursor): Promise<EventsPage> {
  return ((await cal.run("EVENTS_LIST", {
    calendarId: "primary",
    timeMin: c.from,
    timeMax: c.to,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: EVENTS_PAGE,
    ...(c.page ? { pageToken: c.page } : {}),
  })) ?? {}) as EventsPage;
}

// ── Granola ────────────────────────────────────────────────────────

interface NotesPage {
  notes?: Array<{ id: string; updated_at?: string }>;
  hasMore?: boolean;
  cursor?: string | null;
}

async function readNote(g: GenericClient, id: string): Promise<GranolaNote> {
  return (await g.get(`/v1/notes/${encodeURIComponent(id)}`, { query: { include: "transcript" } })) as GranolaNote;
}

/**
 * Puts a note on the meeting it was taken in. A note whose meeting isn't on the
 * calendar (a phone call, an ad hoc chat) becomes a meeting of its own, linked
 * by the people it names, or left for someone to link.
 */
async function storeNote(g: GenericClient, summary: { id: string; updated_at?: string }, own: Own, index: CompanyIndex): Promise<void> {
  const known = await get<{ id: string; note_updated_at: string | null }>("SELECT id, note_updated_at FROM meetings WHERE note_id = ?", [summary.id]);
  if (known && known.note_updated_at === (summary.updated_at ?? null)) return;
  const note = await readNote(g, summary.id);
  const w = noteWindow(note);
  if (!w) return;
  const title = (note.title ?? note.calendar_event?.event_title ?? "").trim();
  const updated = note.updated_at ?? summary.updated_at ?? null;

  let meetingId = known?.id ?? null;
  if (!meetingId) {
    const slots = await query<Slot>(
      `SELECT id, calendar_event_id, starts_at, ends_at FROM meetings
        WHERE note_id IS NULL AND (calendar_event_id = ? OR (starts_at >= ? AND starts_at <= ?))`,
      [note.calendar_event?.calendar_event_id ?? "", iso(Date.parse(w.start) - 6 * 3_600_000), iso(Date.parse(w.end) + 3_600_000)],
    );
    meetingId = placeNote(note, w, slots);
  }
  if (meetingId) {
    await run(
      `UPDATE meetings SET note_id = ?, note_url = ?, note_updated_at = ?,
         title = CASE WHEN title = '' AND link_status != 'internal' THEN ? ELSE title END, updated_at = datetime('now')
       WHERE id = ?`,
      [note.id, note.web_url ?? null, updated, title, meetingId],
    );
    return;
  }
  const people = notePeople(note, own);
  const company = matchCompany(people, index, isPersonal);
  await run(
    `INSERT INTO meetings (id, note_id, title, starts_at, ends_at, attendees, note_url, note_updated_at, company_id, link_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), note.id, title, w.start, w.end, JSON.stringify(people), note.web_url ?? null, updated, company, company ? "auto" : "unmatched"],
  );
}

// ── The sync pass ──────────────────────────────────────────────────

function later(a: string | undefined | null, b: string | undefined | null): string | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** Reads on from `c` until the pass ends or the budget runs out. Returns whether it ended. */
async function syncPass(env: ConnectionsEnv, s: MeetingSync, c: Cursor, now: Date, deadline: number): Promise<{ finished: boolean; stored: number; notes: number }> {
  const index = await companyIndex();
  let stored = 0;
  let notes = 0;

  if (c.step === "calendar") {
    const cal = await calendarConnection(env);
    if (!cal) throw new Error("Google Calendar is not connected. Connect it in Clawnify to keep syncing.");
    while (Date.now() < deadline) {
      const firstPage = !c.page;
      const page = await calendarPage(cal, c);
      const items = page.items ?? [];
      // The primary calendar is named after its owner; the owner also shows as `self` on each event.
      const selves = items.flatMap((e) => (e.attendees ?? []).filter((a) => a.self && a.email).map((a) => a.email!.toLowerCase()));
      const owner = page.summary?.includes("@") ? page.summary.trim().toLowerCase() : selves[0] ?? s.calendar_owner;
      if (owner && owner !== s.calendar_owner) {
        s.calendar_owner = owner;
        await run("UPDATE meeting_sync SET calendar_owner = ? WHERE id = 1", [owner]);
      }
      const own = ownSide([owner ?? "", ...selves], isPersonal);
      for (const e of items) await storeEvent(e, own, index);
      stored += items.length;
      if (firstPage && !page.nextPageToken) await pruneWindow(c.from, c.to, new Set(items.map((e) => e.id).filter((id): id is string => !!id)));
      if (page.nextPageToken) {
        c.page = page.nextPageToken;
        continue;
      }
      c.step = "notes";
      c.page = null;
      c.notes_since = s.notes_synced_until ? iso(Date.parse(s.notes_synced_until) - NOTES_OVERLAP_MS) : c.from;
      c.notes_page = null;
      break;
    }
    if (c.step === "calendar") return { finished: false, stored, notes };
  }

  const g = await notesConnection(env);
  if (!g) return { finished: true, stored, notes }; // no Granola: the calendar alone
  const own = ownSide([s.calendar_owner ?? ""], isPersonal);
  while (Date.now() < deadline) {
    const page = (await g.get("/v1/notes", {
      query: { updated_after: c.notes_since, page_size: NOTES_PAGE, cursor: c.notes_page ?? undefined },
    })) as NotesPage;
    for (const n of page.notes ?? []) {
      // Out of time mid-page: the next run lists this page again, and skips the notes already stored.
      if (Date.now() > deadline) return { finished: false, stored, notes };
      await storeNote(g, n, own, index);
      notes++;
      c.max_seen = later(c.max_seen, n.updated_at);
    }
    if (page.hasMore && page.cursor) {
      c.notes_page = page.cursor;
      continue;
    }
    return { finished: true, stored, notes };
  }
  return { finished: false, stored, notes };
}

// ── The digest ─────────────────────────────────────────────────────

function digestPrompt(about: string, company: string, day: string): string {
  const date = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return [
    "You read the transcript of a call and note what matters for the account, for a CRM.",
    `"Us" is the team that keeps this CRM${about.trim() ? `, who sell: ${about.trim()}` : ""}. "Them" is ${company}.`,
    `The call was on ${date}.`,
    "Reply with JSON only, in this shape:",
    '{"summary": string, "sentiment": -2 to 2, "sentiment_reason": string, "tasks": [{"title": string, "owed_by": "us" or "them", "due_date": "YYYY-MM-DD" or null, "quote": string}], "insights": [{"kind": "idea" or "expansion" or "risk", "text": string, "quote": string}]}',
    "summary: two or three plain sentences: what the call was about and where things stand.",
    "sentiment: how the call went for the relationship: -2 badly (complaints, doubts about going on), 0 neutral, 2 very well (enthusiasm, commitment). sentiment_reason: one short sentence saying why.",
    'tasks: what someone committed to do in the call. owed_by is "us" when we promised it, "them" when they did. Give due_date only when a day or date was said, resolved against the call date ("Friday" is the first Friday after the call); otherwise null.',
    'insights, one sentence each: "idea" is a use case or improvement worth proposing to them (a task they find painful, something they wish they had); "expansion" is room to grow the account (another team, more people, another product, budget); "risk" is anything that threatens the relationship (a complaint, a competitor, budget cuts, their champion leaving).',
    "quote: the few words from the transcript it comes from, as said.",
    "Only include what the call supports; empty lists are fine. Never invent names, numbers or dates. Write in English and keep quotes as said.",
  ].join("\n");
}

function digestInput(m: MeetingRow, note: GranolaNote): string {
  const people = jsonPeople(m.attendees).map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join(", ");
  const notes = (note.summary_markdown ?? note.summary_text ?? "").trim().slice(0, 4000);
  return [
    `Call: ${m.title || note.title || "Untitled"}`,
    people ? `With: ${people}` : "",
    notes ? `Notes Granola took during the call:\n${notes}` : "",
    note.transcript?.length && !speakersKnown(note.transcript)
      ? "The transcript doesn't say who spoke (the call was held in person or on a speakerphone): tell us and them apart from what is said."
      : "",
    `Transcript:\n${transcriptText(note.transcript, TRANSCRIPT_CHARS) || "(none)"}`,
  ].filter(Boolean).join("\n\n");
}

/** Digests the newest queued call. `ran` is false when none was waiting. */
async function digestNext(env: ConnectionsEnv & AiEnv, s: MeetingSync, now: Date): Promise<{ ran: boolean; outOfCredits?: boolean; error?: string }> {
  await run(`UPDATE meetings SET digest_status = 'queued' WHERE digest_status = 'running' AND updated_at < datetime('now', ?)`, [`-${STALE_DIGEST_SECONDS} seconds`]);
  const [m] = await query<MeetingRow>(
    `UPDATE meetings SET digest_status = 'running', updated_at = datetime('now')
      WHERE id = (SELECT id FROM meetings WHERE digest_status = 'queued' ORDER BY starts_at DESC LIMIT 1)
      RETURNING *`,
  );
  if (!m) return { ran: false };
  try {
    const company = m.company_id ? await get<{ name: string }>("SELECT name FROM companies WHERE id = ?", [m.company_id]) : null;
    if (!m.note_id || !company) {
      await run("UPDATE meetings SET digest_status = 'none', updated_at = datetime('now') WHERE id = ?", [m.id]);
      return { ran: true };
    }
    const g = await notesConnection(env);
    if (!g) throw new Error("Granola is not connected");
    const note = await readNote(g, m.note_id);
    const raw = await complete(env, digestPrompt(s.about, company.name, m.starts_at.slice(0, 10)), digestInput(m, note), { maxTokens: 1500, timeoutMs: DIGEST_TIMEOUT_MS });
    const d = coerceDigest(raw, m.starts_at.slice(0, 10));
    const fresh = now.getTime() - Date.parse(m.starts_at) <= FRESH_DAYS * DAY_MS;
    // What a run that died midway wrote goes first, so a retry never doubles it.
    await run("DELETE FROM tasks WHERE meeting_id = ? AND created_by = 'ai'", [m.id]);
    await run("DELETE FROM insights WHERE meeting_id = ?", [m.id]);
    for (const t of fresh ? d.tasks : []) {
      await run(
        "INSERT INTO tasks (id, title, company_id, meeting_id, owed_by, due_date, quote, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai')",
        [crypto.randomUUID(), t.title, m.company_id, m.id, t.owed_by, t.due_date, t.quote],
      );
    }
    for (const i of d.insights.filter((x) => fresh || x.kind !== "risk")) {
      await run("INSERT INTO insights (id, company_id, meeting_id, kind, text, quote) VALUES (?, ?, ?, ?, ?, ?)", [crypto.randomUUID(), m.company_id, m.id, i.kind, i.text, i.quote]);
    }
    await run(
      `UPDATE meetings SET summary = ?, sentiment = ?, sentiment_reason = ?, digest_status = 'done', digest_error = NULL,
         digested_at = ?, updated_at = datetime('now') WHERE id = ?`,
      [d.summary, d.sentiment, d.sentiment_reason, now.toISOString(), m.id],
    );
    return { ran: true };
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    await run("UPDATE meetings SET digest_status = 'error', digest_error = ?, updated_at = datetime('now') WHERE id = ?", [message, m.id]);
    if (e instanceof ModelError && e.outOfCredits) {
      // Nothing waiting can succeed until the org adds credits.
      await run("UPDATE meetings SET digest_status = 'error', digest_error = 'Out of Clawnify credits', updated_at = datetime('now') WHERE digest_status = 'queued'");
      return { ran: true, outOfCredits: true, error: message };
    }
    return { ran: true, error: message };
  }
}

// ── Running ────────────────────────────────────────────────────────

/** Takes the sync for one run, or false when another run holds it. */
async function claim(now: Date): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `UPDATE meeting_sync SET running_until = ?
      WHERE id = 1 AND enabled = 1 AND (running_until IS NULL OR running_until < ?)
      RETURNING id`,
    [iso(now.getTime() + LEASE_MS), now.toISOString()],
  );
  return rows.length === 1;
}

function parseCursor(v: string | null): Cursor | null {
  try {
    const c = JSON.parse(v ?? "null");
    return c && typeof c === "object" && (c.step === "calendar" || c.step === "notes") ? (c as Cursor) : null;
  } catch {
    return null;
  }
}

async function queuedCount(): Promise<number> {
  return (await get<{ n: number }>("SELECT COUNT(*) AS n FROM meetings WHERE digest_status IN ('queued', 'running')"))?.n ?? 0;
}

export interface RunResult {
  status: "ran" | "busy" | "off" | "idle" | "error";
  job?: "sync" | "digest";
  phase?: MeetingSync["phase"];
  /** Work is left that should run again right away. */
  more?: boolean;
  stored?: number;
  notes?: number;
  error?: string;
}

/**
 * One bounded run: continue (or start) a sync pass when one is due, otherwise
 * digest one queued call. `sync` starts a pass even when none is due ("Sync now").
 */
export async function runMeetings(env: ConnectionsEnv & AiEnv, now = new Date(), opts: { sync?: boolean } = {}): Promise<RunResult> {
  const s = await syncSettings();
  if (!s?.enabled) return { status: "off" };
  if (!(await claim(now))) return { status: "busy" };

  const started = Date.now();
  let phase: MeetingSync["phase"] = s.phase === "idle" ? "importing" : s.phase;
  let cursor = parseCursor(s.cursor);
  try {
    const due = !s.calendar_synced_at || now.getTime() - Date.parse(s.calendar_synced_at) >= LIVE_INTERVAL_MS - 60_000;
    if (!cursor && (phase === "importing" || due || opts.sync)) {
      const back = phase === "importing" ? s.history_days * DAY_MS : LIVE_BACK_MS;
      cursor = { step: "calendar", from: iso(now.getTime() - back), to: iso(now.getTime() + AHEAD_MS), page: null };
    }

    if (cursor) {
      const pass = await syncPass(env, s, cursor, now, started + RUN_BUDGET_MS);
      await relinkUnmatched();
      await queueDigests();
      if (pass.finished) {
        const until = later(s.notes_synced_until, cursor.max_seen);
        phase = "live";
        await run(
          `UPDATE meeting_sync SET phase = 'live', cursor = NULL, calendar_synced_at = ?, notes_synced_until = ?,
             last_run_at = ?, last_error = NULL, running_until = NULL WHERE id = 1`,
          [now.toISOString(), until && until > now.toISOString() ? now.toISOString() : until ?? null, now.toISOString()],
        );
      } else {
        await run(
          "UPDATE meeting_sync SET phase = ?, cursor = ?, last_run_at = ?, last_error = NULL, running_until = NULL WHERE id = 1",
          [phase, JSON.stringify(cursor), now.toISOString()],
        );
      }
      return { status: "ran", job: "sync", phase, stored: pass.stored, notes: pass.notes, more: !pass.finished || (await queuedCount()) > 0 };
    }

    const d = await digestNext(env, s, now);
    await run("UPDATE meeting_sync SET last_run_at = ?, running_until = NULL WHERE id = 1", [now.toISOString()]);
    if (!d.ran) return { status: "idle", phase };
    return { status: "ran", job: "digest", phase, error: d.error, more: !d.outOfCredits && (await queuedCount()) > 0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sync failed";
    await run(
      "UPDATE meeting_sync SET phase = ?, cursor = ?, last_run_at = ?, last_error = ?, running_until = NULL WHERE id = 1",
      [phase, cursor ? JSON.stringify(cursor) : null, now.toISOString(), message, ],
    );
    return { status: "error", phase, error: message };
  }
}

// ── Scheduling ─────────────────────────────────────────────────────

type QueueEnv = { CLAWNIFY_TOKEN?: string; CLAWNIFY_QUEUE_URL?: string };

/**
 * Books the next run on the platform queue, keyed by the app's host and the
 * target minute so two requests noticing the same gap book one job. Without a
 * queue (local dev, an outage) the next page view or "Sync now" books again.
 */
export async function scheduleRun(env: QueueEnv, origin: string, runAt: Date): Promise<void> {
  try {
    const { enqueueJob } = await import("@clawnify/queue");
    const job = await enqueueJob(env, {
      targetUrl: `${origin}/api/meetings/run`,
      payload: {},
      runAt,
      idempotencyKey: `crm-meetings-${new URL(origin).host}-${runAt.toISOString().slice(0, 16)}`,
      maxAttempts: 3,
    });
    await run("UPDATE meeting_sync SET job_id = ?, next_run_at = ? WHERE id = 1", [job.id, runAt.toISOString()]);
  } catch {
    /* no queue: ensureScheduled books it later */
  }
}

/** Books a run when sync is on and none is coming, or the booked one is long overdue. */
export async function ensureScheduled(env: QueueEnv, origin: string, s: MeetingSync, now = new Date()): Promise<void> {
  if (!s.enabled) return;
  const overdue = !s.next_run_at || Date.parse(s.next_run_at) < now.getTime() - 5 * 60_000;
  if (overdue) await scheduleRun(env, origin, now);
}

export async function cancelScheduled(env: QueueEnv, s: MeetingSync): Promise<void> {
  if (!s.job_id) return;
  try {
    const { cancelJob } = await import("@clawnify/queue");
    await cancelJob(env, s.job_id);
  } catch {
    /* already delivered or gone */
  }
  await run("UPDATE meeting_sync SET job_id = NULL, next_run_at = NULL WHERE id = 1");
}

// ── Reading and changing meetings ──────────────────────────────────

export interface MeetingView {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  attendees: Person[];
  company_id: string | null;
  company_name: string | null;
  company_domain: string | null;
  link_status: Exclude<LinkStatus, "internal">;
  calendar_url: string | null;
  note_url: string | null;
  has_note: boolean;
  summary: string | null;
  sentiment: number | null;
  sentiment_reason: string | null;
  digest_status: DigestStatus;
  digest_error: string | null;
}

const VIEW_COLUMNS = `m.id, m.title, m.starts_at, m.ends_at, m.attendees, m.company_id, c.name AS company_name, c.domain AS company_domain,
  m.link_status, m.calendar_url, m.note_url, m.note_id, m.summary, m.sentiment, m.sentiment_reason, m.digest_status, m.digest_error`;

type ViewRow = Omit<MeetingView, "attendees" | "has_note"> & { attendees: string; note_id: string | null };

function toView(r: ViewRow): MeetingView {
  const { note_id, ...rest } = r;
  return { ...rest, attendees: jsonPeople(r.attendees), has_note: !!note_id };
}

/**
 * Meetings, newest first, never the internal ones. `company_id` narrows to one
 * company; `link` to a link status (unmatched lists those waiting for a person);
 * `when` to the ones still to come (soonest first) or already held.
 */
export async function listMeetings(opts: { company_id?: string; link?: "unmatched" | "ignored"; when?: "upcoming" | "past"; limit?: number; offset?: number }, now = new Date()): Promise<{ meetings: MeetingView[]; total: number }> {
  const where = ["m.link_status != 'internal'"];
  const params: unknown[] = [];
  if (opts.company_id) { where.push("m.company_id = ?"); params.push(opts.company_id); }
  if (opts.link) { where.push("m.link_status = ?"); params.push(opts.link); }
  if (opts.when === "upcoming") { where.push("m.starts_at > ?"); params.push(now.toISOString()); }
  if (opts.when === "past") { where.push("m.starts_at <= ?"); params.push(now.toISOString()); }
  const order = opts.when === "upcoming" ? "m.starts_at ASC" : "m.starts_at DESC";
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const rows = await query<ViewRow>(
    `SELECT ${VIEW_COLUMNS} FROM meetings m LEFT JOIN companies c ON c.id = m.company_id
      WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, limit, Math.max(opts.offset ?? 0, 0)],
  );
  const total = (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM meetings m WHERE ${where.join(" AND ")}`, params))?.n ?? 0;
  return { meetings: rows.map(toView), total };
}

export async function getMeeting(id: string): Promise<MeetingView | null> {
  const r = await get<ViewRow>(`SELECT ${VIEW_COLUMNS} FROM meetings m LEFT JOIN companies c ON c.id = m.company_id WHERE m.id = ? AND m.link_status != 'internal'`, [id]);
  return r ? toView(r) : null;
}

/**
 * A person links a meeting to a company, unlinks it, or marks it as not an
 * account meeting. A company with no domain takes the domain of the people met,
 * so their later meetings link themselves; other unlinked meetings the CRM can
 * now place go with it.
 */
export async function linkMeeting(id: string, to: { company_id: string | null } | { ignored: true }): Promise<MeetingView | null> {
  const m = await get<MeetingRow>("SELECT * FROM meetings WHERE id = ? AND link_status != 'internal'", [id]);
  if (!m) return null;
  if ("ignored" in to) {
    await run("UPDATE meetings SET company_id = NULL, link_status = 'ignored', updated_at = datetime('now') WHERE id = ?", [id]);
  } else if (to.company_id) {
    await run("UPDATE meetings SET company_id = ?, link_status = 'manual', updated_at = datetime('now') WHERE id = ?", [to.company_id, id]);
    const domains = [...new Set(jsonPeople(m.attendees).map((p) => emailDomain(p.email)).filter((d) => d && !isPersonal(d)))];
    if (domains.length === 1) {
      await run("UPDATE companies SET domain = ?, updated_at = datetime('now') WHERE id = ? AND (domain IS NULL OR TRIM(domain) = '')", [domains[0], to.company_id]);
    }
    await relinkUnmatched();
  } else {
    await run("UPDATE meetings SET company_id = NULL, link_status = 'unmatched', updated_at = datetime('now') WHERE id = ?", [id]);
  }
  await queueDigests();
  return getMeeting(id);
}

/** Reads a call again after its digest failed. */
export async function retryDigest(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE meetings SET digest_status = 'queued', digest_error = NULL, updated_at = datetime('now')
      WHERE id = ? AND digest_status IN ('error', 'none') AND note_id IS NOT NULL AND company_id IS NOT NULL RETURNING id`,
    [id],
  );
  return rows.length === 1;
}

export async function counts(): Promise<{ meetings: number; linked: number; unmatched: number; with_notes: number; digested: number; waiting: number; failed: number }> {
  const r = await get<Record<string, number>>(
    `SELECT COUNT(*) AS meetings,
            SUM(CASE WHEN link_status IN ('auto', 'manual') THEN 1 ELSE 0 END) AS linked,
            SUM(CASE WHEN link_status = 'unmatched' THEN 1 ELSE 0 END) AS unmatched,
            SUM(CASE WHEN note_id IS NOT NULL THEN 1 ELSE 0 END) AS with_notes,
            SUM(CASE WHEN digest_status = 'done' THEN 1 ELSE 0 END) AS digested,
            SUM(CASE WHEN digest_status IN ('queued', 'running') THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN digest_status = 'error' THEN 1 ELSE 0 END) AS failed
       FROM meetings WHERE link_status != 'internal'`,
  );
  const n = (k: string) => Number(r?.[k] ?? 0);
  return { meetings: n("meetings"), linked: n("linked"), unmatched: n("unmatched"), with_notes: n("with_notes"), digested: n("digested"), waiting: n("waiting"), failed: n("failed") };
}
