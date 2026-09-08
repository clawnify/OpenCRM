import { useEffect, useState } from "react";
import { useCrm } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { Contact } from "@/types";

const STATUSES = ["lead", "active", "inactive", "churned"] as const;

// Radix Select forbids an empty-string item value, so we use a sentinel for the
// "None" company option and map it back to null on submit.
const NO_COMPANY = "__none__";

interface FormState {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company_id: string;
  title: string;
  status: string;
}

function toForm(contact?: Contact): FormState {
  return {
    first_name: contact?.first_name ?? "",
    last_name: contact?.last_name ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    company_id: contact?.company_id ?? "",
    title: contact?.title ?? "",
    status: contact?.status || "lead",
  };
}

export function ContactDialog({
  open,
  onOpenChange,
  contact,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact;
}) {
  const { addContact, updateContact, setError, customFields } = useCrm();
  const contactFields = customFields.filter((d) => d.entity_type === "contact");
  const [form, setForm] = useState<FormState>(() => toForm(contact));
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  // Reset the form each time the dialog opens (create vs edit).
  useEffect(() => {
    if (open) {
      setForm(toForm(contact));
      setCustom(Object.fromEntries(contactFields.map((d) => [d.key, readCustom(contact, d.key) ?? ""])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const data: Partial<Contact> = {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        company_id: form.company_id === "" ? null : form.company_id,
        title: form.title.trim(),
        status: form.status,
        custom,
      };
      if (contact) await updateContact(contact.id, data);
      else await addContact(data);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save contact");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{contact ? "Edit contact" : "Add contact"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="section-label">Contact</div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="first_name">First name</Label>
              <Input
                id="first_name"
                required
                value={form.first_name}
                onChange={(e) => set("first_name", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="last_name">Last name</Label>
              <Input id="last_name" value={form.last_name} onChange={(e) => set("last_name", e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="company">Company</Label>
              <Combobox
                id="company"
                value={form.company_id === "" ? NO_COMPANY : form.company_id}
                onChange={(v) => set("company_id", v === NO_COMPANY ? "" : v)}
                placeholder="None"
                searchPlaceholder="Search companies…"
                emptyText="No companies found."
                options={[{ value: NO_COMPANY, label: "None" }]}
                valueLabel={contact?.company_name ?? undefined}
                onSearch={async (query) => {
                  const { companies } = await api<{ companies: { id: string; name: string }[] }>(
                    "GET",
                    `/api/companies?limit=20&search=${encodeURIComponent(query)}`,
                  );
                  return companies.map((co) => ({ value: co.id, label: co.name }));
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="title">Title</Label>
              <Input id="title" value={form.title} onChange={(e) => set("title", e.target.value)} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="status">Status</Label>
            <Select value={form.status} onValueChange={(v) => set("status", v)}>
              <SelectTrigger id="status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <CustomFieldsSection defs={contactFields} values={custom}
            onChange={(key, v) => setCustom((c) => ({ ...c, [key]: v }))} />

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" size="sm" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : contact ? "Save" : "Add contact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
