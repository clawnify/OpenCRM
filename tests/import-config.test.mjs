import assert from "node:assert/strict";
import test from "node:test";
import {
  autoMap,
  contactImportConfig,
  companyImportConfig,
} from "../src/client/lib/import-config.ts";

test("a company phone column stays separate from the contact's phone and company name", () => {
  assert.deepEqual(
    autoMap(["First name", "Company phone"], contactImportConfig, []),
    ["first_name", "company_phone"],
  );
  assert.deepEqual(
    autoMap(["First name", "Phone", "Company phone"], contactImportConfig, []),
    ["first_name", "phone", "company_phone"],
  );
});

test("company phone aliases map to the same destination", () => {
  for (const header of [
    "Company Phone Number",
    "company_phone",
    "Company telephone",
  ]) {
    assert.deepEqual(autoMap(["First name", header], contactImportConfig, []), [
      "first_name",
      "company_phone",
    ]);
  }
});

test("a second exact-match column is skipped instead of falling back to another field", () => {
  assert.deepEqual(
    autoMap(
      ["First name", "Company domain", "Company website"],
      contactImportConfig,
      [],
    ),
    ["first_name", "company_domain", ""],
  );
  assert.deepEqual(
    autoMap(
      ["First name", "Company phone", "Company phone number"],
      contactImportConfig,
      [],
    ),
    ["first_name", "company_phone", ""],
  );
});

test("exact custom fields still beat fuzzy built-ins and targets are only assigned once", () => {
  assert.deepEqual(
    autoMap(
      ["First name", "Office phone", "Direct phone", "Company"],
      contactImportConfig,
      [{ key: "office_phone", label: "Office phone" }],
    ),
    ["first_name", "custom:office_phone", "phone", "company"],
  );
  assert.deepEqual(
    autoMap(["Name", "Domain", "Website", "Phone"], companyImportConfig, []),
    ["name", "domain", "", "phone"],
  );
});
