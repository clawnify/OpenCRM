import type { ImportEntity } from "@/types";

// Per-entity import configuration. The generic ImportDialog handles the flow
// (upload → map → done); everything entity-specific — the built-in mapping
// targets, header auto-mapping, and the required-column rule — lives here.
export interface EntityImportConfig {
  entity: ImportEntity;
  title: string;
  noun: string; // singular, lowercase — "contact" / "company"
  // Built-in mapping targets whose value IS the payload key ("full_name" is the
  // one virtual target — the dialog splits it into first/last name).
  fields: { label: string; value: string }[];
  // Header (normalized) → target, exact match wins first.
  exact: Record<string, string>;
  // Header (normalized) → target, fuzzy fallback in order.
  fuzzy: [RegExp, string][];
  hasRequired: (mapping: string[]) => boolean;
  requiredHint: string;
  // Contacts only: offer the "create companies from work-email domains" opt-in.
  supportsCompanyInference?: boolean;
}

export const contactImportConfig: EntityImportConfig = {
  entity: "contact",
  title: "Import contacts",
  noun: "contact",
  fields: [
    { label: "Full name (split)", value: "full_name" },
    { label: "First name", value: "first_name" },
    { label: "Last name", value: "last_name" },
    { label: "Email", value: "email" },
    { label: "Phone", value: "phone" },
    { label: "Title", value: "title" },
    { label: "Company", value: "company" },
    { label: "Company domain", value: "company_domain" },
    { label: "Company industry", value: "company_industry" },
    { label: "Company phone", value: "company_phone" },
    { label: "Status", value: "status" },
  ],
  exact: {
    firstname: "first_name", first: "first_name", givenname: "first_name", forename: "first_name", fname: "first_name",
    lastname: "last_name", last: "last_name", surname: "last_name", familyname: "last_name", lname: "last_name",
    fullname: "full_name", name: "full_name", contactname: "full_name",
    email: "email", emailaddress: "email", mail: "email", primaryemail: "email",
    phone: "phone", phonenumber: "phone", mobile: "phone", mobilephone: "phone", cell: "phone", telephone: "phone", tel: "phone",
    title: "title", jobtitle: "title", role: "title", position: "title",
    company: "company", companyname: "company", organization: "company", organisation: "company", account: "company", employer: "company",
    companyphone: "company_phone", companyphonenumber: "company_phone", companytelephone: "company_phone",
    companydomain: "company_domain", domain: "company_domain", website: "company_domain", companywebsite: "company_domain",
    industry: "company_industry", companyindustry: "company_industry", sector: "company_industry", vertical: "company_industry",
    status: "status", stage: "status", lifecyclestage: "status",
  },
  fuzzy: [
    [/^(first|given|fore)name/, "first_name"],
    [/^(last|sur|family)name/, "last_name"],
    [/^phone|phone$|mobile|^cell/, "phone"],
    [/^email|email$/, "email"],
    [/company|organi|employer/, "company"],
    [/domain|website/, "company_domain"],
    [/industry|sector/, "company_industry"],
    [/jobtitle|^title$|position/, "title"],
  ],
  hasRequired: (m) => m.some((f) => f === "first_name" || f === "full_name"),
  requiredHint: "Map a column to First name or Full name to continue.",
  supportsCompanyInference: true,
};

export const companyImportConfig: EntityImportConfig = {
  entity: "company",
  title: "Import companies",
  noun: "company",
  fields: [
    { label: "Name", value: "name" },
    { label: "Domain", value: "domain" },
    { label: "Industry", value: "industry" },
    { label: "Phone", value: "phone" },
    { label: "Email", value: "email" },
    { label: "Notes", value: "notes" },
  ],
  exact: {
    name: "name", companyname: "name", company: "name", organization: "name", organisation: "name", account: "name",
    domain: "domain", website: "domain", companydomain: "domain", url: "domain",
    industry: "industry", sector: "industry", vertical: "industry",
    phone: "phone", phonenumber: "phone", telephone: "phone", tel: "phone", mainphone: "phone",
    email: "email", emailaddress: "email", mail: "email",
    notes: "notes", note: "notes", description: "notes", about: "notes",
  },
  fuzzy: [
    [/company|organi|account/, "name"],
    [/domain|website/, "domain"],
    [/industry|sector/, "industry"],
    [/phone|^tel/, "phone"],
    [/email/, "email"],
    [/note|description/, "notes"],
  ],
  hasRequired: (m) => m.some((f) => f === "name"),
  requiredHint: "Map a column to Name to continue.",
};

export const CUSTOM_PREFIX = "custom:";

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export function autoMap(
  headers: string[],
  config: EntityImportConfig,
  customFields: { key: string; label: string }[],
): string[] {
  const result: string[] = headers.map(() => "");
  const used = new Set<string>();
  // 1. exact built-in header match
  headers.forEach((h, i) => {
    const f = config.exact[norm(h)];
    if (f && !used.has(f)) {
      result[i] = f;
      used.add(f);
    }
  });
  // A recognized built-in header keeps its meaning even if another column
  // already claimed that target: leave the duplicate unmapped for review.
  // 2. custom field whose key or label matches the header
  headers.forEach((h, i) => {
    if (result[i] || config.exact[norm(h)]) return;
    const n = norm(h);
    for (const d of customFields) {
      const target = CUSTOM_PREFIX + d.key;
      if (used.has(target)) continue;
      if (n === norm(d.key) || n === norm(d.label)) {
        result[i] = target;
        used.add(target);
        break;
      }
    }
  });
  // 3. fuzzy built-in fallback
  headers.forEach((h, i) => {
    if (result[i] || config.exact[norm(h)]) return;
    const n = norm(h);
    for (const [re, f] of config.fuzzy) {
      if (re.test(n) && !used.has(f)) {
        result[i] = f;
        used.add(f);
        break;
      }
    }
  });
  return result;
}
