// What the CRM knows about an email address, for whoever is about to write to
// it: the contact, their company (and whether it is a customer), its deals, and
// its calls. An app next door, such as a sequencer, reads it before an email
// goes out, so nobody cold-emails a customer or a company mid-deal. Read only.

import { get, query } from "./db.js";
import { readAccounts } from "./customers.js";
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

/** A company domain as stored or typed ("https://www.Acme.com/") reduced to "acme.com"; "" for a personal provider. */
export function bareDomain(raw: string): string {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!d.includes(".") || FREEMAIL_DOMAINS.has(d)) return "";
  return d;
}

/** The same reduction in SQL, for the stored `companies.domain` (as findOrCreateCompanyByDomain does). */
const DOMAIN_SQL = "lower(replace(replace(replace(rtrim(domain,'/'),'https://',''),'http://',''),'www.',''))";

/**
 * The contact with exactly this address, and the company: the contact's, else
 * the one whose domain is `domain` (else the address's own, when it is a work
 * address). Of several companies on one domain, a customer wins, then the
 * latest updated.
 */
export async function lookup(email: string, domain: string, now = new Date()): Promise<Lookup> {
  const address = email.trim().toLowerCase();
  const contact = address
    ? await get<{ id: string; first_name: string; last_name: string; title: string; status: string; company_id: string | null }>(
      `SELECT id, first_name, COALESCE(last_name, '') AS last_name, COALESCE(title, '') AS title, status, company_id
         FROM contacts WHERE lower(trim(email)) = ? ORDER BY updated_at DESC LIMIT 1`,
      [address],
    )
    : undefined;

  type CompanyRow = NonNullable<Lookup["company"]>;
  const COMPANY = "SELECT id, name, COALESCE(domain, '') AS domain, customer_since, renewal_date FROM companies";
  let company = contact?.company_id ? await get<CompanyRow>(`${COMPANY} WHERE id = ?`, [contact.company_id]) : undefined;
  const site = bareDomain(domain) || bareDomain(address.slice(address.lastIndexOf("@") + 1));
  if (!company && site) {
    company = await get<CompanyRow>(
      `${COMPANY} WHERE ${DOMAIN_SQL} = ?
        ORDER BY (customer_since IS NULL OR TRIM(customer_since) = ''), updated_at DESC LIMIT 1`,
      [site],
    );
  }

  const deals = contact || company
    ? await query<LookupDeal & { is_won: number | null; is_lost: number | null }>(
      `SELECT d.id, d.name, d.stage, COALESCE(s.label, d.stage) AS stage_label, s.is_won, s.is_lost,
              COALESCE(d.value, 0) AS value, COALESCE(d.close_date, '') AS close_date
         FROM deals d LEFT JOIN stages s ON s.key = d.stage
        WHERE d.company_id = ? OR d.contact_id = ?
        ORDER BY (COALESCE(s.is_won, 0) + COALESCE(s.is_lost, 0)) > 0, d.updated_at DESC LIMIT 10`,
      [company?.id ?? null, contact?.id ?? null],
    )
    : [];

  let last_call_at: string | null = null;
  let next_meeting: Lookup["next_meeting"] = null;
  if (company) {
    const account = (await readAccounts([company.id], now)).of(company.id);
    next_meeting = account.next_meeting;
    // Calls logged by hand count too, but not emails: an app that writes here
    // logs its own sends as emails, and those are not a relationship.
    const logged = await get<{ at: string | null }>(
      `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', MAX(created_at)) AS at FROM activities
        WHERE type IN ('call', 'meeting') AND (
          (entity_type = 'company' AND entity_id = ?)
          OR (entity_type = 'contact' AND entity_id IN (SELECT id FROM contacts WHERE company_id = ?))
          OR (entity_type = 'deal' AND entity_id IN (SELECT id FROM deals WHERE company_id = ?)))`,
      [company.id, company.id, company.id],
    );
    last_call_at = [account.last_meeting_at, logged?.at ?? null].filter((at): at is string => !!at).sort().pop() ?? null;
  }

  return {
    contact: contact ? { id: contact.id, first_name: contact.first_name, last_name: contact.last_name, title: contact.title, status: contact.status } : null,
    company: company
      ? { ...company, customer_since: company.customer_since?.trim() || null, renewal_date: company.renewal_date?.trim() || null }
      : null,
    deals: deals.map(({ is_won, is_lost, ...d }) => ({ ...d, state: is_won ? "won" : is_lost ? "lost" : "open" })),
    last_call_at,
    next_meeting,
  };
}
