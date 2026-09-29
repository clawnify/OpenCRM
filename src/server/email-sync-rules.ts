// Gmail sync rules: parsing the addresses on a message, which senders count as
// group mail, which people may become contacts, and the Gmail searches a sync
// runs. No I/O here, so every decision can be checked without a mailbox.

export interface Address {
  email: string; // lower-cased
  name: string | null;
}

export type AutoCreate = "none" | "sent" | "sent_and_received";
export type History = "3m" | "12m" | "all";

/**
 * "Ada Lovelace <ADA@x.com>, bob@y.com" → [{ ada@x.com, "Ada Lovelace" }, { bob@y.com }].
 * Splits on commas outside quotes and angle brackets; drops anything without an @.
 */
export function parseAddresses(header: string | null | undefined): Address[] {
  if (!header) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (ch === "," && !quoted && !angled) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);

  const seen = new Set<string>();
  const out: Address[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(.*)<([^>]*)>\s*$/);
    const email = (m ? m[2] : part).trim().replace(/^mailto:/i, "").toLowerCase();
    if (!email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    const name = m ? m[1].trim().replace(/^"(.*)"$/, "$1").trim() : "";
    out.push({ email, name: name && name.toLowerCase() !== email ? name : null });
  }
  return out;
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

// Shared inboxes and robots, by local part: mail from these is not a person
// writing to you, and none of them should become a contact.
const GROUP_LOCAL_PARTS = new Set([
  "team", "support", "help", "info", "hello", "hi", "contact", "sales", "marketing",
  "billing", "invoice", "invoices", "accounts", "admin", "office", "hr", "jobs", "careers",
  "press", "feedback", "service", "news", "newsletter", "updates", "alerts", "notification",
  "notifications", "mailer-daemon", "postmaster", "reply",
]);

/** team@, support@, noreply@… (the "Exclude group emails" option). */
export function isGroupAddress(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
  if (GROUP_LOCAL_PARTS.has(local)) return true;
  return /no-?reply|do-?not-?reply|^bounces?[+-]?|^notifications?[+-]/.test(local);
}

/**
 * Blocklist entries are addresses ("ada@x.com") or domains ("@x.com" or "x.com").
 * Normalised to lower case, blanks dropped.
 */
export function normaliseBlocklist(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const out = new Set<string>();
  for (const e of entries) {
    if (typeof e !== "string") continue;
    const v = e.trim().toLowerCase();
    if (!v) continue;
    out.add(v.includes("@") && !v.startsWith("@") ? v : `@${v.replace(/^@/, "")}`);
  }
  return [...out];
}

export function isBlocked(email: string, blocklist: string[]): boolean {
  const domain = `@${domainOf(email)}`;
  return blocklist.some((b) => b === email || b === domain);
}

export interface CreateRules {
  mailbox: string;
  policy: AutoCreate;
  excludeGroup: boolean;
  excludePersonal: boolean;
  blocklist: string[];
  /** Whether a domain is a personal provider (gmail.com, outlook.com…). */
  isPersonalDomain: (domain: string) => boolean;
}

/** Whether `address` may become a contact under these rules (policy aside). */
export function mayCreate(address: Address, rules: CreateRules): boolean {
  const { email } = address;
  const domain = domainOf(email);
  if (!domain || email === rules.mailbox) return false;
  if (isBlocked(email, rules.blocklist)) return false;
  if (rules.excludeGroup && isGroupAddress(email)) return false;
  if (rules.excludePersonal && rules.isPersonalDomain(domain)) return false;
  // Colleagues: the mailbox's own work domain is the team, not its contacts.
  // A personal mailbox (gmail.com) has no team domain to skip.
  const ownDomain = domainOf(rules.mailbox);
  if (domain === ownDomain && !rules.isPersonalDomain(ownDomain)) return false;
  return true;
}

// Gmail's own tabs for bulk mail; a received message filed there is not someone
// writing to you, so its sender never becomes a contact.
export const BULK_CATEGORIES = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"];

/** The people a message would add as contacts under the policy: recipients of
 *  mail you sent, and (for "sent and received") senders of mail you received. */
export function creationCandidates(
  msg: { direction: "sent" | "received"; from: Address | null; to: Address[]; labelIds: string[] },
  rules: CreateRules,
): Address[] {
  if (rules.policy === "none") return [];
  let people: Address[] = [];
  if (msg.direction === "sent") people = msg.to;
  else if (rules.policy === "sent_and_received" && msg.from && !msg.labelIds.some((l) => BULK_CATEGORIES.includes(l))) {
    people = [msg.from];
  }
  return people.filter((p) => mayCreate(p, rules));
}

/** "Ada Lovelace" → Ada / Lovelace; "Lovelace, Ada" → Ada / Lovelace; none → the address's local part. */
export function splitName(address: Address): { first: string; last: string } {
  const name = (address.name ?? "").trim();
  if (name && !name.includes("@")) {
    if (name.includes(",")) {
      const [last, first] = name.split(",", 2).map((s) => s.trim());
      if (first) return { first, last };
    }
    const [first, ...rest] = name.split(/\s+/);
    return { first, last: rest.join(" ") };
  }
  const local = address.email.slice(0, address.email.lastIndexOf("@"));
  return { first: local, last: "" };
}

/** A date as Gmail's after: reads it (YYYY/MM/DD, midnight Pacific): a day is precision enough for the first import's reach. */
function gmailDate(d: Date): string {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** The first import's reach: null means all of it. */
export function historyStart(history: History, now: Date): Date | null {
  if (history === "all") return null;
  const days = history === "3m" ? 90 : 365;
  return new Date(now.getTime() - days * 86_400_000);
}

/** A Gmail label name as label: search takes it ("Clients 2024" → clients-2024). */
function labelTerm(name: string): string {
  return `label:${name.trim().toLowerCase().replace(/[\s/]+/g, "-")}`;
}

export interface Scope {
  labels: string[]; // label names; empty means all mail
  since: Date | null;
}

/** The parts every sync search shares: the labels in scope and how far back. Chats never count. */
export function scopeTerms(scope: Scope): string[] {
  const terms = ["-in:chats"];
  if (scope.labels.length === 1) terms.push(labelTerm(scope.labels[0]));
  else if (scope.labels.length > 1) terms.push(`{${scope.labels.map(labelTerm).join(" ")}}`);
  if (scope.since) terms.push(`after:${gmailDate(scope.since)}`);
  return terms;
}

/** Mail you sent: where "sent" contacts come from. */
export function sentQuery(scope: Scope): string {
  return ["in:sent", ...scopeTerms(scope)].join(" ");
}

/** Mail you received, minus Gmail's bulk tabs: where "received" contacts come from. */
export function receivedQuery(scope: Scope): string {
  return ["-in:sent", "-category:promotions", "-category:social", "-category:updates", "-category:forums", ...scopeTerms(scope)].join(" ");
}

/** Every message from or to any of these addresses. Gmail's {a b} means a OR b. */
export function peopleQuery(emails: string[], scope: Scope): string {
  const either = emails.flatMap((e) => [`from:${e}`, `to:${e}`]);
  return [`{${either.join(" ")}}`, ...scopeTerms(scope)].join(" ");
}

/** How far back each live read reaches before the last sync: for mail that becomes searchable late. */
export const LIVE_OVERLAP_MS = 60 * 60_000;
/** The same when only labels sync: mail enters a label when someone labels it, often hours after it arrived. */
export const LABEL_OVERLAP_MS = 86_400_000;

/**
 * New mail since the last sync. after: takes Unix seconds as well as dates
 * (developers.google.com/workspace/gmail/api/guides/filtering), so a live read
 * of all mail reaches back an hour, not the whole day a date would.
 */
export function sinceQuery(syncedUntil: Date, scope: Scope): string {
  const since = new Date(syncedUntil.getTime() - (scope.labels.length ? LABEL_OVERLAP_MS : LIVE_OVERLAP_MS));
  const floor = scope.since && scope.since > since ? scope.since : since;
  return [...scopeTerms({ ...scope, since: null }), `after:${Math.floor(floor.getTime() / 1000)}`].join(" ");
}
