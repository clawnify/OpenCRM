import type { AttributeType, CustomFieldDef, ImportEntity } from "../types";

export const CREATE_FIELD = "__create__";

export interface FieldDraft {
  label: string;
  typeId: string;
}

export interface ImportField {
  column: number;
  entity_type: ImportEntity;
  key: string;
  label: string;
  field_type: AttributeType;
  custom_field: string;
  options: Record<string, unknown>;
}

const widget = (name: string) => `widget:clawnify::${name}.${name}`;
const valuesIn = (values: string[]) => values.map((v) => v.trim()).filter(Boolean);
const isDay = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;

/** Conservative suggestions; nothing is persisted until the review is confirmed. */
export function suggestField(header: string, cells: string[]): FieldDraft | null {
  const label = header.trim();
  const values = valuesIn(cells);
  if (!label || !/[\p{L}\p{N}]/u.test(label) || !values.length ||
      values.every((v) => /^(n\/a|null|undefined|-+)$/i.test(v))) return null;

  let typeId = "base:string";
  // Preserve identifiers and leading zeros, even when the sample looks numeric.
  if (/\b(id|zip|postal|postcode|code)\b/i.test(label) || values.some((v) => /^0\d+$/.test(v))) {
    return { label, typeId };
  }
  if (values.every((v) => /^https?:\/\/\S+$/i.test(v))) typeId = widget("url");
  else if (values.every((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) typeId = widget("email");
  else if (values.every((v) => /^\+[\d\s().-]+$/.test(v) && v.replace(/\D/g, "").length >= 7)) typeId = widget("phone");
  else if (values.every(isDay)) typeId = "base:date";
  else if (values.some((v) => v.includes(";"))) typeId = widget("tags");
  else if (values.every((v) => /^\d+$/.test(v) && Number(v) <= 100)) typeId = widget("score");
  else if (values.every((v) => /^-?\d+$/.test(v))) typeId = "base:integer";
  else if (values.every((v) => /^-?\d+(\.\d+)?$/.test(v))) typeId = "base:decimal";
  else if (new Set(values).size <= 12 && values.every((v) => v.length <= 60 && !v.includes("\n"))) typeId = widget("badge");
  return { label, typeId };
}

/** Use the whole column for enum options, so a value after the preview isn't lost. */
export function prepareImportFields(
  entity: ImportEntity,
  rows: string[][],
  mapping: string[],
  drafts: FieldDraft[],
  existingKeys: string[],
): ImportField[] {
  const used = new Set(existingKeys);
  return mapping.flatMap((target, column) => {
    if (target !== CREATE_FIELD) return [];
    const draft = drafts[column];
    const label = draft.label.trim();
    if (!label) throw new Error(`Column ${column + 1}: enter a field label or choose Skip.`);
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
    // The prefix avoids collisions with system columns, including read-only ones.
    const base = `custom_${slug}`;
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    used.add(key);
    const uid = draft.typeId.startsWith("widget:") ? draft.typeId.slice(7) : "";
    const widgetTypes: Record<string, AttributeType> = {
      [widget("score")]: "integer", [widget("badge")]: "enumeration",
      [widget("url")]: "string", [widget("email")]: "string",
      [widget("phone")]: "string", [widget("tags")]: "json",
    };
    const field_type = uid ? widgetTypes[draft.typeId] : draft.typeId.slice(5) as AttributeType;
    if (!field_type || !["string", "text", "integer", "decimal", "boolean", "date", "enumeration", "json"].includes(field_type)) {
      throw new Error(`"${label}": choose a supported field type.`);
    }
    const values = valuesIn(rows.map((row) => row[column] ?? ""));
    const options: Record<string, unknown> = {};
    if (field_type === "enumeration") options.enum = [...new Set(values)];
    if (uid === "clawnify::score.score") { options.min = 0; options.max = 100; }
    const field = { column, entity_type: entity, key, label, field_type, custom_field: uid, options };
    // Validate type overrides before creating any fields or importing records.
    for (const value of values) importFieldValue(value, field);
    return [field];
  });
}

/** Convert spreadsheet text to the existing API's checkbox / tag representation. */
export function importFieldValue(
  value: string,
  field: Pick<CustomFieldDef, "label" | "field_type" | "custom_field">,
): unknown {
  const v = value.trim();
  if (!v) return null;
  if (field.custom_field === "clawnify::tags.tags") {
    // CSV exports can contain the stored JSON array instead of semicolons.
    if (v.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(v);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
      } catch { /* A literal tag can also start with a bracket. */ }
    }
    return v.split(";").map((s) => s.trim()).filter(Boolean);
  }
  if (field.field_type === "boolean") {
    if (/^(true|yes|1)$/i.test(v)) return true;
    if (/^(false|no|0)$/i.test(v)) return false;
    throw new Error(`"${field.label}": "${v}" is not a checkbox value. Use true/false, yes/no, or 1/0, or choose Text.`);
  }
  if (field.field_type === "integer" || field.field_type === "decimal") {
    const number = Number(v);
    if (!Number.isFinite(number) || (field.field_type === "integer" && !Number.isSafeInteger(number))) {
      throw new Error(`"${field.label}": "${v}" is not a valid ${field.field_type === "integer" ? "whole number" : "number"}. Choose another type.`);
    }
    if (field.custom_field === "clawnify::score.score" && (number < 0 || number > 100)) {
      throw new Error(`"${field.label}": scores must be between 0 and 100. Choose Number or Text.`);
    }
    return number;
  }
  if (field.field_type === "date" && !isDay(v)) {
    throw new Error(`"${field.label}": "${v}" is not a date in YYYY-MM-DD format. Choose Text to keep it unchanged.`);
  }
  return v;
}
