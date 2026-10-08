import { useState, type ReactNode } from "react";
import { Plus, Pencil, Trash2, MoreHorizontal, ArrowRightLeft, CircleDollarSign, CalendarDays, Building2, UserRound, HeartHandshake, NotebookText, Clock3, Footprints, type LucideIcon } from "lucide-react";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useCrm } from "@/context";
import { PageHeader, Avatar, EntityIcon, EmptyState } from "@/components/shared";
import { DealDialog } from "@/components/deals/deal-dialog";
import { StageDialog } from "@/components/deals/stage-dialog";
import { FilterBar } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { withQuery } from "@/hooks/use-router";
import { api } from "@/api";
import { formatMoney, formatDate, daysSince, colorClasses, cn } from "@/lib/utils";
import { NextStepLine } from "@/components/deals/next-step";
import { DealsViewSwitch } from "@/components/deals/deals-view-switch";
import { fieldsFromDefs } from "@/lib/filters";
import type { Deal, StageDef } from "@/types";

// `openId` is the deal open in the side panel beside the board (`?record=`).
export function DealsBoard({ navigate, openId }: { navigate: (to: string, opts?: { replace?: boolean }) => void; openId?: string }) {
  const { boardDeals, boardFilters, setBoardFilters, stats, dealsTotalValue, addDeal, updateDeal, deleteDeal, stages, refetchStages, refetchBoard, refetchStats, setError, isAgent, customFields } = useCrm();
  const openRecord = (id: string) => navigate(withQuery({ record: id }), { replace: !!openId });

  // The board has no saved views: filters apply to what it shows, and a card
  // is either on the board or filtered out. Same rules as the lists' filters.
  const filterFields = fieldsFromDefs(
    [
      { key: "name", label: "Name", type: "text", column: "name" },
      { key: "value", label: "Value", type: "number", column: "value" },
      { key: "company_id", label: "Company", type: "relation", entity: "company", column: "company_id" },
      { key: "contact_id", label: "Contact", type: "relation", entity: "contact", column: "contact_id" },
      { key: "stage", label: "Stage", type: "enum", column: "stage", options: stages.map((s) => ({ label: s.label, value: s.key })) },
      { key: "close_date", label: "Close date", type: "date", column: "close_date" },
      { key: "notes", label: "Notes", type: "text", column: "notes" },
      { key: "created_at", label: "Created", type: "date", column: "created_at" },
    ],
    customFields.filter((d) => d.entity_type === "deal"),
  );

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

  // A new deal needs only its name: it is created in the first stage and opens
  // in the panel, where everything else is filled in place. A required custom
  // field can't be left for later, so then the full form asks for it up front.
  const needsForm = customFields.some((d) => d.entity_type === "deal" && d.options.required === true);
  const createNamed = async (name: string, stage?: string) => {
    try {
      const deal = await addDeal(stage ? { name, stage } : { name });
      openRecord(deal.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create deal");
    }
  };
  const openEdit = (d: Deal) => {
    setEditing(d);
    setDialogOpen(true);
  };

  const addButton = needsForm ? (
    <Button size="sm" onClick={openCreate}>
      <Plus className="size-4" />
      Add deal
    </Button>
  ) : <NewDealButton onCreate={createNamed} />;

  // Dropping a card on another column and the card's "Move" menu make the same write.
  const moveDeal = async (d: Deal, stage: string) => {
    if (d.stage === stage) return;
    try {
      await updateDeal(d.id, { stage });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not move the deal");
    }
  };
  // A press becomes a drag only after 4px of movement, so a click still opens the deal.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [dragging, setDragging] = useState<Deal | null>(null);
  const onDragStart = (e: DragStartEvent) => setDragging(boardDeals.find((d) => d.id === e.active.id) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const deal = boardDeals.find((d) => d.id === e.active.id);
    if (deal && e.over) void moveDeal(deal, String(e.over.id));
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteDeal(deleteTarget.id);
      if (deleteTarget.id === openId) navigate(withQuery({ record: null }), { replace: true });
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Deals" count={stats.deals}>
        <DealsViewSwitch view="board" navigate={navigate} />
        <div className="flex flex-col items-end">
          <div className="section-label">Pipeline value</div>
          <span className="tabular text-sm font-semibold">{formatMoney(dealsTotalValue)}</span>
        </div>
        {addButton}
      </PageHeader>

      <FilterBar
        fields={filterFields}
        filters={boardFilters}
        onChange={setBoardFilters}
        isVisible={() => true}
        dirty={false}
        onSave={() => {}}
        onReset={() => {}}
      />

      {boardDeals.length === 0 && stages.length === 0 ? (
        <EmptyState title="No deals yet. Add your first." action={addButton} />
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="flex h-full min-w-max gap-4 p-6">
            {stages.map((stage) => {
              const columnDeals = boardDeals.filter((d) => d.stage === stage.key);
              const columnTotal = columnDeals.reduce((sum, d) => sum + (d.value || 0), 0);
              const c = colorClasses(stage.color);
              return (
                <StageDrop key={stage.key} stage={stage.key}>
                  <div className="group flex h-7 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={cn("size-2 shrink-0 rounded-full", c.dot)} />
                      <span className="truncate text-sm font-semibold">{stage.label}</span>
                      <span className="rounded-sm bg-card px-1.5 text-xs tabular text-muted-foreground shadow-edge">{columnDeals.length}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <span className="tabular text-[0.8125rem] text-muted-foreground">{formatMoney(columnTotal)}</span>
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
                      {!needsForm && (
                        <NewDealButton
                          onCreate={(name) => createNamed(name, stage.key)}
                          trigger={
                            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" aria-label={`Add a deal to ${stage.label}`}>
                              <Plus className="size-4" />
                            </Button>
                          }
                        />
                      )}
                    </div>
                  </div>

                  {/* The tray keeps its height; a long stage scrolls its own deals under a fixed header. */}
                  <div className="-mx-3 -mb-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
                    {columnDeals.map((d) => (
                      <DealCard
                        key={d.id}
                        deal={d}
                        open={d.id === openId}
                        isAgent={isAgent}
                        stages={stages}
                        onOpen={() => openRecord(d.id)}
                        onMove={(to) => void moveDeal(d, to)}
                        onEdit={() => openEdit(d)}
                        onDelete={() => setDeleteTarget(d)}
                      />
                    ))}
                  </div>
                </StageDrop>
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
          {/* The card in hand follows the pointer, lifted like anything that leaves the page. */}
          <DragOverlay dropAnimation={null}>
            {dragging && (
              <Card className="flex w-full -rotate-2 cursor-grabbing flex-col p-3 shadow-[var(--shadow-popover)]">
                <DealTitle deal={dragging} />
                <DealFields deal={dragging} />
                <DealAge deal={dragging} />
              </Card>
            )}
          </DragOverlay>
          </DndContext>
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

/** "Add deal" as a name field: Enter creates the deal. */
function NewDealButton({ onCreate, trigger }: { onCreate: (name: string) => Promise<void>; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = name.trim();
    if (!v) return;
    setBusy(true);
    try {
      await onCreate(v);
      setName("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Plus className="size-4" />
            Add deal
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Label htmlFor="new-deal-name">Deal name</Label>
          <Input id="new-deal-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme renewal" />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create deal"}</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** A stage's column: a tray holding its deals, and where a dragged deal is dropped. */
function StageDrop({ stage, children }: { stage: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div ref={setNodeRef} className={cn("flex min-h-0 w-72 shrink-0 flex-col gap-2 rounded-xl bg-secondary p-3 transition-shadow", isOver && "ring-2 ring-inset ring-ring/15")}>
      {children}
    </div>
  );
}

function DealCard({ deal: d, open, isAgent, stages, onOpen, onMove, onEdit, onDelete }: {
  deal: Deal;
  open: boolean;
  isAgent: boolean;
  stages: StageDef[];
  onOpen: () => void;
  onMove: (stage: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Agents move deals with the Move menu, which is always visible for them.
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: d.id, disabled: isAgent });
  return (
    // DESIGN.md: resting card = border only, quiet hover one tonal step;
    // actions reveal on hover (always visible in agent mode — never gate an
    // action behind hover there). The name is the card's link to the deal;
    // its ::after stretches over the card, and the actions sit above it.
    <Card ref={setNodeRef} {...listeners}
      className={cn("group/card relative flex flex-col p-3 transition-colors hover:bg-secondary/50", open && "ring-1 ring-inset ring-ring/30", isDragging && "opacity-40")}>
      <button type="button" onClick={onOpen} aria-current={open || undefined}
        className="min-w-0 text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring">
        <DealTitle deal={d} />
      </button>
      <DealFields deal={d} />
      <DealAge deal={d} />

      <div className={cn(
        "z-10 flex items-center",
        isAgent
          ? "relative justify-end"
          : "absolute right-2 top-2 rounded-sm bg-card opacity-0 shadow-edge transition-opacity group-hover/card:opacity-100 focus-within:opacity-100",
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
                <DropdownMenuItem key={s.key} onClick={() => onMove(s.key)}>
                  <span className={cn("size-2 rounded-full", sc.dot)} /> {s.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon" variant="ghost" className="size-7" aria-label={`Edit ${d.name}`} onClick={onEdit}>
          <Pencil className="size-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" aria-label={`Delete ${d.name}`} onClick={onDelete}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </Card>
  );
}

function DealTitle({ deal }: { deal: Deal }) {
  return (
    <span className="flex h-7 min-w-0 items-center gap-2">
      <HeartHandshake className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate text-sm font-medium leading-6 underline decoration-border underline-offset-2">{deal.name}</span>
    </span>
  );
}

/** A deal's fields, one row each: the value, or a faint prompt while it is
 *  empty, so every card has the same shape and shows what is missing. */
function DealFields({ deal: d }: { deal: Deal }) {
  const contactName = `${d.contact_first_name ?? ""} ${d.contact_last_name ?? ""}`.trim();
  const note = (d.notes ?? "").split("\n")[0].trim();
  return (
    <dl className="flex flex-col text-sm">
      {d.progress && (
        <FieldRow icon={Footprints} label="Next step">
          <NextStepLine progress={d.progress} icon={false} compact className="text-sm" />
        </FieldRow>
      )}
      <FieldRow icon={CalendarDays} label="Close date">
        {d.close_date ? formatDate(d.close_date) : null}
      </FieldRow>
      <FieldRow icon={CircleDollarSign} label="Amount">
        <span className="tabular">{formatMoney(d.value)}</span>
      </FieldRow>
      <FieldRow icon={Building2} label="Company">
        {d.company_name ? (
          <>
            <EntityIcon name={d.company_name} domain={d.company_domain} className="size-5" />
            <span className="truncate">{d.company_name}</span>
          </>
        ) : null}
      </FieldRow>
      <FieldRow icon={UserRound} label="Contact">
        {contactName ? (
          <>
            <Avatar firstName={d.contact_first_name} lastName={d.contact_last_name} className="size-5 text-[0.5625rem]" />
            <span className="truncate">{contactName}</span>
          </>
        ) : null}
      </FieldRow>
      <FieldRow icon={NotebookText} label="Notes" placeholder="Add note…">
        {note ? <span className="truncate text-muted-foreground">{note}</span> : null}
      </FieldRow>
    </dl>
  );
}

function FieldRow({ icon: Icon, label, placeholder = label, children }: { icon: LucideIcon; label: string; placeholder?: string; children: ReactNode }) {
  return (
    <div className="flex h-7 min-w-0 items-center gap-2">
      <dt className="sr-only">{label}</dt>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <dd className="flex min-w-0 items-center gap-1.5">
        {children ?? (
          <>
            <span className="text-faint" aria-hidden>{placeholder}</span>
            <span className="sr-only">Not set</span>
          </>
        )}
      </dd>
    </div>
  );
}

/** How long since the deal last changed: a stale deal shows it at a glance. */
function DealAge({ deal }: { deal: Deal }) {
  const days = daysSince(deal.updated_at);
  return (
    <div className="flex h-6 items-center justify-end">
      <span className="flex items-center gap-1 text-xs tabular text-muted-foreground" title={days === 0 ? "Updated today" : `Updated ${days} day${days === 1 ? "" : "s"} ago`}>
        <Clock3 className="size-3.5" aria-hidden />
        {days === 0 ? "today" : `${days}d`}
      </span>
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
