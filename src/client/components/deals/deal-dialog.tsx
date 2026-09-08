import { useEffect, useState } from "react";
import { useCrm } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { api } from "@/api";
import { CustomFieldsSection, readCustom } from "@/lib/custom-fields";
import type { Deal } from "@/types";

// Radix Select forbids an empty-string item value, so we use a sentinel for the
// "None" contact option and map it back to null on submit.
const NO_CONTACT = "__none__";

interface FormState {
  name: string;
  contact_id: string;
  value: string;
  stage: string;
  close_date: string;
  notes: string;
}

function toForm(deal: Deal | undefined, defaultStage: string): FormState {
  return {
    name: deal?.name ?? "",
    contact_id: deal?.contact_id ?? "",
    value: deal?.value != null ? String(deal.value) : "",
    stage: deal?.stage || defaultStage,
    close_date: deal?.close_date ?? "",
    notes: deal?.notes ?? "",
  };
}

export function DealDialog({
  open,
  onOpenChange,
  deal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal;
}) {
  const { addDeal, updateDeal, setError, customFields, stages } = useCrm();
  const dealFields = customFields.filter((d) => d.entity_type === "deal");
  const [form, setForm] = useState<FormState>(() => toForm(deal, stages[0]?.key ?? ""));
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  // Reset the form each time the dialog opens (create vs edit).
  useEffect(() => {
    if (open) {
      setForm(toForm(deal, stages[0]?.key ?? ""));
      setCustom(Object.fromEntries(dealFields.map((d) => [d.key, readCustom(deal, d.key) ?? ""])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deal]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const data: Partial<Deal> = {
        name: form.name.trim(),
        contact_id: form.contact_id === "" ? null : form.contact_id,
        value: parseFloat(form.value) || 0,
        stage: form.stage,
        close_date: form.close_date,
        notes: form.notes.trim(),
        custom,
      };
      if (deal) await updateDeal(deal.id, data);
      else await addDeal(data);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save deal");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{deal ? "Edit deal" : "Add deal"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="section-label">Deal</div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" required value={form.name} onChange={(e) => set("name", e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contact">Contact</Label>
            <Combobox
              id="contact"
              value={form.contact_id === "" ? NO_CONTACT : form.contact_id}
              onChange={(v) => set("contact_id", v === NO_CONTACT ? "" : v)}
              placeholder="None"
              searchPlaceholder="Search contacts…"
              emptyText="No contacts found."
              options={[{ value: NO_CONTACT, label: "None" }]}
              valueLabel={
                deal ? `${deal.contact_first_name ?? ""} ${deal.contact_last_name ?? ""}`.trim() || undefined : undefined
              }
              onSearch={async (query) => {
                const { contacts } = await api<{ contacts: { id: string; first_name: string; last_name: string }[] }>(
                  "GET",
                  `/api/contacts?limit=20&search=${encodeURIComponent(query)}`,
                );
                return contacts.map((c) => ({ value: c.id, label: `${c.first_name} ${c.last_name}`.trim() || "—" }));
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="value">Value</Label>
              <Input
                id="value"
                type="number"
                min="0"
                step="any"
                value={form.value}
                onChange={(e) => set("value", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stage">Stage</Label>
              <Select value={form.stage} onValueChange={(v) => set("stage", v)}>
                <SelectTrigger id="stage" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="close_date">Close date</Label>
            <Input
              id="close_date"
              type="date"
              value={form.close_date}
              onChange={(e) => set("close_date", e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </div>

          <CustomFieldsSection defs={dealFields} values={custom}
            onChange={(key, v) => setCustom((cst) => ({ ...cst, [key]: v }))} />

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" size="sm" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : deal ? "Save" : "Add deal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
