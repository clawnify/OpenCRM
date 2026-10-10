// What the CRM knows about an email address, for whoever is about to write to
// it: the contact, their company (and whether it is a customer), its deals, and
// its calls. An app next door, such as a sequencer, reads it before an email
// goes out, so nobody cold-emails a customer or a company mid-deal; and for a
// batch of people before they join a campaign. Read only. Every read is by
// set, so a batch of 100 costs a few dozen queries, not a few per address.

import { inChunks, readAccounts } from "./customers.js";
import { FREEMAIL_DOMAINS } from "./email-domains.js";

export interface LookupDeal {
  id: string;
  name: string;
  stage: string;
  stage_label: string;
  /** "open", "won" or "lost", from the stage's flags; a stage not in the pipeline is open. */
  state: "open" | "won" | "lost";
  value: number;
  close_date: string;
}

export interface Lookup {
  contact: { id: string; first_name: string; last_name: string; title: string; status: string } | null;
  company: { id: string; name: string; domain: string; customer_since: string | null; renewal_date: string | null } | null;
  /** The company's deals and the contact's, open first, then the newest. At most 10. */
  deals: LookupDeal[];
  /** The latest call with the company: a synced meeting, or a call or meeting logged by hand. */
  last_call_at: string | null;
  next_meeting: { title: string; starts_at: string } | null;
}

/** One address to look up, and the company's domain when the address alone doesn't say it. */
export interface Address {
  email: string;
  domain: string;
}

/** A company domain as stored or typed ("https://www.Acme.com/") reduced to "acme.com"; "" for a personal provider. */
export function bareDomain(raw: string): string {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!d.includes(".") || FREEMAIL_DOMAINS.has(d)) return "";
  return d;
}

/** The same reduction in SQL, for the stored `companies.domain` (as findOrCreateCompanyByDomain does). */
const DOMAIN_SQL = "lower(replace(replace(replace(rtrim(domain,'/'),'https://',''),'http://',''),'www.',''))";

type ContactRow = NonNullable<Lookup["contact"]> & { company_id: string | null; email: string };
type CompanyRow = NonNullable<Lookup["company"]> & { bare: string; updated_at: string };
type DealRow = Omit<LookupDeal, "state"> & { is_won: number | null; is_lost: number | null; company_id: string | null; contact_id: string | null; updated_at: string };

const COMPANY = `SELECT id, name, COALESCE(domain, '') AS domain, customer_since, renewal_date, updated_at, ${DOMAIN_SQL} AS bare FROM companies`;
const DEAL = `SELECT d.id, d.name, d.stage, COALESCE(s.label, d.stage) AS stage_label, s.is_won, s.is_lost,
       COALESCE(d.value, 0) AS value, COALESCE(d.close_date, '') AS close_date, d.company_id, d.contact_id, d.updated_at
  FROM deals d LEFT JOIN stages s ON s.key = d.stage`;
/** The latest of the rows' `created_at` (SQLite's "YYYY-MM-DD HH:MM:SS", UTC) as ISO 8601. */
const ISO_MAX = "strftime('%Y-%m-%dT%H:%M:%SZ', MAX(a.created_at))";

const customer = (c: CompanyRow) => !!c.customer_since?.trim();
const closed = (d: DealRow) => !!d.is_won || !!d.is_lost;

/**
 * For each address, in order: the contact with exactly that address; their
 * company, else the one whose domain is the address's `domain` (else the
 * address's own, when it is a work address); its and the contact's deals; and
 * its calls. Of several companies on one domain, a customer wins, then the
 * latest updated.
 */
export async function lookupMany(addresses: Address[], now = new Date()): Promise<Lookup[]> {
  const asked = addresses.map((a) => {
    const email = a.email.trim().toLowerCase();
    return { email, site: bareDomain(a.domain) || bareDomain(email.slice(email.lastIndexOf("@") + 1)) };
  });

  const emails = [...new Set(asked.map((a) => a.email).filter(Boolean))];
  const contactOf = new Map<string, ContactRow>();
  for (const c of await inChunks<ContactRow>(emails, (m) =>
    `SELECT id, first_name, COALESCE(last_name, '') AS last_name, COALESCE(title, '') AS title, status, company_id, lower(trim(email)) AS email
       FROM contacts WHERE lower(trim(email)) IN (${m}) ORDER BY updated_at DESC`)) {
    if (!contactOf.has(c.email)) contactOf.set(c.email, c);
  }

  const ownIds = [...new Set([...contactOf.values()].map((c) => c.company_id).filter((id): id is string => !!id))];
  const byId = new Map((await inChunks<CompanyRow>(ownIds, (m) => `${COMPANY} WHERE id IN (${m})`)).map((c) => [c.id, c]));
  const ownCompany = (email: string) => {
    const id = email ? contactOf.get(email)?.company_id : null;
    return id ? byId.get(id) : undefined;
  };
  const sites = [...new Set(asked.filter((a) => a.site && !ownCompany(a.email)).map((a) => a.site))];
  const onSite = new Map<string, CompanyRow>();
  for (const c of await inChunks<CompanyRow>(sites, (m) => `${COMPANY} WHERE ${DOMAIN_SQL} IN (${m})`)) {
    const best = onSite.get(c.bare);
    if (!best || (customer(c) !== customer(best) ? customer(c) : c.updated_at > best.updated_at)) onSite.set(c.bare, c);
  }

  const found = asked.map((a) => ({
    contact: a.email ? contactOf.get(a.email) : undefined,
    company: ownCompany(a.email) ?? (a.site ? onSite.get(a.site) : undefined),
  }));
  const companyIds = [...new Set(found.map((f) => f.company?.id).filter((id): id is string => !!id))];
  const contactIds = [...new Set(found.map((f) => f.contact?.id).filter((id): id is string => !!id))];

  const deals = new Map<string, DealRow>();
  for (const d of [
    ...(await inChunks<DealRow>(companyIds, (m) => `${DEAL} WHERE d.company_id IN (${m})`)),
    ...(await inChunks<DealRow>(contactIds, (m) => `${DEAL} WHERE d.contact_id IN (${m})`)),
  ]) deals.set(d.id, d);

  // Calls logged by hand count too, but not emails: an app that writes here
  // logs its own sends as emails, and those are not a relationship.
  const logged = new Map<string, string>();
  const keep = (rows: Array<{ company_id: string; at: string | null }>) => {
    for (const r of rows) if (r.at && r.at > (logged.get(r.company_id) ?? "")) logged.set(r.company_id, r.at);
  };
  keep(await inChunks(companyIds, (m) => `SELECT a.entity_id AS company_id, ${ISO_MAX} AS at FROM activities a
    WHERE a.entity_type = 'company' AND a.type IN ('call', 'meeting') AND a.entity_id IN (${m}) GROUP BY a.entity_id`));
  keep(await inChunks(companyIds, (m) => `SELECT c.company_id, ${ISO_MAX} AS at FROM activities a JOIN contacts c ON c.id = a.entity_id
    WHERE a.entity_type = 'contact' AND a.type IN ('call', 'meeting') AND c.company_id IN (${m}) GROUP BY c.company_id`));
  keep(await inChunks(companyIds, (m) => `SELECT d.company_id, ${ISO_MAX} AS at FROM activities a JOIN deals d ON d.id = a.entity_id
    WHERE a.entity_type = 'deal' AND a.type IN ('call', 'meeting') AND d.company_id IN (${m}) GROUP BY d.company_id`));
  const accounts = companyIds.length ? await readAccounts(companyIds, now) : null;

  return found.map(({ contact, company }) => {
    const account = company && accounts ? accounts.of(company.id) : null;
    const theirs = [...deals.values()]
      .filter((d) => (company && d.company_id === company.id) || (contact && d.contact_id === contact.id))
      .sort((a, b) => Number(closed(a)) - Number(closed(b)) || (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
      .slice(0, 10);
    return {
      contact: contact ? { id: contact.id, first_name: contact.first_name, last_name: contact.last_name, title: contact.title, status: contact.status } : null,
      company: company
        ? { id: company.id, name: company.name, domain: company.domain, customer_since: company.customer_since?.trim() || null, renewal_date: company.renewal_date?.trim() || null }
        : null,
      deals: theirs.map((d) => ({
        id: d.id, name: d.name, stage: d.stage, stage_label: d.stage_label,
        state: d.is_won ? "won" as const : d.is_lost ? "lost" as const : "open" as const, value: d.value, close_date: d.close_date,
      })),
      last_call_at: [account?.last_meeting_at ?? null, company ? logged.get(company.id) ?? null : null]
        .filter((at): at is string => !!at).sort().pop() ?? null,
      next_meeting: account?.next_meeting ?? null,
    };
  });
}

/** What the CRM knows about one address: `lookupMany` for one. */
export async function lookup(email: string, domain: string, now = new Date()): Promise<Lookup> {
  return (await lookupMany([{ email, domain }], now))[0];
}
