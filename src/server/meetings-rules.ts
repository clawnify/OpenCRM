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

/**
 * "unknown": nothing says the account is in trouble, but the CRM can't see
 * whether anyone has been in touch, so it doesn't claim it is on track either.
 */
export type Health = "red" | "yellow" | "green" | "unknown";

// shortcut: fixed thresholds for every workspace; make them a setting if teams ask for their own.
/** No call or email for this long turns an account yellow, then red. */
export const QUIET_YELLOW_DAYS = 21;
export const QUIET_RED_DAYS = 45;
/** A renewal this close, or already past, asks for attention. */
export const RENEWAL_SOON_DAYS = 30;

/**
 * How well the CRM can see one channel of contact with an account. "off": not
 * synced. "importing": the first import hasn't finished. "failing": synced, but
 * the latest run failed, so the newest contact may be missing.
 */
export type SyncState = "seen" | "off" | "importing" | "failing";

/**
 * What the CRM can see of an account's contact with us. Silence is only ever
 * claimed through a channel that would have heard it: a dashboard that can't
 * see a customer's meetings shows the same blank as a customer who went quiet.
 */
export interface Sight {
  calls: SyncState;
  emails: SyncState;
  /** The account's contacts with an email address the sync reads (not blocked). */
  addressed: number;
  /** Some contacts have an address, but every one of them is on the email blocklist. */
  all_blocked: boolean;
  /** First names of the addressed contacts whose email history hasn't been read yet. */
  unread: string[];
}

export interface AccountFacts {
  last_meeting_at: string | null;
  last_email_at: string | null;
  /** The latest call, message, email or meeting someone (or an agent) logged by hand. */
  last_logged_at?: string | null;
  next_meeting_at: string | null;
  /** Our open promises, due before today. */
  ours_overdue: Array<{ title: string; due_date: string }>;
  /** Their open promises, due before today. */
  theirs_overdue: Array<{ title: string; due_date: string }>;
  /** Moods of the last digested calls, newest first. */
  sentiments: Array<{ value: number; reason: string | null }>;
  /** Open risks noted in calls. */
  risks: string[];
  sight: Sight;
  /** The next renewal (YYYY-MM-DD), when someone set one. */
  renewal_date?: string | null;
}

export interface AccountHealth {
  status: Health;
  reasons: string[];
  last_touch_at: string | null;
  days_quiet: number | null;
  /** The reason about silence, when there is one ("No contact in 50 days"): the call to book. */
  silence: string | null;
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
 * What the CRM can't see of an account, in words, and whether each channel can
 * still be judged. A failing channel is judged on what it read before it failed;
 * one that is off, still importing, or has no contact to read is not judged.
 */
export function sightGaps(v: Sight): { calls: boolean; emails: boolean; gaps: string[] } {
  const gaps: string[] = [];
  if (v.calls === "off") gaps.push("calls aren't synced");
  else if (v.calls === "importing") gaps.push("calls are still importing");
  else if (v.calls === "failing") gaps.push("the meeting sync is failing");

  let emails = v.emails === "seen" || v.emails === "failing";
  if (v.emails === "off") gaps.push("email isn't synced");
  else if (v.emails === "importing") gaps.push("email is still importing");
  else {
    if (v.emails === "failing") gaps.push("the email sync is failing");
    if (v.addressed === 0) {
      emails = false;
      gaps.push(v.all_blocked ? "their addresses are on the email blocklist" : "no contact has an email address");
    } else if (v.unread.length) {
      if (v.unread.length >= v.addressed) emails = false;
      gaps.push(v.unread.length <= 2 ? `emails with ${v.unread.join(" and ")} aren't read yet` : `emails with ${v.unread.length} contacts aren't read yet`);
    }
  }
  return { calls: v.calls === "seen" || v.calls === "failing", emails, gaps };
}

/**
 * How long an account has gone without a call or email the CRM saw, and the
 * reason to give when that is longer than `quietDays`. Recent contact the CRM
 * has seen settles it, whatever it can't see. Silence is claimed only through
 * a channel it can see, naming the ones it can't. `judged`: whether contact can
 * be judged at all.
 */
export function contactSilence(
  f: { last_meeting_at: string | null; last_email_at: string | null; last_logged_at?: string | null; sight: Sight },
  now: Date,
  quietDays: number,
): { touch: string | null; quiet: number | null; seen: ReturnType<typeof sightGaps>; judged: boolean; silence: string | null } {
  // A touch logged by hand (a phone call, a message) is contact too: it can
  // settle that there was recent contact, but its absence proves nothing.
  const touch = later(later(f.last_meeting_at, f.last_email_at), f.last_logged_at ?? null);
  const quiet = touch ? Math.max(0, Math.floor((now.getTime() - Date.parse(touch)) / 86_400_000)) : null;
  const seen = sightGaps(f.sight);
  const judged = seen.calls || seen.emails || (quiet !== null && quiet <= quietDays);
  const unseen = seen.gaps.length ? ` (${seen.gaps.join(", ")})` : "";
  let silence: string | null = null;
  if (seen.calls || seen.emails) {
    if (quiet === null) silence = `No ${seen.calls && seen.emails ? "calls or emails" : seen.calls ? "calls" : "emails"} yet${unseen}`;
    else if (quiet > quietDays) silence = `No contact in ${quiet} days${unseen}`;
  }
  return { touch, quiet, seen, judged, silence };
}

/** Days from `today` (YYYY-MM-DD, the viewer's day) to `day`: negative when it has passed. Null when it isn't a day. */
function daysUntil(day: string, today: string): number | null {
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  const from = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(from)) return null;
  return Math.round((t - from) / 86_400_000);
}

/**
 * Red when one of our promises is overdue, the last call went badly, a risk is
 * open, or there has been no contact for QUIET_RED_DAYS. Yellow when there has
 * been none for QUIET_YELLOW_DAYS, they owe something overdue, the mood dropped
 * since the call before, a renewal is due within RENEWAL_SOON_DAYS (or passed),
 * or nobody has been in touch yet. Green otherwise.
 *
 * Silence is judged only through what the CRM can see (`sight`), and the reason
 * names what it can't: "No contact in 39 days (calls aren't synced)". When it
 * can see neither calls nor emails and has seen no recent contact, the last
 * reason says why ("Calls aren't synced, email isn't synced"), and an account
 * with nothing else against it is "unknown" rather than green.
 * Every reason is said, worst first: the status is never a score nobody can
 * explain.
 */
export function health(f: AccountFacts, now: Date, today = now.toISOString().slice(0, 10)): AccountHealth {
  const red: string[] = [];
  const yellow: string[] = [];
  const { touch, quiet, seen, judged, silence } = contactSilence(f, now, QUIET_YELLOW_DAYS);

  if (f.ours_overdue.length === 1) red.push(`Overdue: ${f.ours_overdue[0].title} (due ${shortDay(f.ours_overdue[0].due_date)})`);
  else if (f.ours_overdue.length > 1) red.push(`${f.ours_overdue.length} of our promises are overdue`);
  const [mood, before] = f.sentiments;
  if (mood && mood.value <= -1) red.push(mood.reason ? `Last call went badly: ${mood.reason}` : "Last call went badly");
  if (f.risks.length) red.push(`Risk: ${f.risks[0]}${f.risks.length > 1 ? ` (and ${f.risks.length - 1} more)` : ""}`);
  if (silence && quiet !== null && quiet > QUIET_RED_DAYS) red.push(silence);

  if (silence && (quiet === null || quiet <= QUIET_RED_DAYS)) yellow.push(silence);
  if (f.theirs_overdue.length) yellow.push(`Waiting on them: ${f.theirs_overdue[0].title}${f.theirs_overdue.length > 1 ? ` (and ${f.theirs_overdue.length - 1} more)` : ""}`);
  if (mood && before && mood.value < before.value && mood.value <= 0 && mood.value > -1) yellow.push("The mood dropped since the call before");
  const renews = f.renewal_date ? daysUntil(f.renewal_date, today) : null;
  if (renews !== null && renews < 0) yellow.push(`The renewal date (${shortDay(f.renewal_date!)}) has passed: set the next one`);
  else if (renews !== null && renews <= RENEWAL_SOON_DAYS) yellow.push(renews === 0 ? "Renews today" : `Renews in ${renews} day${renews === 1 ? "" : "s"}`);

  const reasons = [...red, ...yellow];
  if (!judged) {
    const why = seen.gaps.join(", ");
    reasons.push(`${why.charAt(0).toUpperCase()}${why.slice(1)}`);
  }
  return {
    status: red.length ? "red" : yellow.length ? "yellow" : judged ? "green" : "unknown",
    reasons,
    last_touch_at: touch,
    days_quiet: quiet,
    silence,
  };
}

export interface FocusAccount {
  id: string;
  name: string;
  status: Health;
  next_meeting_at: string | null;
  /** The account's reason about silence (AccountHealth.silence), when there is one. */
  silence: string | null;
  renewal_date?: string | null;
  ours_overdue: Array<{ id: string; title: string; due_date: string }>;
  ours_due_today: Array<{ id: string; title: string }>;
  risks: string[];
}

export interface FocusItem {
  kind: "overdue" | "reach_out" | "renewal" | "due_today" | "risk";
  company_id: string;
  company_name: string;
  text: string;
  task_id?: string;
}

/**
 * The few things worth doing first across all customers: our overdue promises,
 * oldest first; then red accounts with no call booked; then renewals due within
 * RENEWAL_SOON_DAYS, soonest first; then what we owe today; then open risks.
 * At most `limit`.
 */
export function focus(accounts: FocusAccount[], limit = 3, today = new Date().toISOString().slice(0, 10)): FocusItem[] {
  const out: FocusItem[] = [];
  const overdue = accounts.flatMap((a) => a.ours_overdue.map((t) => ({ a, t }))).sort((x, y) => x.t.due_date.localeCompare(y.t.due_date));
  for (const { a, t } of overdue) out.push({ kind: "overdue", company_id: a.id, company_name: a.name, text: `${t.title} (was due ${shortDay(t.due_date)})`, task_id: t.id });
  for (const a of accounts.filter((x) => x.status === "red" && !x.next_meeting_at)) {
    out.push({ kind: "reach_out", company_id: a.id, company_name: a.name, text: a.silence ? `Book a call: ${a.silence.charAt(0).toLowerCase()}${a.silence.slice(1)}` : "Book a call" });
  }
  const renewing = accounts
    .map((a) => ({ a, days: a.renewal_date ? daysUntil(a.renewal_date, today) : null }))
    .filter((x): x is { a: FocusAccount; days: number } => x.days !== null && x.days >= 0 && x.days <= RENEWAL_SOON_DAYS)
    .sort((x, y) => x.days - y.days);
  for (const { a, days } of renewing) {
    out.push({ kind: "renewal", company_id: a.id, company_name: a.name, text: days === 0 ? "Renews today" : `Renews in ${days} day${days === 1 ? "" : "s"} (${shortDay(a.renewal_date!)})` });
  }
  for (const a of accounts) for (const t of a.ours_due_today) out.push({ kind: "due_today", company_id: a.id, company_name: a.name, text: t.title, task_id: t.id });
  for (const a of accounts) for (const r of a.risks) out.push({ kind: "risk", company_id: a.id, company_name: a.name, text: r });
  return out.slice(0, limit);
}

// ── How an open deal is moving ─────────────────────────────────────

// shortcut: one threshold for every workspace. No operator post at the 20-like
// bar gives a number (docs research, 2026-10-06); make it a setting if teams ask.
/** No call or email on an open deal for this long is worth a word: deals cool in weeks, not months. */
export const DEAL_QUIET_DAYS = 14;

export interface NextStep {
  kind: "meeting" | "task";
  title: string;
  /** The meeting's start (ISO) or the task's due day (YYYY-MM-DD). */
  at: string;
  /** Who owes a task; null for a meeting. */
  owed_by: OwedBy | null;
  /** A task whose day has passed. */
  overdue: boolean;
}

export interface DealFacts {
  last_meeting_at: string | null;
  last_email_at: string | null;
  /** The latest call, message, email or meeting logged by hand on the deal or its company. */
  last_logged_at?: string | null;
  sight: Sight;
  /** The next meeting booked with the deal's company; `day` is its date where the viewer is. */
  next_meeting: { title: string; starts_at: string; day: string } | null;
  /** Open tasks on the deal, and its company's tasks on no deal. Undated ones are never a next step. */
  tasks: Array<{ title: string; due_date: string | null; owed_by: OwedBy }>;
  /** Moods of the company's last digested calls, newest first. */
  sentiments: Array<{ value: number; reason: string | null }>;
  /** Open risks noted in the company's calls. */
  risks: string[];
  close_date: string | null;
  /** No company on the deal, so no call or email can be matched to it. */
  no_company?: boolean;
}

export interface DealProgress {
  status: Health;
  reasons: string[];
  next_step: NextStep | null;
  last_touch_at: string | null;
  days_quiet: number | null;
}

/**
 * A deal's next step: the soonest of the next meeting booked with its company
 * and its open tasks with a date, ours or theirs. An overdue task is the
 * soonest of all; a task due the day of the meeting yields to the meeting. A
 * task without a date is not a next step: nobody agreed when.
 */
export function nextStep(f: Pick<DealFacts, "next_meeting" | "tasks">, today: string): NextStep | null {
  const task = f.tasks
    .filter((t): t is typeof t & { due_date: string } => !!t.due_date)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
  if (task && (!f.next_meeting || task.due_date < f.next_meeting.day)) {
    return { kind: "task", title: task.title, at: task.due_date, owed_by: task.owed_by, overdue: task.due_date < today };
  }
  if (f.next_meeting) return { kind: "meeting", title: f.next_meeting.title, at: f.next_meeting.starts_at, owed_by: null, overdue: false };
  return null;
}

const CALLS_GAP: Partial<Record<SyncState, string>> = {
  off: "calls aren't synced",
  importing: "calls are still importing",
  failing: "the meeting sync is failing",
};

/**
 * How an open deal is moving. Red when one of our promises is overdue, the
 * last call went badly, a risk is open, or there is no next step and nobody
 * has been in touch for DEAL_QUIET_DAYS. Yellow when there is no next step, no
 * contact for DEAL_QUIET_DAYS, they owe something overdue, the close date has
 * passed, or the mood dropped since the call before. Silence is judged as for
 * customers, only through what the CRM can see (contactSilence).
 */
export function dealHealth(f: DealFacts, now: Date, today = now.toISOString().slice(0, 10)): DealProgress {
  const red: string[] = [];
  const yellow: string[] = [];
  // With no company, no call or email can be matched to the deal: silence is never judged.
  const { touch, quiet, seen, judged, silence } = f.no_company
    ? { touch: null, quiet: null, seen: sightGaps(f.sight), judged: false, silence: null }
    : contactSilence(f, now, DEAL_QUIET_DAYS);
  const step = nextStep(f, today);
  const overdue = (by: OwedBy) => f.tasks
    .filter((t): t is typeof t & { due_date: string } => t.owed_by === by && !!t.due_date && t.due_date < today)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const ours = overdue("us");
  const theirs = overdue("them");

  if (ours.length === 1) red.push(`Overdue: ${ours[0].title} (due ${shortDay(ours[0].due_date)})`);
  else if (ours.length > 1) red.push(`${ours.length} of our promises are overdue`);
  const [mood, before] = f.sentiments;
  if (mood && mood.value <= -1) red.push(mood.reason ? `Last call went badly: ${mood.reason}` : "Last call went badly");
  if (f.risks.length) red.push(`Risk: ${f.risks[0]}${f.risks.length > 1 ? ` (and ${f.risks.length - 1} more)` : ""}`);

  if (!step) {
    if (silence && quiet !== null && quiet > DEAL_QUIET_DAYS) red.push(`No next step, and ${silence.charAt(0).toLowerCase()}${silence.slice(1)}`);
    else {
      // A booked call can only count when the CRM sees the calendar.
      const gap = CALLS_GAP[f.sight.calls];
      yellow.push(`No next step${gap && !f.no_company ? ` (${gap})` : ""}`);
      if (silence) yellow.push(silence);
    }
  } else if (silence) yellow.push(silence);
  if (theirs.length) yellow.push(`Waiting on them: ${theirs[0].title}${theirs.length > 1 ? ` (and ${theirs.length - 1} more)` : ""}`);
  const closes = f.close_date ? daysUntil(f.close_date, today) : null;
  if (closes !== null && closes < 0) yellow.push(`The close date (${shortDay(f.close_date!)}) has passed: move it or close the deal`);
  if (mood && before && mood.value < before.value && mood.value <= 0 && mood.value > -1) yellow.push("The mood dropped since the call before");

  const reasons = [...red, ...yellow];
  if (f.no_company) reasons.push("No company on this deal, so its calls and emails can't be matched");
  else if (!judged) {
    const why = seen.gaps.join(", ");
    reasons.push(`${why.charAt(0).toUpperCase()}${why.slice(1)}`);
  }
  return {
    status: red.length ? "red" : yellow.length ? "yellow" : judged && !f.no_company ? "green" : "unknown",
    reasons,
    next_step: step,
    last_touch_at: touch,
    days_quiet: quiet,
  };
}
