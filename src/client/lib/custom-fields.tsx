/**
 * Custom-property widgets — client registry.
 *
 * A custom property renders through a widget chosen by `def.custom_field`
 * (score, badge, url…) layered over its base `field_type`. `CustomFieldDisplay`
 * renders read-only values (tables, detail); `CustomFieldInput` renders editors
 * (dialogs). Colors come from the app's DESIGN.md tokens (`colorPalette`), not
 * bespoke values, so custom fields match the rest of the CRM.
 */

import { useState } from "react";
import { Gauge, Tag, Link2, AtSign, Phone as PhoneIcon, Tags as TagsIcon, Hash, Type, ToggleLeft, Calendar, List, X, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { cn, colorClasses, categoryToken, type ColorToken } from "@/lib/utils";
import { api } from "@/api";
import type { AttributeType, CustomFieldDef, EntityType } from "@/types";

// ── Widget catalog (for the Properties field-type picker) ─────────────

export interface WidgetMeta {
  uid: string; // "" = a bare base type
  label: string;
  icon: typeof Type;
  field_type: AttributeType;
}

/** Custom widgets (ride on a base type). */
export const WIDGETS: WidgetMeta[] = [
  { uid: "clawnify::score.score", label: "Score", icon: Gauge, field_type: "integer" },
  { uid: "clawnify::badge.badge", label: "Badge", icon: Tag, field_type: "enumeration" },
  { uid: "clawnify::url.url", label: "URL", icon: Link2, field_type: "string" },
  { uid: "clawnify::email.email", label: "Email", icon: AtSign, field_type: "string" },
  { uid: "clawnify::phone.phone", label: "Phone", icon: PhoneIcon, field_type: "string" },
  { uid: "clawnify::tags.tags", label: "Tags", icon: TagsIcon, field_type: "json" },
];

/** Bare base types (no widget). */
export const BASE_TYPES: WidgetMeta[] = [
  { uid: "", label: "Text", icon: Type, field_type: "string" },
  { uid: "", label: "Long text", icon: List, field_type: "text" },
  { uid: "", label: "Number", icon: Hash, field_type: "integer" },
  { uid: "", label: "Decimal", icon: Hash, field_type: "decimal" },
  { uid: "", label: "Checkbox", icon: ToggleLeft, field_type: "boolean" },
  { uid: "", label: "Date", icon: Calendar, field_type: "date" },
];

export function widgetMetaFor(def: Pick<CustomFieldDef, "custom_field" | "field_type">): WidgetMeta | undefined {
  return def.custom_field ? WIDGETS.find((w) => w.uid === def.custom_field) : undefined;
}

// ── Value access + coercion ───────────────────────────────────────────

/** Read a custom value off an entity row (custom values are flat columns). */
export function readCustom(row: unknown, key: string): unknown {
  return (row as Record<string, unknown> | undefined)?.[key];
}

function enumValues(def: CustomFieldDef): string[] {
  const v = def.options.enum;
  return Array.isArray(v) ? v.map(String) : [];
}

// ── Badge colors (semantic → token, else stable hash) ─────────────────

const SEMANTIC: Record<string, ColorToken> = {
  high: "success", won: "success", verified: "success", active: "success", live: "success", qualified: "success", hot: "success", approved: "success",
  medium: "warning", warm: "warning", strong: "warning", inferred: "warning", negotiating: "warning", pending: "warning",
  immediate: "danger", urgent: "danger", lost: "danger", rejected: "danger", critical: "danger", churned: "danger",
  lead: "info", new: "info", open: "info", scheduled: "info", in_progress: "info", contacted: "info",
  low: "slate", monitor: "slate", general: "slate", cold: "slate", inactive: "slate",
};

function badgeToken(value: string): ColorToken {
  const key = value.toLowerCase().replace(/[[\]()]/g, "").trim();
  return SEMANTIC[key] ?? categoryToken(value);
}

function Pill({ value }: { value: string }) {
  const c = colorClasses(badgeToken(value));
  return (
    <span
      title={value}
      className={cn("inline-block max-w-[10rem] truncate rounded-full px-2.5 py-1 align-middle text-xs font-medium", c.bg, c.text)}
    >
      {value}
    </span>
  );
}

// ── Tags helpers ──────────────────────────────────────────────────────

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) {
    try {
      const p = JSON.parse(value);
      if (Array.isArray(p)) return p.map(String);
    } catch {
      return value.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

// ── Display (read-only) ───────────────────────────────────────────────

export function CustomFieldDisplay({ def, value, full = false }: { def: CustomFieldDef; value: unknown; full?: boolean }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  const widget = def.custom_field;

  if (widget === "clawnify::score.score") {
    const min = Number(def.options.min ?? 0);
    const max = Number(def.options.max ?? 100);
    const n = Number(value);
    const pct = Math.max(0, Math.min(1, (n - min) / (max - min || 1)));
    const color = pct >= 0.7 ? "bg-success-solid" : pct >= 0.4 ? "bg-warning-solid" : "bg-destructive-solid";
    return (
      <span className="inline-flex items-center gap-2">
        <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <span className={cn("absolute inset-y-0 left-0 rounded-full", color)} style={{ width: `${pct * 100}%` }} />
        </span>
        <span className="tabular text-xs font-medium">{n}</span>
      </span>
    );
  }
  if (widget === "clawnify::badge.badge") return <Pill value={String(value)} />;
  if (widget === "clawnify::url.url" || widget === "clawnify::email.email" || widget === "clawnify::phone.phone") {
    const s = String(value);
    return (
      <a href={hrefFor(widget, s)} target={widget === "clawnify::url.url" ? "_blank" : undefined} rel="noreferrer"
        onClick={(e) => e.stopPropagation()} title={s}
        className="inline-flex max-w-[14rem] items-center gap-1 align-middle text-link hover:underline">
        <span className="truncate">{s}</span>
        {widget === "clawnify::url.url" && <ExternalLink className="size-3 shrink-0 opacity-60" />}
      </a>
    );
  }
  if (widget === "clawnify::tags.tags") {
    const tags = parseTags(value);
    if (tags.length === 0) return <span className="text-muted-foreground">—</span>;
    const shown = tags.slice(0, 2);
    const extra = tags.length - shown.length;
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap align-middle" title={tags.join(", ")}>
        {shown.map((t) => <Pill key={t} value={t} />)}
        {extra > 0 && <span className="shrink-0 text-xs text-muted-foreground">+{extra}</span>}
      </span>
    );
  }
  // Bare base types
  if (def.field_type === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  return <span title={String(value)} className="text-foreground">{String(value)}</span>;
}

function hrefFor(widget: string, raw: string): string {
  const v = raw.trim();
  if (widget === "clawnify::email.email") return `mailto:${v}`;
  if (widget === "clawnify::phone.phone") return `tel:${v.replace(/[^\d+]/g, "")}`;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

// ── Input (editable) ──────────────────────────────────────────────────

export function CustomFieldInput({
  def,
  value,
  onChange,
}: {
  def: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const widget = def.custom_field;

  if (widget === "clawnify::badge.badge" || def.field_type === "enumeration") {
    const vals = enumValues(def);
    const current = value == null ? "" : String(value);
    return (
      <Select value={current || undefined} onValueChange={onChange}>
        <SelectTrigger className="w-full"><SelectValue placeholder="Select…" /></SelectTrigger>
        <SelectContent>
          {vals.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }
  if (widget === "clawnify::score.score" || def.field_type === "integer" || def.field_type === "decimal") {
    return (
      <Input type="number" value={value == null ? "" : String(value)}
        step={def.field_type === "decimal" ? "any" : 1}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
    );
  }
  if (widget === "clawnify::tags.tags") {
    return <TagsInput value={value} onChange={onChange} />;
  }
  if (def.field_type === "boolean") {
    return (
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-input" />
    );
  }
  if (def.field_type === "date") {
    return <Input type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  }
  const type = widget === "clawnify::email.email" ? "email" : widget === "clawnify::url.url" ? "url" : widget === "clawnify::phone.phone" ? "tel" : "text";
  return <Input type={type} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
}

function TagsInput({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const tags = parseTags(value);
  const [draft, setDraft] = useState("");
  const commit = (next: string[]) => onChange(JSON.stringify(next));
  const add = (raw: string) => {
    const t = raw.trim();
    if (t && !tags.includes(t)) commit([...tags, t]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-sm px-2 py-1.5 shadow-edge">
      {tags.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">
          {t}
          <button type="button" onClick={() => commit(tags.filter((x) => x !== t))} aria-label={`Remove ${t}`} className="opacity-60 hover:opacity-100">
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); } else if (e.key === "Backspace" && !draft && tags.length) commit(tags.slice(0, -1)); }}
        onBlur={() => add(draft)} placeholder={tags.length ? "" : "Add a tag…"}
        className="min-w-[80px] flex-1 bg-transparent text-sm outline-none" />
    </div>
  );
}

// ── Dialog section (shared by every entity dialog) ────────────────────

/** Fields that need the full dialog width rather than a grid cell. */
function isFullWidth(def: CustomFieldDef): boolean {
  return def.custom_field === "clawnify::tags.tags" || def.field_type === "text";
}

/**
 * The "Custom" block rendered in an entity dialog: a 2-column grid matching the
 * built-in fields, with tags / long-text spanning full width. `values` is the
 * key→value map; `onChange(key, value)` updates one field.
 */
export function CustomFieldsSection({
  defs,
  values,
  onChange,
}: {
  defs: CustomFieldDef[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  if (defs.length === 0) return null;
  return (
    <>
      <div className="section-label">Custom</div>
      <div className="grid grid-cols-2 gap-3">
        {defs.map((def) => (
          <div key={def.id} className={cn("flex flex-col gap-1.5", isFullWidth(def) && "col-span-2")}>
            <Label>
              {def.label}
              {def.options.required === true && <span className="text-destructive"> *</span>}
            </Label>
            <CustomFieldInput def={def} value={values[def.key]} onChange={(v) => onChange(def.key, v)} />
          </div>
        ))}
      </div>
    </>
  );
}

// ── API helpers ───────────────────────────────────────────────────────

export const listCustomFieldsApi = (entity?: EntityType) =>
  api<{ defs: CustomFieldDef[] }>("GET", `/api/custom-fields${entity ? `?entity=${entity}` : ""}`);

export const createCustomField = (input: {
  entity_type: EntityType; key: string; label: string; field_type: AttributeType;
  custom_field?: string; options?: Record<string, unknown>; position?: number;
}) => api<{ def: CustomFieldDef }>("POST", "/api/custom-fields", input);

export const updateCustomField = (id: string, patch: Partial<Pick<CustomFieldDef, "label" | "custom_field" | "options" | "position">>) =>
  api<{ def: CustomFieldDef }>("PUT", `/api/custom-fields/${id}`, patch);

export const deleteCustomField = (id: string) =>
  api<{ ok: boolean }>("DELETE", `/api/custom-fields/${id}`);
