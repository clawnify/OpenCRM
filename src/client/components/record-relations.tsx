import { useEffect, useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import { useCrm } from "@/context";
import { Attr, DetailsSection } from "@/components/record-page";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RecordChip, RecordPicker, RelationInput } from "@/lib/relations";
import { api } from "@/api";
import type { CustomFieldDef, EntityType, RelationRecord, RelationValue } from "@/types";

const API_PATH: Record<EntityType, string> = { contact: "contacts", company: "companies", deal: "deals" };

type Row = { id: string; relations?: Record<string, RelationValue> };

/** Links record `id` of `entity` to `parent` (or unlinks it, with null) by writing its many_to_one field. */
export function linkRecord(entity: EntityType, id: string, inverseKey: string, parent: string | null) {
  return api("PUT", `/api/${API_PATH[entity]}/${encodeURIComponent(id)}`, { [inverseKey]: parent });
}

/**
 * The records on a one_to_many side, to link and unlink from a picker that
 * stays open: every linked record highlighted, a pick toggles it. Reads the
 * parent once for its full list (a list row only carries the first few).
 */
export function ManyPicker({ parentEntity, parentId, def, inverseKey }: {
  parentEntity: EntityType;
  parentId: string;
  def: CustomFieldDef;
  inverseKey: string;
}) {
  const { setError, recordsChanged } = useCrm();
  const [linked, setLinked] = useState<string[] | null>(null);
  useEffect(() => {
    api<Record<string, Row>>("GET", `/api/${API_PATH[parentEntity]}/${encodeURIComponent(parentId)}`).then((data) => {
      const v = Object.values(data)[0]?.relations?.[def.key];
      setLinked(v && "items" in v ? v.items.map((r) => r.id) : []);
    }, () => setLinked([]));
  }, [parentEntity, parentId, def.key]);

  const toggle = async (id: string) => {
    const on = linked?.includes(id);
    setLinked((l) => (on ? (l ?? []).filter((x) => x !== id) : [...(l ?? []), id]));
    try {
      await linkRecord(def.target_entity!, id, inverseKey, on ? null : parentId);
      await recordsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };

  if (!linked) return <div className="py-4 text-center text-[13px] text-muted-foreground">Loading…</div>;
  return <RecordPicker entity={def.target_entity!} selected={linked} creatable onPick={(r) => void toggle(r.id)} />;
}

/** A record's many_to_one relations as attribute rows: the linked record is the control. */
export function RelationAttrs({ defs, row, onSave }: {
  defs: CustomFieldDef[];
  row: Row;
  onSave: (key: string, id: string | null) => Promise<void>;
}) {
  return (
    <>
      {defs.filter((d) => d.relation_type === "many_to_one" && d.target_entity).map((def) => (
        <Attr key={def.id} icon={Link2} label={def.label}>
          <RelationInput
            entity={def.target_entity!}
            value={(row as unknown as Record<string, unknown>)[def.key] as string | null ?? null}
            known={row.relations?.[def.key] as RelationRecord | null | undefined}
            placeholder={`Set ${def.label.toLowerCase()}…`}
            emptyLabel={`No ${def.label.toLowerCase()}`}
            onChange={(id) => void onSave(def.key, id)}
          />
        </Attr>
      ))}
    </>
  );
}

/**
 * A record's one_to_many relations, one section each: the linked records as
 * chips, "+" to link another (it moves from whatever it was linked to), and
 * × to unlink one. Linking writes the other record's many_to_one field.
 */
export function RelationSections({ defs, row }: {
  defs: CustomFieldDef[];
  row: Row;
}) {
  const { customFields } = useCrm();
  return (
    <>
      {defs.filter((d) => d.relation_type === "one_to_many" && d.target_entity).map((def) => {
        const inverse = customFields.find((d) => d.id === def.inverse_def_id);
        return inverse && <ManySection key={def.id} def={def} inverseKey={inverse.key} row={row} />;
      })}
    </>
  );
}

function ManySection({ def, inverseKey, row }: { def: CustomFieldDef; inverseKey: string; row: Row }) {
  const { setError, recordsChanged } = useCrm();
  const [open, setOpen] = useState(false);
  const entity = def.target_entity!;
  const value = row.relations?.[def.key];
  const list = value && "items" in value ? value : { items: [], total: 0 };
  const linked = list.items.map((r) => r.id);

  const link = async (id: string, parent: string | null) => {
    try {
      await linkRecord(entity, id, inverseKey, parent);
      await recordsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };

  return (
    <DetailsSection
      title={list.total ? `${def.label} · ${list.total}` : def.label}
      action={
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" aria-label={`Link ${def.label.toLowerCase()}`} className="inline-flex size-6 items-center justify-center rounded-xs hover:bg-secondary hover:text-foreground">
              <Plus className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64">
            <RecordPicker entity={entity} selected={linked} creatable onPick={(r) => void link(r.id, linked.includes(r.id) ? null : row.id)} />
          </PopoverContent>
        </Popover>
      }
    >
      {list.items.length === 0 ? (
        <p className="py-1 text-sm text-faint">No {def.label.toLowerCase()}</p>
      ) : (
        <ul className="flex flex-col">
          {list.items.map((r) => (
            <li key={r.id} className="group/rel flex h-8 items-center justify-between gap-2">
              <RecordChip entity={entity} record={r} />
              <button
                type="button"
                onClick={() => void link(r.id, null)}
                aria-label={`Unlink ${r.label}`}
                className="inline-flex size-6 items-center justify-center rounded-xs text-muted-foreground opacity-0 hover:bg-secondary hover:text-foreground focus-visible:opacity-100 group-hover/rel:opacity-100 [[data-agent]_&]:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.total > list.items.length && <p className="py-1 text-xs text-muted-foreground">and {list.total - list.items.length} more</p>}
    </DetailsSection>
  );
}
