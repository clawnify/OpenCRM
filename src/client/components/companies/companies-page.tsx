import { useEffect, useState } from "react";
import { Search, Plus, Upload, Trash2, Download, X, ExternalLink } from "lucide-react";
import { useCrm } from "@/context";
import { PageHeader, EntityIcon, CategoryBadge, EmptyState } from "@/components/shared";
import { CompanyDialog } from "@/components/companies/company-dialog";
import { FilterBar } from "@/components/filter-bar";
import { fieldsFromDefs, sanitize } from "@/lib/filters";
import { useListView } from "@/hooks/use-list-view";
import { ViewSwitcher } from "@/components/view-switcher";
import { withQuery } from "@/hooks/use-router";
import { ImportDialog } from "@/components/import-dialog";
import { RecordTable, columnKind, type NameColumn, type RecordColumn } from "@/components/record-table";
import { companyImportConfig } from "@/lib/import-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { CustomFieldDisplay, readCustom } from "@/lib/custom-fields";
import { relationColumn } from "@/lib/relations";
import { customFieldCopy, customFieldEdit, textEdit, valuesEdit } from "@/components/cell-editors";
import { useTableView, useAggregates, listFilterQuery } from "@/hooks/use-table-view";
import { downloadCsv } from "@/lib/csv";
import type { Company } from "@/types";

const dash = <span className="text-muted-foreground">—</span>;

// `openId`, `viewParam` and `filtersParam` as ContactsPage.
export function CompaniesPage({ navigate, openId, viewParam, filtersParam }: { navigate: (to: string, opts?: { replace?: boolean }) => void; openId?: string; viewParam?: string; filtersParam?: string }) {
  const { companies, companiesPag, stats, setCompaniesPage, setCompaniesSort, setCompaniesSearch, setCompaniesFilters, setCompaniesView, deleteCompanies, updateCompany, customFields, setError } = useCrm();
  const companyFields = customFields.filter((d) => d.entity_type === "company");
  const filterFields = fieldsFromDefs(
    [
      { key: "name", label: "Name", type: "text", column: "name" },
      { key: "domain", label: "Domain", type: "text", column: "domain" },
      { key: "industry", label: "Industry", type: "text", column: "industry" },
      { key: "phone", label: "Phone", type: "text" },
      { key: "email", label: "Email", type: "text" },
      { key: "created_at", label: "Created", type: "date" },
    ],
    companyFields,
  );
  const view = useTableView("company", viewParam, { name: 220, domain: 180, industry: 160, contacts: 112 });
  const listView = useListView({ entity: "company", table: view, filtersParam, pag: companiesPag, setFilters: setCompaniesFilters, setView: setCompaniesView, navigate });

  const name: NameColumn<Company> = {
    label: "Name",
    sort: "name",
    href: (c) => `/companies?record=${encodeURIComponent(c.id)}`,
    text: (c) => c.name,
    render: (c) => (
      <>
        <EntityIcon name={c.name} domain={c.domain} className="size-5" />
        <span className="truncate">{c.name || "—"}</span>
      </>
    ),
  };
  // A cell edited in place saves its one field; the list refetches.
  const saveCell = async (c: Company, patch: Record<string, unknown>) => {
    try {
      await updateCompany(c.id, patch as Partial<Company>);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };
  const columns: RecordColumn<Company>[] = [
    {
      key: "domain", label: "Domain", sort: "domain", text: (c) => c.domain, edit: textEdit("domain", saveCell),
      render: (c) => c.domain
        ? (
          <a
            href={/^https?:\/\//i.test(c.domain) ? c.domain : `https://${c.domain}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex max-w-full items-center gap-1 align-middle text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
          >
            <span className="truncate">{c.domain.replace(/^https?:\/\//i, "").replace(/\/$/, "")}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        )
        : dash,
    },
    { key: "industry", label: "Industry", sort: "industry", text: (c) => c.industry, edit: valuesEdit("company", "industry", "Industry", saveCell), render: (c) => <CategoryBadge value={c.industry} /> },
    ...companyFields.map((def): RecordColumn<Company> => def.field_type === "relation" ? { ...relationColumn<Company>(def), edit: customFieldEdit(def, saveCell, customFields) } : ({
      key: def.key, label: def.label, sort: def.key, kind: columnKind(def.field_type), edit: customFieldEdit(def, saveCell, customFields), copy: customFieldCopy(def),
      text: (c) => String(readCustom(c, def.key) ?? ""),
      render: (c) => <CustomFieldDisplay def={def} value={readCustom(c, def.key)} />,
    })),
    {
      key: "contacts", label: "Contacts", align: "right", kind: "number", text: (c) => String(c.contact_count ?? 0),
      render: (c) => <span className="tabular">{c.contact_count ?? 0}</span>,
    },
  ];

  const [search, setSearch] = useState(companiesPag.search);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Debounce the search box → server-side filter.
  useEffect(() => {
    const t = setTimeout(() => setCompaniesSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  // The selection holds only rows on screen: paging, searching or deleting drops the rest.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(companies.filter((c) => prev.has(c.id)).map((c) => c.id));
      return next.size === prev.size ? prev : next;
    });
  }, [companies]);

  // The footer totals, for the columns (and name) that have a calculation set.
  const totals = useAggregates(
    "/api/companies/aggregates",
    listFilterQuery(companiesPag),
    ["name", ...columns.map((c) => c.key)].flatMap((key) => { const op = view.aggregate(key); return op ? [{ key, op }] : []; }),
    companies,
  );

  const openRecord = (id: string) => navigate(withQuery({ record: id }), { replace: !!openId });
  const totalPages = Math.max(1, Math.ceil(companiesPag.total / companiesPag.limit));

  const addButton = (
    <Button size="sm" onClick={() => setDialogOpen(true)}>
      <Plus className="size-4" />
      Add company
    </Button>
  );

  const exportSelected = () => {
    const rows = companies.filter((c) => selected.has(c.id));
    const shown = columns.filter((c) => view.visible(c.key));
    downloadCsv("companies.csv", [name.label, ...shown.map((c) => c.label)], rows.map((r) => [name.text(r), ...shown.map((c) => c.text(r))]));
  };

  const confirmDelete = async () => {
    const ids = [...selected];
    setDeleting(true);
    try {
      await deleteCompanies(ids);
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
      <PageHeader title="Companies" count={stats.companies}>
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
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search companies…"
                aria-label="Search companies"
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
            count={companiesPag.total}
            onOpen={listView.open}
            onCreate={listView.create}
            onRename={listView.rename}
            onDelete={listView.remove}
          />
        }
        fields={filterFields}
        filters={listView.filters}
        onChange={listView.setFilters}
        isVisible={view.visible}
        dirty={listView.dirty}
        onSave={listView.update}
        onReset={listView.reset}
      />

      {/* The first-run empty state is for an empty list, not a filtered one. */}
      {companies.length === 0 && !companiesPag.search && sanitize(listView.filters).length === 0 ? (
        <EmptyState title="No companies yet. Add your first." action={addButton} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <RecordTable
              rows={companies}
              name={name}
              columns={columns}
              view={view}
              sorting={companiesPag}
              onSort={setCompaniesSort}
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
              Page {companiesPag.page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={companiesPag.page <= 1}
                onClick={() => setCompaniesPage(companiesPag.page - 1)}
                aria-label="Previous page"
              >
                Prev
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={companiesPag.page >= totalPages}
                onClick={() => setCompaniesPage(companiesPag.page + 1)}
                aria-label="Next page"
              >
                Next
              </Button>
            </div>
          </footer>
        </div>
      )}

      <CompanyDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} config={companyImportConfig} />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {selected.size === 1 ? "company" : `${selected.size} companies`}?</DialogTitle>
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
