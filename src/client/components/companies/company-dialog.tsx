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
import { CustomFieldsSection, readCustom } from "@/lib/custom-fields";
import type { Company } from "@/types";

const INDUSTRIES = [
  "Technology",
  "Software",
  "Manufacturing",
  "Healthcare",
  "Finance",
  "Retail",
  "Education",
  "Consulting",
] as const;

// Radix Select forbids an empty-string item value, so we use a sentinel for the
// "None" industry option and map it back to "" on submit.
const NO_INDUSTRY = "__none__";

interface FormState {
  name: string;
  domain: string;
  industry: string;
  phone: string;
  email: string;
  notes: string;
}

function toForm(company?: Company): FormState {
  return {
    name: company?.name ?? "",
    domain: company?.domain ?? "",
    industry: company?.industry ?? "",
    phone: company?.phone ?? "",
    email: company?.email ?? "",
    notes: company?.notes ?? "",
  };
}

export function CompanyDialog({
  open,
  onOpenChange,
  company,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company?: Company;
}) {
  const { addCompany, updateCompany, setError, customFields } = useCrm();
  const companyFields = customFields.filter((d) => d.entity_type === "company");
  const [form, setForm] = useState<FormState>(() => toForm(company));
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  // Reset the form each time the dialog opens (create vs edit).
  useEffect(() => {
    if (open) {
      setForm(toForm(company));
      setCustom(Object.fromEntries(companyFields.map((d) => [d.key, readCustom(company, d.key) ?? ""])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, company]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const data: Partial<Company> = {
        name: form.name.trim(),
        domain: form.domain.trim(),
        industry: form.industry.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        notes: form.notes.trim(),
        custom,
      };
      if (company) await updateCompany(company.id, data);
      else await addCompany(data);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save company");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{company ? "Edit company" : "Add company"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="section-label">Company</div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" required value={form.name} onChange={(e) => set("name", e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="domain">Domain</Label>
              <Input
                id="domain"
                placeholder="example.com"
                value={form.domain}
                onChange={(e) => set("domain", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="industry">Industry</Label>
              <Select
                value={form.industry === "" ? NO_INDUSTRY : form.industry}
                onValueChange={(v) => set("industry", v === NO_INDUSTRY ? "" : v)}
              >
                <SelectTrigger id="industry" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_INDUSTRY}>None</SelectItem>
                  {INDUSTRIES.map((i) => (
                    <SelectItem key={i} value={i}>
                      {i}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </div>

          <CustomFieldsSection defs={companyFields} values={custom}
            onChange={(key, v) => setCustom((cst) => ({ ...cst, [key]: v }))} />

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" size="sm" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : company ? "Save" : "Add company"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
