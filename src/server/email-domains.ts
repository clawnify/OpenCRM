// Email domains: telling a work address from a personal one, and the company a
// work address belongs to. Shared by contact import, contact create and the
// Gmail sync, so the three agree on what counts as a company's domain.

import freemailDomains from "free-email-domains";
import { get, run } from "./db.js";

// Personal/free email providers (gmail, outlook, …) — a company is never
// inferred from these, else every import would spawn a "Gmail" company. Sourced
// from the maintained `free-email-domains` list (~12.8k domains) so it stays
// current via dependency bumps rather than hand-curation.
export const FREEMAIL_DOMAINS = new Set(freemailDomains.map((d) => d.toLowerCase()));

// The domain of a work email, or "" if it has none or is a free provider.
export function workEmailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes(".")) return "";
  return FREEMAIL_DOMAINS.has(domain) ? "" : domain;
}

/** Find a company whose stored domain resolves to `domain` (tolerating
 *  protocol / www / trailing slash), else create a lightweight one named after
 *  the domain. Used to auto-link a contact to a company from its work email. */
export async function findOrCreateCompanyByDomain(domain: string): Promise<string> {
  const existing = await get<{ id: string }>(
    `SELECT id FROM companies
      WHERE lower(replace(replace(replace(rtrim(domain,'/'),'https://',''),'http://',''),'www.','')) = ?
      LIMIT 1`,
    [domain],
  );
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const sld = domain.split(".")[0] || domain;
  const name = sld.charAt(0).toUpperCase() + sld.slice(1);
  await run("INSERT INTO companies (id, name, domain) VALUES (?, ?, ?)", [id, name, domain]);
  return id;
}
