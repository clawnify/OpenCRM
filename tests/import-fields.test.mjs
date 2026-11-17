import test from "node:test";
import assert from "node:assert/strict";
import { CREATE_FIELD, suggestField, prepareImportFields, importFieldValue } from "../src/client/lib/import-fields.ts";

test("suggests supported types from spreadsheet values, while preserving identifiers", () => {
  const examples = [
    ["Profile", ["https://example.test/a"], "widget:clawnify::url.url"],
    ["Owner address", ["riley@example.test"], "widget:clawnify::email.email"],
    ["Direct line", ["+1 (202) 555-0102"], "widget:clawnify::phone.phone"],
    ["Fit", ["0", "85", "100"], "widget:clawnify::score.score"],
    ["Customer tier", ["Gold", "Silver", "Gold"], "widget:clawnify::badge.badge"],
    ["Interests", ["CRM; Reporting", "Sales"], "widget:clawnify::tags.tags"],
    ["Renewal", ["2027-01-15", "2027-03-20"], "base:date"],
    ["Quantity", ["120", "250"], "base:integer"],
    ["Budget", ["12.50", "15.25"], "base:decimal"],
    ["Postal code", ["85", "90"], "base:string"],
    ["Reference", ["0012", "0013"], "base:string"],
    ["Description", ["A long free-text description that should remain editable text rather than a badge."], "base:string"],
  ];
  for (const [header, values, expected] of examples) assert.equal(suggestField(header, values)?.typeId, expected, header);
});

test("empty, unnamed, and placeholder columns default to Skip; high-cardinality text remains text", () => {
  assert.equal(suggestField("Unused", ["", " "]), null);
  assert.equal(suggestField("", ["value"]), null);
  assert.equal(suggestField("---", ["value"]), null);
  assert.equal(suggestField("Unused", ["N/A", "-", "null"]), null);
  assert.equal(suggestField("Category", Array.from({ length: 13 }, (_, i) => `Group ${i}`)).typeId, "base:string");
  assert.notEqual(suggestField("Renewal", ["2027-02-30"]).typeId, "base:date");
});

test("only approved creations enter the plan; existing mappings and skipped columns stay untouched", () => {
  const fields = prepareImportFields("contact", [["Riley", "Gold", "discard"]],
    ["first_name", CREATE_FIELD, ""],
    [{ label: "Name", typeId: "base:string" }, { label: "Tier", typeId: "widget:clawnify::badge.badge" }, { label: "Unused", typeId: "base:string" }],
    []);
  assert.equal(fields.length, 1);
  assert.deepEqual(fields[0], {
    column: 1, entity_type: "contact", key: "custom_tier", label: "Tier",
    field_type: "enumeration", custom_field: "clawnify::badge.badge", options: { enum: ["Gold"] },
  });
  assert.deepEqual(prepareImportFields("company", [["Acme"]], ["name"], [], []), []);
});

test("new keys avoid system names, existing custom keys, and duplicate labels", () => {
  const fields = prepareImportFields("company", [["a", "b", "c", "d"]],
    Array(4).fill(CREATE_FIELD),
    ["ID", "ID", "123 Segment", "地域"].map((label) => ({ label, typeId: "base:string" })),
    ["custom_id"]);
  assert.deepEqual(fields.map((f) => f.key), ["custom_id_2", "custom_id_3", "custom_123_segment", "custom_field"]);
  assert.throws(() => prepareImportFields("contact", [["x"]], [CREATE_FIELD], [{ label: " ", typeId: "base:string" }], []), /enter a field label/);
});

test("badge options cover the whole file and tags and false checkboxes retain their values", () => {
  const rows = [...Array.from({ length: 100 }, () => ["Gold"]), ["Silver"], [""]];
  const [badge] = prepareImportFields("contact", rows, [CREATE_FIELD], [{ label: "Tier", typeId: "widget:clawnify::badge.badge" }], []);
  assert.deepEqual(badge.options.enum, ["Gold", "Silver"]);
  assert.deepEqual(importFieldValue("CRM; Sales; ", { label: "Interests", field_type: "json", custom_field: "clawnify::tags.tags" }), ["CRM", "Sales"]);
  assert.deepEqual(importFieldValue('["CRM","Sales"]', { label: "Interests", field_type: "json", custom_field: "clawnify::tags.tags" }), ["CRM", "Sales"]);
  const checkbox = { label: "Opt in", field_type: "boolean", custom_field: "" };
  assert.equal(importFieldValue("false", checkbox), false);
  assert.equal(importFieldValue("YES", checkbox), true);
  assert.equal(importFieldValue("", checkbox), null);
});

test("invalid overrides fail before any fields are created instead of silently discarding cells", () => {
  for (const [typeId, value, message] of [
    ["base:integer", "12.5", /whole number/],
    ["base:decimal", "not a number", /number/],
    ["base:boolean", "maybe", /checkbox/],
    ["base:date", "2027-02-30", /YYYY-MM-DD/],
    ["widget:clawnify::score.score", "101", /between 0 and 100/],
  ]) {
    assert.throws(() => prepareImportFields("contact", [[value]], [CREATE_FIELD], [{ label: "Test", typeId }], []), message);
  }
});
