// Meetings: the rules. Which people at a meeting count, which company a meeting
// is with, where a Granola note sits on the calendar, what the AI may write from
// a call, and how an account is doing. Pure (no I/O, no clock of its own), so
// each rule can be checked on its own; meetings.ts and customers.ts are the I/O
// around them.

export interface Person {
  email: string;
  name: string | null;
}

/** A stored company domain as a bare host: "https://www.acme.com/x" becomes "acme.com". */
export function normaliseDomain(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/** Who "we" are: the calendar owner's addresses and, for a work address, its domain. */
export interface Own {
  emails: Set<string>;
  domains: Set<string>;
}

export function ownSide(addresses: string[], isPersonalDomain: (d: string) => boolean): Own {
  const emails = new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.includes("@")));
  const domains = new Set([...emails].map(emailDomain).filter((d) => d && !isPersonalDomain(d)));
  return { emails, domains };
}

// ── Calendar ───────────────────────────────────────────────────────

export interface CalendarAttendee {
  email?: string;
  displayName?: string;
  self?: boolean;
  resource?: boolean;
  responseStatus?: string;
}

export interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: CalendarAttendee[];
}

/** The people from outside: not us, not someone at our own domain, not a room. */
export function outsiders(attendees: CalendarAttendee[] | undefined, own: Own): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const a of attendees ?? []) {
    const email = (a.email ?? "").trim().toLowerCase();
    if (!email.includes("@") || a.self || a.resource || emailDomain(email).endsWith("calendar.google.com")) continue;
    if (own.emails.has(email) || own.domains.has(emailDomain(email)) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: a.displayName?.trim() || null });
  }
  return out;
}

function toUtc(v: string | undefined | null): string | null {
  const t = Date.parse(v ?? "");
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface EventMeeting {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  attendees: Person[];
  url: string | null;
  /** No one from outside: kept only as a time slot, so a note taken in it is known to be internal. */
  internal: boolean;
}

/**
 * A calendar event as a meeting, or null when it isn't one at all: cancelled,
 * all day, declined, or a focus/out-of-office block. A meeting with no one from
 * outside is internal: kept as a bare time slot, never shown.
 */
export function eventMeeting(e: GoogleEvent, own: Own): EventMeeting | null {
  if (!e.id || e.status === "cancelled" || !e.start?.dateTime) return null;
  if (e.eventType && e.eventType !== "default") return null;
  if ((e.attendees ?? []).some((a) => a.self && a.responseStatus === "declined")) return null;
  const starts = toUtc(e.start.dateTime);
  if (!starts) return null;
  const people = outsiders(e.attendees, own);
  const internal = people.length === 0;
  return {
    id: e.id,
    title: internal ? "" : (e.summary ?? "").trim(),
    starts_at: starts,
    ends_at: toUtc(e.end?.dateTime),
    attendees: people,
    url: internal ? null : e.htmlLink ?? null,
    internal,
  };
}

// ── Which company ──────────────────────────────────────────────────

/** What the CRM knows that ties an address to a company. */
export interface CompanyIndex {
  /** A contact's address: their company. */
  contacts: Map<string, string>;
  /** The work domain of contacts' addresses: the company most of them belong to. */
  contactDomains: Map<string, string>;
  /** A company's own domain, normalised: the company. */
  domains: Map<string, string>;
}

/**
 * The company a meeting is with: the one most of its outside people point to.
 * A person counts by their exact address first; otherwise by their work domain,
 * through the contacts already at a company and then the company's own domain.
 * A personal address (gmail, outlook…) counts only when it is a known contact.
 * Ties go to the company of the first person invited.
 */
export function matchCompany(people: Person[], index: CompanyIndex, isPersonalDomain: (d: string) => boolean): string | null {
  const score = new Map<string, number>();
  const add = (id: string | undefined, n: number) => {
    if (id) score.set(id, (score.get(id) ?? 0) + n);
  };
  for (const p of people) {
    const exact = index.contacts.get(p.email);
    if (exact) {
      add(exact, 3);
      continue;
    }
    const d = emailDomain(p.email);
    if (!d || isPersonalDomain(d)) continue;
    add(index.contactDomains.get(d) ?? index.domains.get(d), 2);
  }
  let best: string | null = null;
  let top = 0;
  for (const [id, n] of score) {
    if (n > top) {
      best = id;
      top = n;
    }
  }
  return best;
}

// ── Granola notes ──────────────────────────────────────────────────

export interface TranscriptItem {
  text?: string;
  start_time?: string;
  end_time?: string;
  speaker?: { source?: string; attribution?: string; name?: string };
}

export interface GranolaNote {
  id: string;
  title?: string | null;
  web_url?: string | null;
  created_at?: string;
  updated_at?: string;
  owner?: { name?: string | null; email?: string | null } | null;
  attendees?: Array<{ name?: string | null; email?: string | null }> | null;
  calendar_event?: {
    calendar_event_id?: string | null;
    event_title?: string | null;
    scheduled_start_time?: string | null;
    scheduled_end_time?: string | null;
    invitees?: Array<{ email?: string | null; name?: string | null }> | null;
  } | null;
  transcript?: TranscriptItem[] | null;
  summary_markdown?: string | null;
  summary_text?: string | null;
}

/** When the call took place: what was said, else what was scheduled, else when the note was made. */
export function noteWindow(n: GranolaNote): { start: string; end: string } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const t of n.transcript ?? []) {
    const s = Date.parse(t.start_time ?? "");
    const e = Date.parse(t.end_time ?? "");
    if (!Number.isNaN(s)) start = Math.min(start, s);
    if (!Number.isNaN(e)) end = Math.max(end, e);
  }
  if (Number.isFinite(start)) return { start: new Date(start).toISOString(), end: new Date(Math.max(end, start)).toISOString() };
  const scheduled = toUtc(n.calendar_event?.scheduled_start_time);
  if (scheduled) return { start: scheduled, end: toUtc(n.calendar_event?.scheduled_end_time) ?? scheduled };
  const made = toUtc(n.created_at);
  return made ? { start: made, end: made } : null;
}

/** How far a call may sit outside its calendar slot and still be that meeting. */
export const PLACE_SLACK_MS = 30 * 60_000;

export interface Slot {
  id: string;
  calendar_event_id: string | null;
  starts_at: string;
  ends_at: string | null;
}

/**
 * The meeting a note was taken in: the calendar event the note names, else the
 * meeting whose slot overlaps the call the most, else the nearest one starting
 * or ending within PLACE_SLACK_MS. Null when the call matches no meeting.
 */
export function placeNote(n: GranolaNote, w: { start: string; end: string }, slots: Slot[]): string | null {
  const named = n.calendar_event?.calendar_event_id;
  if (named) {
    const hit = slots.find((s) => s.calendar_event_id === named);
    if (hit) return hit.id;
  }
  const ws = Date.parse(w.start);
  const we = Math.max(Date.parse(w.end), ws + 60_000);
  let best: string | null = null;
  let bestOverlap = 0;
  let near: string | null = null;
  let nearGap = PLACE_SLACK_MS;
  for (const s of slots) {
    const ss = Date.parse(s.starts_at);
    const se = s.ends_at ? Math.max(Date.parse(s.ends_at), ss) : ss + 30 * 60_000;
    const overlap = Math.min(we, se) - Math.max(ws, ss);
    if (overlap > bestOverlap) {
      best = s.id;
      bestOverlap = overlap;
    } else if (overlap <= 0 && -overlap <= nearGap) {
      near = s.id;
      nearGap = -overlap;
    }
  }
  return best ?? near;
}

/** The outside people a note names (attendees, then calendar invitees), for a call with no calendar meeting. */
export function notePeople(n: GranolaNote, own: Own): Person[] {
  const raw = [...(n.attendees ?? []), ...(n.calendar_event?.invitees ?? [])]
    .map((p) => ({ email: p.email ?? undefined, displayName: p.name ?? undefined }));
  const ownerEmail = (n.owner?.email ?? "").trim().toLowerCase();
  return outsiders(raw, ownerEmail ? { emails: new Set([...own.emails, ownerEmail]), domains: own.domains } : own);
}

/**
 * Whether Granola told the two sides apart. A call held in person or on a
 * speakerphone is heard entirely through the owner's microphone, so every line
 * would otherwise read as ours.
 */
export function speakersKnown(items: TranscriptItem[] | null | undefined): boolean {
  const said = (items ?? []).filter((t) => (t.text ?? "").trim());
  const sides = new Set(said.map((t) => t.speaker?.attribution ?? t.speaker?.source ?? ""));
  return sides.size > 1 || said.some((t) => !!t.speaker?.name);
}

/**
 * The call as lines a model can read. Granola marks who spoke: the note's owner
 * ("Us") or the other side ("Them", with a name when it heard one); lines in a
 * row by the same speaker are joined. When it couldn't tell (speakersKnown),
 * the lines go unlabelled rather than all as ours. Past `maxChars` the middle
 * goes, keeping the opening and, longer, the end, where next steps are agreed.
 */
export function transcriptText(items: TranscriptItem[] | null | undefined, maxChars: number): string {
  const lines: string[] = [];
  const known = speakersKnown(items);
  let last = "";
  for (const t of items ?? []) {
    const text = (t.text ?? "").trim();
    if (!text) continue;
    if (!known) {
      lines.push(text);
      continue;
    }
    const us = t.speaker?.attribution ? t.speaker.attribution === "me" : t.speaker?.source === "microphone";
    const who = us ? "Us" : t.speaker?.name ? `Them (${t.speaker.name})` : "Them";
    if (who === last) lines[lines.length - 1] += ` ${text}`;
    else lines.push(`${who}: ${text}`);
    last = who;
  }
  const all = lines.join("\n");
  if (all.length <= maxChars) return all;
  const head = Math.floor(maxChars / 3);
  return `${all.slice(0, head)}\n[…]\n${all.slice(all.length - (maxChars - head))}`;
}

// ── What a call produced ───────────────────────────────────────────

export type OwedBy = "us" | "them";
export type InsightKind = "idea" | "expansion" | "risk";
export const INSIGHT_KINDS: InsightKind[] = ["idea", "expansion", "risk"];

export interface DigestTask {
  title: string;
  owed_by: OwedBy;
  due_date: string | null;
  quote: string | null;
}

export interface DigestInsight {
  kind: InsightKind;
  text: string;
  quote: string | null;
}

export interface Digest {
  summary: string;
  sentiment: number | null;
  sentiment_reason: string | null;
  tasks: DigestTask[];
  insights: DigestInsight[];
}

const MAX_ITEMS = 12;

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : null;
}

/** A due date the AI gave, kept only when it is a real day close to the call (the day before, up to a year after). */
export function dueDate(v: unknown, meetingDay: string): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  const day = Date.parse(`${meetingDay}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(day) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t >= day - 86_400_000 && t <= day + 366 * 86_400_000 ? s : null;
}

/** The AI's reading of a call, checked and trimmed. Throws when there is no readable answer. */
export function coerceDigest(raw: string, meetingDay: string): Digest {
  let v: Record<string, unknown>;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    v = JSON.parse(m ? m[0] : raw) as Record<string, unknown>;
  } catch {
    throw new Error("The AI's answer wasn't readable");
  }
  const summary = clip(v.summary, 1200);
  if (!summary) throw new Error("The AI's answer had no summary");
  const n = typeof v.sentiment === "number" ? v.sentiment : Number(v.sentiment);
  const sentiment = Number.isFinite(n) && v.sentiment !== null && v.sentiment !== "" ? Math.max(-2, Math.min(2, Math.round(n))) : null;

  const tasks: DigestTask[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(v.tasks) ? v.tasks : []) {
    const r = (t ?? {}) as Record<string, unknown>;
    const title = clip(r.title, 200);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    tasks.push({ title, owed_by: r.owed_by === "them" ? "them" : "us", due_date: dueDate(r.due_date, meetingDay), quote: clip(r.quote, 300) });
    if (tasks.length === MAX_ITEMS) break;
  }

  const insights: DigestInsight[] = [];
  for (const i of Array.isArray(v.insights) ? v.insights : []) {
    const r = (i ?? {}) as Record<string, unknown>;
    const text = clip(r.text, 300);
    if (!text || !INSIGHT_KINDS.includes(r.kind as InsightKind)) continue;
    insights.push({ kind: r.kind as InsightKind, text, quote: clip(r.quote, 300) });
    if (insights.length === MAX_ITEMS) break;
  }

  return { summary, sentiment, sentiment_reason: sentiment === null ? null : clip(v.sentiment_reason, 300), tasks, insights };
}

/**
 * A call older than this when it is first read gives its summary, mood, ideas
 * and expansion, but not tasks or risks: those were settled long ago, and
 * importing them would fill the accounts with stale overdue work.
 */
export const FRESH_DAYS = 14;

// ── How an account is doing ────────────────────────────────────────

export type Health = "red" | "yellow" | "green";

// shortcut: fixed thresholds for every workspace; make them a setting if teams ask for their own.
/** No call or email for this long turns an account yellow, then red. */
export const QUIET_YELLOW_DAYS = 21;
export const QUIET_RED_DAYS = 45;

export interface AccountFacts {
  last_meeting_at: string | null;
  last_email_at: string | null;
  next_meeting_at: string | null;
  /** Our open promises, due before today. */
  ours_overdue: Array<{ title: string; due_date: string }>;
  /** Their open promises, due before today. */
  theirs_overdue: Array<{ title: string; due_date: string }>;
  /** Moods of the last digested calls, newest first. */
  sentiments: Array<{ value: number; reason: string | null }>;
  /** Open risks noted in calls. */
  risks: string[];
}

export interface AccountHealth {
  status: Health;
  reasons: string[];
  last_touch_at: string | null;
  days_quiet: number | null;
}

/** "2026-10-03" as "3 Oct". */
export function shortDay(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Red when one of our promises is overdue, the last call went badly, a risk is
 * open, or there has been no contact for QUIET_RED_DAYS. Yellow when there has
 * been none for QUIET_YELLOW_DAYS, they owe something overdue, the mood dropped
 * since the call before, or nobody has been in touch yet. Green otherwise. Every
 * reason is said, worst first: the status is never a score nobody can explain.
 */
export function health(f: AccountFacts, now: Date): AccountHealth {
  const red: string[] = [];
  const yellow: string[] = [];
  const touch = later(f.last_meeting_at, f.last_email_at);
  const quiet = touch ? Math.max(0, Math.floor((now.getTime() - Date.parse(touch)) / 86_400_000)) : null;

  if (f.ours_overdue.length === 1) red.push(`Overdue: ${f.ours_overdue[0].title} (due ${shortDay(f.ours_overdue[0].due_date)})`);
  else if (f.ours_overdue.length > 1) red.push(`${f.ours_overdue.length} of our promises are overdue`);
  const [mood, before] = f.sentiments;
  if (mood && mood.value <= -1) red.push(mood.reason ? `Last call went badly: ${mood.reason}` : "Last call went badly");
  if (f.risks.length) red.push(`Risk: ${f.risks[0]}${f.risks.length > 1 ? ` (and ${f.risks.length - 1} more)` : ""}`);
  if (quiet !== null && quiet > QUIET_RED_DAYS) red.push(`No contact in ${quiet} days`);

  if (quiet !== null && quiet > QUIET_YELLOW_DAYS && quiet <= QUIET_RED_DAYS) yellow.push(`No contact in ${quiet} days`);
  if (f.theirs_overdue.length) yellow.push(`Waiting on them: ${f.theirs_overdue[0].title}${f.theirs_overdue.length > 1 ? ` (and ${f.theirs_overdue.length - 1} more)` : ""}`);
  if (mood && before && mood.value < before.value && mood.value <= 0 && mood.value > -1) yellow.push("The mood dropped since the call before");
  if (!touch) yellow.push("No calls or emails yet");

  return {
    status: red.length ? "red" : yellow.length ? "yellow" : "green",
    reasons: [...red, ...yellow],
    last_touch_at: touch,
    days_quiet: quiet,
  };
}

export interface FocusAccount {
  id: string;
  name: string;
  status: Health;
  next_meeting_at: string | null;
  days_quiet: number | null;
  ours_overdue: Array<{ id: string; title: string; due_date: string }>;
  ours_due_today: Array<{ id: string; title: string }>;
  risks: string[];
}

export interface FocusItem {
  kind: "overdue" | "reach_out" | "due_today" | "risk";
  company_id: string;
  company_name: string;
  text: string;
  task_id?: string;
}

/**
 * The few things worth doing first across all customers: our overdue promises,
 * oldest first; then red accounts with no call booked; then what we owe today;
 * then open risks. At most `limit`.
 */
export function focus(accounts: FocusAccount[], limit = 3): FocusItem[] {
  const out: FocusItem[] = [];
  const overdue = accounts.flatMap((a) => a.ours_overdue.map((t) => ({ a, t }))).sort((x, y) => x.t.due_date.localeCompare(y.t.due_date));
  for (const { a, t } of overdue) out.push({ kind: "overdue", company_id: a.id, company_name: a.name, text: `${t.title} (was due ${shortDay(t.due_date)})`, task_id: t.id });
  for (const a of accounts.filter((x) => x.status === "red" && !x.next_meeting_at)) {
    out.push({ kind: "reach_out", company_id: a.id, company_name: a.name, text: a.days_quiet !== null ? `Book a call: no contact in ${a.days_quiet} days` : "Book a first call" });
  }
  for (const a of accounts) for (const t of a.ours_due_today) out.push({ kind: "due_today", company_id: a.id, company_name: a.name, text: t.title, task_id: t.id });
  for (const a of accounts) for (const r of a.risks) out.push({ kind: "risk", company_id: a.id, company_name: a.name, text: r });
  return out.slice(0, limit);
}
