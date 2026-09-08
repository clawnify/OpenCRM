import { useState } from "react";
import { Trash2, Plus, Search, Settings, GripVertical, MoreHorizontal, Pencil, Type as TypeIcon, Hash, Calendar, User, Link2, List, CircleDot } from "lucide-react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { useCrm } from "@/context";
import { PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  WIDGETS,
  BASE_TYPES,
  widgetMetaFor,
  createCustomField,
  updateCustomField,
  deleteCustomField,
} from "@/lib/custom-fields";
import type { AttributeType, CustomFieldDef, EntityType } from "@/types";

const ENTITIES: { key: EntityType; label: string }[] = [
  { key: "contact", label: "Contacts" },
  { key: "company", label: "Companies" },
  { key: "deal", label: "Deals" },
];

// Combined type picker: bare base types + custom widgets, each with a stable id.
const TYPE_OPTIONS = [
  ...BASE_TYPES.map((b) => ({ id: `base:${b.field_type}`, ...b })),
  ...WIDGETS.map((w) => ({ id: `widget:${w.uid}`, ...w })),
];

// ── Built-in (system) attributes per entity ───────────────────────────
// Static by design: a template's built-ins are fixed — they mirror schema.sql
// and the server's BUILTIN_COLUMNS. Shown alongside custom defs so the whole
// schema is legible in one table (the Attio "Attributes" pattern).

interface BuiltinAttr {
  label: string;
  key: string;
  type: string;
  icon: typeof TypeIcon;
  constraints?: string;
}

const BUILTINS: Record<EntityType, BuiltinAttr[]> = {
  contact: [
    { label: "First name", key: "first_name", type: "Text", icon: TypeIcon, constraints: "Required" },
    { label: "Last name", key: "last_name", type: "Text", icon: TypeIcon },
    { label: "Email", key: "email", type: "Text", icon: TypeIcon },
    { label: "Phone", key: "phone", type: "Text", icon: TypeIcon },
    { label: "Company", key: "company_id", type: "Record", icon: Link2 },
    { label: "Title", key: "title", type: "Text", icon: TypeIcon },
    { label: "Status", key: "status", type: "Status", icon: CircleDot, constraints: "Required" },
    { label: "Created at", key: "created_at", type: "Timestamp", icon: Calendar },
  ],
  company: [
    { label: "Name", key: "name", type: "Text", icon: TypeIcon, constraints: "Required" },
    { label: "Domain", key: "domain", type: "Text", icon: Link2 },
    { label: "Industry", key: "industry", type: "Text", icon: TypeIcon },
    { label: "Phone", key: "phone", type: "Text", icon: TypeIcon },
    { label: "Email", key: "email", type: "Text", icon: TypeIcon },
    { label: "Notes", key: "notes", type: "Long text", icon: List },
    { label: "Created at", key: "created_at", type: "Timestamp", icon: Calendar },
  ],
  deal: [
    { label: "Name", key: "name", type: "Text", icon: TypeIcon, constraints: "Required" },
    { label: "Contact", key: "contact_id", type: "Record", icon: User },
    { label: "Value", key: "value", type: "Number", icon: Hash },
    { label: "Stage", key: "stage", type: "Status", icon: CircleDot, constraints: "Required" },
    { label: "Close date", key: "close_date", type: "Date", icon: Calendar },
    { label: "Notes", key: "notes", type: "Long text", icon: List },
    { label: "Created at", key: "created_at", type: "Timestamp", icon: Calendar },
  ],
};

export function PropertiesPage() {
  const { customFields, refetchCustomFields, setError } = useCrm();
  const [entity, setEntity] = useState<EntityType>("contact");

  return (
    <>
      <PageHeader title="Attributes" />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <p className="mb-4 max-w-xl text-sm text-muted-foreground">
          Every field on your records — built-in system attributes plus the custom ones you add. Custom
          attributes are real, typed columns and work with an empty database.
        </p>
        <Tabs value={entity} onValueChange={(v) => setEntity(v as EntityType)}>
          <TabsList>
            {ENTITIES.map((e) => (
              <TabsTrigger key={e.key} value={e.key}>{e.label}</TabsTrigger>
            ))}
          </TabsList>
          {ENTITIES.map((e) => (
            <TabsContent key={e.key} value={e.key} className="mt-4">
              <EntityAttributes
                entity={e.key}
                defs={customFields.filter((d) => d.entity_type === e.key)}
                onChanged={refetchCustomFields}
                onError={(m) => setError(m)}
              />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </>
  );
}

function SystemBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
      <Settings className="size-3" />
      System
    </span>
  );
}

function EntityAttributes({
  entity,
  defs,
  onChanged,
  onError,
}: {
  entity: EntityType;
  defs: CustomFieldDef[];
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<CustomFieldDef | null>(null);
  // Optimistic row order (def ids) while a drag's position writes are in
  // flight; null = trust the server order (defs arrive sorted by position).
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomFieldDef | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // A destructive action confirms in a dialog that names the object, never window.confirm.
  const remove = (def: CustomFieldDef) => setDeleteTarget(def);
  const confirmRemove = async () => {
    const def = deleteTarget;
    if (!def) return;
    setDeleteTarget(null);
    try {
      await deleteCustomField(def.id);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete attribute");
    }
  };

  const needle = q.trim().toLowerCase();
  const matches = (label: string, key: string) =>
    !needle || label.toLowerCase().includes(needle) || key.toLowerCase().includes(needle);

  const builtins = BUILTINS[entity].filter((b) => matches(b.label, b.key));
  const ordered = localOrder
    ? localOrder.map((id) => defs.find((d) => d.id === id)).filter((d): d is CustomFieldDef => !!d)
    : defs;
  const customs = ordered.filter((d) => matches(d.label, d.key));
  // Reordering a filtered subset is ambiguous — drag only with no search.
  const canDrag = !needle;

  const onDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = ordered.map((d) => d.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    setLocalOrder(next);
    try {
      // Persist index → position for every def whose position changed.
      const byId = new Map(defs.map((d) => [d.id, d]));
      await Promise.all(
        next.map((id, i) => (byId.get(id)!.position !== i ? updateCustomField(id, { position: i }) : null)),
      );
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to reorder attributes");
    } finally {
      setLocalOrder(null);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search attributes" className="pl-8" />
      </div>

      <div className="overflow-hidden rounded-md shadow-edge">
        <DndContext sensors={sensors} collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Constraints</TableHead>
                <TableHead>Properties</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {builtins.map((b) => (
                <TableRow key={b.key}>
                  <TableCell />
                  <TableCell>
                    <span className="inline-flex items-center gap-2 font-medium">
                      <b.icon className="size-4 shrink-0 text-muted-foreground" />
                      {b.label}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{b.type}</TableCell>
                  <TableCell className="text-muted-foreground">{b.constraints ?? ""}</TableCell>
                  <TableCell><SystemBadge /></TableCell>
                  <TableCell />
                </TableRow>
              ))}
              <SortableContext items={customs.map((d) => d.id)} strategy={verticalListSortingStrategy}>
                {customs.map((def) => (
                  <SortableAttrRow key={def.id} def={def} canDrag={canDrag}
                    onEdit={() => setEditing(def)} onRemove={() => remove(def)} />
                ))}
              </SortableContext>
              {builtins.length === 0 && customs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                    No attributes match "{q}".
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </DndContext>
      </div>

      <AddAttribute entity={entity} existingKeys={defs.map((d) => d.key)} onChanged={onChanged} onError={onError} />

      <EditAttribute def={editing} onClose={() => setEditing(null)} onChanged={onChanged} onError={onError} />

      {deleteTarget && (
        <Dialog open onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete "{deleteTarget.label}"?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">This removes the column and its values for every {entity}. It cannot be undone.</p>
            <DialogFooter>
              <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
              <Button variant="destructive" onClick={confirmRemove}>Delete attribute</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** A draggable custom-attribute row. Only the grip handle starts a drag, so
 *  the row menu and text selection keep working normally. */
function SortableAttrRow({ def, canDrag, onEdit, onRemove }: { def: CustomFieldDef; canDrag: boolean; onEdit: () => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: def.id,
    disabled: !canDrag,
  });
  const w = widgetMetaFor(def);
  const base = BASE_TYPES.find((b) => b.field_type === def.field_type);
  const Icon = w?.icon ?? base?.icon ?? TypeIcon;
  const typeLabel = w?.label ?? base?.label ?? def.field_type;
  return (
    <TableRow
      ref={setNodeRef}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
      className={isDragging ? "relative z-10 bg-secondary" : undefined}
    >
      <TableCell>
        {canDrag && (
          <button type="button" {...attributes} {...listeners} aria-label={`Reorder ${def.label}`}
            className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing">
            <GripVertical className="size-4" />
          </button>
        )}
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-2 font-medium">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          {def.label}
          <span className="font-mono text-xs font-normal text-muted-foreground">{def.key}</span>
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">{typeLabel}</TableCell>
      <TableCell className="text-muted-foreground">{def.options.required === true ? "Required" : ""}</TableCell>
      <TableCell />
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button aria-label={`Actions for ${def.label}`}
              className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="size-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRemove} className="text-destructive focus:text-destructive">
              <Trash2 className="size-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

/** Edit dialog for a custom attribute. Key and type are immutable (they map to
 *  a real column); label, required, and widget options are editable. */
function EditAttribute({
  def,
  onClose,
  onChanged,
  onError,
}: {
  def: CustomFieldDef | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [required, setRequired] = useState(false);
  const [enumText, setEnumText] = useState("");
  const [min, setMin] = useState("0");
  const [max, setMax] = useState("100");
  const [busy, setBusy] = useState(false);
  // Seed form state when a def is selected (dialog opens).
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (def && seededFor !== def.id) {
    setSeededFor(def.id);
    setLabel(def.label);
    setRequired(def.options.required === true);
    setEnumText(Array.isArray(def.options.enum) ? (def.options.enum as unknown[]).map(String).join("\n") : "");
    setMin(String(def.options.min ?? 0));
    setMax(String(def.options.max ?? 100));
  }
  if (!def) return null;

  const isEnum = def.field_type === "enumeration";
  const isScore = def.custom_field === "clawnify::score.score";

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const options: Record<string, unknown> = { ...def.options };
    if (required) options.required = true; else delete options.required;
    if (isEnum) options.enum = enumText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (isScore) { options.min = Number(min) || 0; options.max = Number(max) || 100; }
    setBusy(true);
    try {
      await updateCustomField(def.id, { label: label.trim() || def.label, options });
      await onChanged();
      setSeededFor(null);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update attribute");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) { setSeededFor(null); onClose(); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit attribute</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-label">Label</Label>
            <Input id="edit-label" value={label} onChange={(e) => setLabel(e.target.value)} />
            <span className="font-mono text-xs text-muted-foreground">{def.key} · {def.field_type} (immutable)</span>
          </div>

          {isEnum && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-enum">Values (one per line)</Label>
              <textarea id="edit-enum" value={enumText} onChange={(e) => setEnumText(e.target.value)}
                className="min-h-[80px] rounded-sm bg-card px-2 py-1.5 font-mono text-sm shadow-edge" />
            </div>
          )}
          {isScore && (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5"><Label htmlFor="edit-min">Min</Label>
                <Input id="edit-min" type="number" value={min} onChange={(e) => setMin(e.target.value)} /></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="edit-max">Max</Label>
                <Input id="edit-max" type="number" value={max} onChange={(e) => setMax(e.target.value)} /></div>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)}
              className="size-4 rounded border-input" />
            Required — records can't be created without a value
          </label>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" size="sm" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([0-9])/, "f_$1");
}

function AddAttribute({
  entity,
  existingKeys,
  onChanged,
  onError,
}: {
  entity: EntityType;
  existingKeys: string[];
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [typeId, setTypeId] = useState(TYPE_OPTIONS[0].id);
  const [enumText, setEnumText] = useState("");
  const [min, setMin] = useState("0");
  const [max, setMax] = useState("100");
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);

  const selected = TYPE_OPTIONS.find((t) => t.id === typeId)!;
  const key = slugify(label);
  const isEnum = selected.field_type === "enumeration";
  const isScore = selected.uid === "clawnify::score.score";
  const dupKey = existingKeys.includes(key);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !key || dupKey) return;
    const options: Record<string, unknown> = {};
    if (isEnum) options.enum = enumText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (isScore) { options.min = Number(min) || 0; options.max = Number(max) || 100; }
    if (required) options.required = true;
    setBusy(true);
    try {
      await createCustomField({
        entity_type: entity,
        key,
        label: label.trim(),
        field_type: selected.field_type as AttributeType,
        custom_field: selected.uid,
        options,
        position: existingKeys.length, // append after existing attributes
      });
      setLabel(""); setEnumText(""); setTypeId(TYPE_OPTIONS[0].id); setRequired(false);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create attribute");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md p-4 shadow-edge">
      <div className="section-label">New attribute</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="prop-label">Label</Label>
          <Input id="prop-label" value={label} placeholder="Fit Score" onChange={(e) => setLabel(e.target.value)} />
          {key && <span className="font-mono text-xs text-muted-foreground">{key}{dupKey && " — already exists"}</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Type</Label>
          <Select value={typeId} onValueChange={setTypeId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  <span className="inline-flex items-center gap-2"><t.icon className="size-3.5 opacity-60" />{t.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isEnum && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="prop-enum">Values (one per line)</Label>
          <textarea id="prop-enum" value={enumText} onChange={(e) => setEnumText(e.target.value)}
            placeholder={"Immediate\nStrong\nMonitor"}
            className="min-h-[80px] rounded-sm bg-card px-2 py-1.5 font-mono text-sm shadow-edge" />
        </div>
      )}
      {isScore && (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5"><Label htmlFor="prop-min">Min</Label>
            <Input id="prop-min" type="number" value={min} onChange={(e) => setMin(e.target.value)} /></div>
          <div className="flex flex-col gap-1.5"><Label htmlFor="prop-max">Max</Label>
            <Input id="prop-max" type="number" value={max} onChange={(e) => setMax(e.target.value)} /></div>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)}
          className="size-4 rounded border-input" />
        Required — records can't be created without a value
      </label>

      <Button type="submit" size="sm" disabled={busy || !label.trim() || !key || dupKey} className="gap-1.5">
        <Plus className="size-3.5" /> {busy ? "Adding…" : "Add attribute"}
      </Button>
    </form>
  );
}
