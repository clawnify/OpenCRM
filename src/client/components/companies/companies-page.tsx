import { useEffect, useState } from "react";
import { Search, Plus, Upload, Pencil, Trash2, ChevronUp, ChevronDown, ExternalLink } from "lucide-react";
import { useCrm } from "@/context";
import { PageHeader, EntityIcon, CategoryBadge, EmptyState } from "@/components/shared";
import { CompanyDialog } from "@/components/companies/company-dialog";
import { TableFilter, fieldsFromDefs } from "@/components/table-filter";
import { ImportDialog } from "@/components/import-dialog";
import { companyImportConfig } from "@/lib/import-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CustomFieldDisplay, readCustom } from "@/lib/custom-fields";
import type { Company } from "@/types";

export function CompaniesPage({ navigate }: { navigate: (to: string) => void }) {
  const { companies, companiesPag, stats, setCompaniesPage, setCompaniesSort, setCompaniesSearch, setCompaniesFilters, deleteCompany, customFields } = useCrm();
  const companyFields = customFields.filter((d) => d.entity_type === "company");
  const filterFields = fieldsFromDefs(
    [
      { key: "name", label: "Name", type: "text" },
      { key: "domain", label: "Domain", type: "text" },
      { key: "industry", label: "Industry", type: "text" },
      { key: "phone", label: "Phone", type: "text" },
      { key: "email", label: "Email", type: "text" },
    ],
    companyFields,
  );

  const [search, setSearch] = useState(companiesPag.search);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Debounce the search box → server-side filter.
  useEffect(() => {
    const t = setTimeout(() => setCompaniesSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setDialogOpen(true);
  };

  const totalPages = Math.max(1, Math.ceil(companiesPag.total / companiesPag.limit));

  const addButton = (
    <Button size="sm" onClick={openCreate}>
      <Plus className="size-4" />
      Add company
    </Button>
  );

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteCompany(deleteTarget.id);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Companies" count={stats.companies}>
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
        <TableFilter fields={filterFields} filters={companiesPag.filters} onChange={setCompaniesFilters} />
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          <Upload className="size-4" />
          Import
        </Button>
        {addButton}
      </PageHeader>

      {companies.length === 0 ? (
        <EmptyState title="No companies yet. Add your first." action={addButton} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHeader col="name" pag={companiesPag} onSort={setCompaniesSort}>Name</SortHeader>
                  <SortHeader col="domain" pag={companiesPag} onSort={setCompaniesSort}>Domain</SortHeader>
                  <SortHeader col="industry" pag={companiesPag} onSort={setCompaniesSort}>Industry</SortHeader>
                  {companyFields.map((def) => (
                    <SortHeader key={def.id} col={def.key} pag={companiesPag} onSort={setCompaniesSort}>{def.label}</SortHeader>
                  ))}
                  <TableHead className="text-right">Contacts</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {companies.map((c) => (
                  <TableRow key={c.id} className="cursor-pointer hover:bg-secondary" onClick={() => navigate(`/companies/${c.id}`)}>
                    <TableCell>
                      <span className="flex min-w-0 items-center gap-2.5 font-medium">
                        <EntityIcon name={c.name} domain={c.domain} />
                        <span className="truncate">{c.name || "—"}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {c.domain ? (
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
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <CategoryBadge value={c.industry} />
                    </TableCell>
                    {companyFields.map((def) => (
                      <TableCell key={def.id}>
                        <CustomFieldDisplay def={def} value={readCustom(c, def.key)} />
                      </TableCell>
                    ))}
                    <TableCell className="text-right">
                      <span className="tabular">{c.contact_count ?? 0}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8"
                          aria-label={`Edit ${c.name || "company"}`}
                          onClick={() => navigate(`/companies/${c.id}`)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 text-muted-foreground hover:text-destructive"
                          aria-label={`Delete ${c.name || "company"}`}
                          onClick={() => setDeleteTarget(c)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete company?</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `${deleteTarget.name || "This company"} will be permanently removed. This can't be undone.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="sm" variant="outline">Cancel</Button>
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

function SortHeader({
  col,
  pag,
  onSort,
  children,
  className,
}: {
  col: string;
  pag: { sort: string; order: "asc" | "desc" };
  onSort: (col: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const active = pag.sort === col;
  return (
    <TableHead className={className}>
      <button
        onClick={() => onSort(col)}
        aria-label={`Sort by ${col}`}
        className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}
      >
        {children}
        {active && (pag.order === "asc" ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />)}
      </button>
    </TableHead>
  );
}
