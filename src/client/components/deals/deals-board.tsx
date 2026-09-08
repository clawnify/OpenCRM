import { useState } from "react";
import { Plus, Pencil, Trash2, MoreHorizontal, ArrowRightLeft } from "lucide-react";
import { useCrm } from "@/context";
import { PageHeader, Avatar, EntityIcon, EmptyState } from "@/components/shared";
import { DealDialog } from "@/components/deals/deal-dialog";
import { StageDialog } from "@/components/deals/stage-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { api } from "@/api";
import { formatMoney, colorClasses, cn } from "@/lib/utils";
import type { Deal, StageDef } from "@/types";

export function DealsBoard() {
  const { boardDeals, stats, dealsTotalValue, updateDeal, deleteDeal, stages, refetchStages, refetchBoard, refetchStats, setError, isAgent } = useCrm();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Deal | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<Deal | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [stageDialogOpen, setStageDialogOpen] = useState(false);
  const [stageEditing, setStageEditing] = useState<StageDef | undefined>(undefined);
  const [stageDeleteTarget, setStageDeleteTarget] = useState<StageDef | null>(null);

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };
  const openEdit = (d: Deal) => {
    setEditing(d);
    setDialogOpen(true);
  };

  const addButton = (
    <Button size="sm" onClick={openCreate}>
      <Plus className="size-4" />
      Add deal
    </Button>
  );

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteDeal(deleteTarget.id);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Deals" count={stats.deals}>
        <div className="flex flex-col items-end">
          <div className="section-label">Pipeline value</div>
          <span className="tabular text-sm font-semibold">{formatMoney(dealsTotalValue)}</span>
        </div>
        {addButton}
      </PageHeader>

      {boardDeals.length === 0 && stages.length === 0 ? (
        <EmptyState title="No deals yet. Add your first." action={addButton} />
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="flex h-full min-w-max gap-4 p-6">
            {stages.map((stage) => {
              const columnDeals = boardDeals.filter((d) => d.stage === stage.key);
              const columnTotal = columnDeals.reduce((sum, d) => sum + (d.value || 0), 0);
              const c = colorClasses(stage.color);
              return (
                <div key={stage.key} className="flex w-72 shrink-0 flex-col gap-3">
                  <div className="group flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={cn("size-2 shrink-0 rounded-full", c.dot)} />
                      <span className="text-sm font-semibold">{stage.label}</span>
                      <span className="tabular text-[0.8125rem] text-muted-foreground">{columnDeals.length}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="tabular text-[0.8125rem] font-medium text-muted-foreground">
                        {formatMoney(columnTotal)}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button aria-label={`Actions for stage ${stage.label}`}
                            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
                            <MoreHorizontal className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => { setStageEditing(stage); setStageDialogOpen(true); }}>
                            <Pencil className="size-4" /> Edit stage
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setStageDeleteTarget(stage)}
                            className="text-destructive focus:text-destructive">
                            <Trash2 className="size-4" /> Delete stage
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    {columnDeals.map((d) => {
                      const contactName = `${d.contact_first_name ?? ""} ${d.contact_last_name ?? ""}`.trim();
                      return (
                        // DESIGN.md: resting card = border only, quiet hover one
                        // tonal step; actions reveal on hover (always visible in
                        // agent mode — never gate an action behind hover there).
                        <Card key={d.id} className="group/card flex flex-col gap-1.5 p-3 transition-colors hover:bg-secondary/50">
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-sm font-medium">{d.name}</span>
                            <span className="tabular shrink-0 text-sm font-semibold">{formatMoney(d.value)}</span>
                          </div>

                          {(d.company_name || contactName) && (
                            <div className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
                              {d.company_name && (
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <EntityIcon name={d.company_name} domain={d.company_domain} className="size-5" />
                                  <span className="truncate">{d.company_name}</span>
                                </span>
                              )}
                              {d.company_name && contactName && <span className="text-border">·</span>}
                              {contactName && (
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <Avatar firstName={d.contact_first_name} lastName={d.contact_last_name} className="size-5 text-[0.5625rem]" />
                                  <span className="truncate">{contactName}</span>
                                </span>
                              )}
                            </div>
                          )}

                          <div className="flex items-center justify-end gap-2">
                            <div className={cn(
                              "flex items-center transition-opacity",
                              isAgent ? "opacity-100" : "opacity-0 group-hover/card:opacity-100 focus-within:opacity-100",
                            )}>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button size="icon" variant="ghost" className="size-7" aria-label={`Move ${d.name} to another stage`}>
                                    <ArrowRightLeft className="size-3.5" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {stages.filter((s) => s.key !== d.stage).map((s) => {
                                    const sc = colorClasses(s.color);
                                    return (
                                      <DropdownMenuItem key={s.key} onClick={() => updateDeal(d.id, { stage: s.key })}>
                                        <span className={cn("size-2 rounded-full", sc.dot)} /> {s.label}
                                      </DropdownMenuItem>
                                    );
                                  })}
                                </DropdownMenuContent>
                              </DropdownMenu>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-7"
                                aria-label={`Edit ${d.name}`}
                                onClick={() => openEdit(d)}
                              >
                                <Pencil className="size-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-7 text-muted-foreground hover:text-destructive"
                                aria-label={`Delete ${d.name}`}
                                onClick={() => setDeleteTarget(d)}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Attio-style pipeline growth: a quiet add-stage stub after the last column. */}
            <div className="flex w-72 shrink-0 flex-col">
              <button
                onClick={() => { setStageEditing(undefined); setStageDialogOpen(true); }}
                aria-label="Add stage"
                className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Plus className="size-4" />
                Add stage
              </button>
            </div>
          </div>
        </div>
      )}

      <DealDialog open={dialogOpen} onOpenChange={setDialogOpen} deal={editing} />

      <StageDialog
        open={stageDialogOpen}
        onOpenChange={setStageDialogOpen}
        stage={stageEditing}
      />

      <DeleteStageDialog
        stage={stageDeleteTarget}
        stages={stages}
        dealCount={stageDeleteTarget ? boardDeals.filter((d) => d.stage === stageDeleteTarget.key).length : 0}
        onClose={() => setStageDeleteTarget(null)}
        onDeleted={async () => {
          await Promise.all([refetchStages(), refetchBoard(), refetchStats()]);
        }}
        onError={setError}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete deal?</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `${deleteTarget.name || "This deal"} will be permanently removed. This can't be undone.`
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

/** Delete a stage; when it still holds deals, the user picks the stage they
 *  move to (the server refuses a delete that would orphan deals). */
function DeleteStageDialog({
  stage,
  stages,
  dealCount,
  onClose,
  onDeleted,
  onError,
}: {
  stage: StageDef | null;
  stages: StageDef[];
  dealCount: number;
  onClose: () => void;
  onDeleted: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [reassignTo, setReassignTo] = useState("");
  const [busy, setBusy] = useState(false);
  if (!stage) return null;

  const others = stages.filter((s) => s.key !== stage.key);
  const needsReassign = dealCount > 0;

  const confirm = async () => {
    if (needsReassign && !reassignTo) return;
    setBusy(true);
    try {
      const q = needsReassign ? `?reassign_to=${encodeURIComponent(reassignTo)}` : "";
      await api("DELETE", `/api/stages/${encodeURIComponent(stage.key)}${q}`);
      setReassignTo("");
      onClose();
      await onDeleted();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete stage");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) { setReassignTo(""); onClose(); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete stage "{stage.label}"?</DialogTitle>
          <DialogDescription>
            {needsReassign
              ? `${dealCount} deal${dealCount === 1 ? "" : "s"} in this stage will be moved to the stage you pick.`
              : "The stage is empty and will be removed from the pipeline."}
          </DialogDescription>
        </DialogHeader>
        {needsReassign && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reassign">Move deals to</Label>
            <Select value={reassignTo || undefined} onValueChange={setReassignTo}>
              <SelectTrigger id="reassign" className="w-full">
                <SelectValue placeholder="Select a stage…" />
              </SelectTrigger>
              <SelectContent>
                {others.map((s) => (
                  <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button size="sm" variant="outline">Cancel</Button>
          </DialogClose>
          <Button size="sm" variant="destructive" onClick={confirm} disabled={busy || (needsReassign && !reassignTo)}>
            {busy ? "Deleting…" : "Delete stage"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
