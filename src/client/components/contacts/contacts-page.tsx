import { useEffect, useState } from "react";
import { Search, Upload, Plus, Trash2, Download, X } from "lucide-react";
import { useCrm } from "@/context";
import { PageHeader, Avatar, EntityIcon, CategoryBadge, EmptyState } from "@/components/shared";
import { ConnectionsIndicator } from "@/components/connections-indicator";
import { ContactDialog, STATUSES } from "@/components/contacts/contact-dialog";
import { FilterBar } from "@/components/filter-bar";
import { fieldsFromDefs, sanitize } from "@/lib/filters";
import { useListView } from "@/hooks/use-list-view";
import { ViewSwitcher } from "@/components/view-switcher";
import { withQuery } from "@/hooks/use-router";
import { ImportDialog } from "@/components/import-dialog";
import { RecordTable, columnKind, type NameColumn, type RecordColumn } from "@/components/record-table";
import { contactImportConfig } from "@/lib/import-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { CustomFieldDisplay, readCustom } from "@/lib/custom-fields";
import { relationColumn } from "@/lib/relations";
import { customFieldCopy, customFieldEdit, optionEdit, recordEdit, textEdit } from "@/components/cell-editors";
import { useTableView, useAggregates, listFilterQuery } from "@/hooks/use-table-view";
import { downloadCsv, exportViewCsv } from "@/lib/csv";
import type { Contact } from "@/types";

const dash = <span className="text-muted-foreground">—</span>;
const fullName = (c: Contact) => `${c.first_name} ${c.last_name}`.trim();

// `openId` is the contact in the side panel beside the table, if any. Opening
// another row swaps the panel's record in place of stacking history.
// `viewParam` is the named view to show (absent: the default); `filtersParam`
// a link's `?filters=`, read once (see useListView).
export function ContactsPage({ navigate, openId, viewParam, filtersParam }: { navigate: (to: string, opts?: { replace?: boolean }) => void; openId?: string; viewParam?: string; filtersParam?: string }) {
  const { contacts, contactsPag, stats, setContactsPage, setContactsSort, setContactsSearch, setContactsFilters, setContactsView, deleteContacts, updateContact, customFields, setError } = useCrm();
  const contactFields = customFields.filter((d) => d.entity_type === "contact");
  const filterFields = fieldsFromDefs(
    [
      { key: "first_name", label: "First name", type: "text", column: "name" },
      { key: "last_name", label: "Last name", type: "text", column: "name" },
      { key: "email", label: "Email", type: "text", column: "email" },
      { key: "phone", label: "Phone", type: "text", column: "phone" },
      { key: "company_id", label: "Company", type: "relation", entity: "company", column: "company" },
      { key: "deals", label: "Deals", type: "relation", entity: "deal" },
      { key: "title", label: "Title", type: "text", column: "title" },
      { key: "status", label: "Status", type: "enum", column: "status", options: STATUSES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) })) },
      { key: "created_at", label: "Created", type: "date" },
    ],
    contactFields,
  );
  const view = useTableView("contact", viewParam, { name: 220, email: 220, phone: 150, company: 180, title: 180, status: 130 });
  const listView = useListView({ entity: "contact", table: view, filtersParam, pag: contactsPag, setFilters: setContactsFilters, setView: setContactsView, navigate });

  const name: NameColumn<Contact> = {
    label: "Name",
    sort: "first_name",
    href: (c) => `/contacts?record=${encodeURIComponent(c.id)}`,
    text: fullName,
    render: (c) => (
      <>
        <Avatar firstName={c.first_name} lastName={c.last_name} className="size-5 text-[0.5625rem]" />
        <span className="truncate">{fullName(c) || "—"}</span>
      </>
    ),
  };
  // A cell edited in place saves its one field; the list refetches.
  const saveCell = async (c: Contact, patch: Record<string, unknown>) => {
    try {
      await updateContact(c.id, patch as Partial<Contact>);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };
  const columns: RecordColumn<Contact>[] = [
    {
      key: "email", label: "Email", sort: "email", text: (c) => c.email, edit: textEdit("email", saveCell, { input: "email" }), copy: (c) => c.email,
      render: (c) => c.email
        ? <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()} className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground">{c.email}</a>
        : dash,
    },
    { key: "phone", label: "Phone", sort: "phone", text: (c) => c.phone, edit: textEdit("phone", saveCell, { input: "tel" }), copy: (c) => c.phone, render: (c) => c.phone ? <span className="tabular">{c.phone}</span> : dash },
    {
      key: "company", label: "Company", sort: "company_id", text: (c) => c.company_name ?? "", edit: recordEdit("company_id", "company", "Company", saveCell),
      render: (c) => c.company_name
        ? <span className="flex min-w-0 items-center gap-2"><EntityIcon name={c.company_name} domain={c.company_domain} className="size-5" /><span className="truncate">{c.company_name}</span></span>
        : dash,
    },
    { key: "title", label: "Title", sort: "title", text: (c) => c.title, edit: textEdit("title", saveCell), render: (c) => c.title || dash },
    {
      key: "status", label: "Status", sort: "status", text: (c) => c.status,
      edit: optionEdit("status", STATUSES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) })), saveCell),
      render: (c) => <CategoryBadge value={c.status} />,
    },
    ...contactFields.map((def): RecordColumn<Contact> => def.field_type === "relation" ? { ...relationColumn<Contact>(def), edit: customFieldEdit(def, saveCell, customFields) } : ({
      key: def.key, label: def.label, sort: def.key, kind: columnKind(def.field_type), edit: customFieldEdit(def, saveCell, customFields), copy: customFieldCopy(def),
      text: (c) => String(readCustom(c, def.key) ?? ""),
      render: (c) => <CustomFieldDisplay def={def} value={readCustom(c, def.key)} />,
    })),
  ];

  const [search, setSearch] = useState(contactsPag.search);
  const [importOpen, setImportOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Debounce the search box → server-side filter.
  useEffect(() => {
    const t = setTimeout(() => setContactsSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  // The selection holds only rows on screen: paging, searching or deleting drops the rest.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(contacts.filter((c) => prev.has(c.id)).map((c) => c.id));
      return next.size === prev.size ? prev : next;
    });
  }, [contacts]);

  // The footer totals, for the columns (and name) that have a calculation set.
  const totals = useAggregates(
    "/api/contacts/aggregates",
    listFilterQuery(contactsPag),
    ["name", ...columns.map((c) => c.key)].flatMap((key) => { const op = view.aggregate(key); return op ? [{ key, op }] : []; }),
    contacts,
  );

  const openRecord = (id: string) => navigate(withQuery({ record: id }), { replace: !!openId });
  const totalPages = Math.max(1, Math.ceil(contactsPag.total / contactsPag.limit));

  const addButton = (
    <Button size="sm" onClick={() => setDialogOpen(true)}>
      <Plus className="size-4" />
      Add contact
    </Button>
  );

  const exportSelected = () => {
    const rows = contacts.filter((c) => selected.has(c.id));
    const shown = columns.filter((c) => view.visible(c.key));
    downloadCsv("contacts.csv", [name.label, ...shown.map((c) => c.label)], rows.map((r) => [name.text(r), ...shown.map((c) => c.text(r))]));
  };

  const confirmDelete = async () => {
    const ids = [...selected];
    setDeleting(true);
    try {
      await deleteContacts(ids);
      setConfirmOpen(false);
      if (openId && ids.includes(openId)) navigate(withQuery({ record: null }), { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Contacts" count={stats.contacts}>
        {selected.size > 0 ? (
          <>
            <span className="tabular text-[0.8125rem] text-muted-foreground">{selected.size} selected</span>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              <X className="size-4" />
              Clear
            </Button>
            <Button size="sm" variant="secondary" onClick={exportSelected}>
              <Download className="size-4" />
              Export
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setConfirmOpen(true)}>
              <Trash2 className="size-4" />
              Delete
            </Button>
          </>
        ) : (
          <>
            <ConnectionsIndicator />
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search contacts…"
                aria-label="Search contacts"
                className="h-7 w-56 pl-8"
              />
            </div>
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="size-4" />
              Import
            </Button>
            {addButton}
          </>
        )}
      </PageHeader>
      <FilterBar
        leading={
          <ViewSwitcher
            views={listView.views}
            current={listView.view}
            count={contactsPag.total}
            onOpen={listView.open}
            onCreate={listView.create}
            onRename={listView.rename}
            onDelete={listView.remove}
            onExport={(v) => exportViewCsv<Contact>({ view: v, listPath: "/api/contacts", rowsKey: "contacts", name, columns }).catch((e) => setError(e instanceof Error ? e.message : "Could not export"))}
          />
        }
        fields={filterFields}
        filters={listView.filters}
        onChange={listView.setFilters}
        isVisible={view.visible}
        dirty={listView.dirty}
        onSave={listView.update}
        locked={listView.locked}
        onSaveAs={listView.create}
        onReset={listView.reset}
      />

      {/* The first-run empty state is for an empty list, not a filtered one. */}
      {contacts.length === 0 && !contactsPag.search && sanitize(listView.filters).length === 0 ? (
        <EmptyState
          title="No contacts yet. Add your first, or import a CSV/XLSX."
          action={
            <div className="flex flex-col items-center gap-2">
              {addButton}
              <button
                onClick={() => navigate("/settings/properties")}
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Set up properties
              </button>
            </div>
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <RecordTable
              rows={contacts}
              name={name}
              columns={columns}
              view={view}
              sorting={contactsPag}
              onSort={setContactsSort}
              openId={openId}
              onOpen={openRecord}
              selected={selected}
              onSelectedChange={setSelected}
              onCustomize={() => navigate("/settings/properties")}
              totals={totals}
              onAdd={() => setDialogOpen(true)}
            />
          </div>

          <footer className="flex items-center justify-between border-t border-border px-6 py-3">
            <span className="tabular text-[0.8125rem] text-muted-foreground">
              Page {contactsPag.page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={contactsPag.page <= 1}
                onClick={() => setContactsPage(contactsPag.page - 1)}
                aria-label="Previous page"
              >
                Prev
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={contactsPag.page >= totalPages}
                onClick={() => setContactsPage(contactsPag.page + 1)}
                aria-label="Next page"
              >
                Next
              </Button>
            </div>
          </footer>
        </div>
      )}

      <ContactDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} config={contactImportConfig} />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {selected.size === 1 ? "contact" : `${selected.size} contacts`}?</DialogTitle>
            <DialogDescription>
              {selected.size === 1 ? "It" : "They"} will be permanently removed. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="sm" variant="ghost">Cancel</Button>
            </DialogClose>
            <Button size="sm" variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
