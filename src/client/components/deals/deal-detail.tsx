import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Handshake, DollarSign, CircleDashed, Calendar, StickyNote, Building2, User, Clock, LayoutGrid, Activity as ActivityIcon } from "lucide-react";
import { useCrm } from "@/context";
import { Button } from "@/components/ui/button";
import { InlineField } from "@/components/ui/inline-field";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { RecordTopBar, Attr, DetailsSection, Tile, RecordTabs, FutureSection, AskAi, useRecordChat } from "@/components/record-page";
import { RelationAttrs, RelationSections } from "@/components/record-relations";
import { RelationInput } from "@/lib/relations";
import { formatMoney, colorClasses, cn } from "@/lib/utils";
import type { Deal, Activity, RelationRecord, StageDef } from "@/types";

function formatTimestamp(createdAt: string): string {
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? createdAt : d.toLocaleString();
}

/** A close date (YYYY-MM-DD) in the reader's format, read as a calendar day, not a UTC instant. */
function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString();
}

// The deal record page: same anatomy as a contact or company. Its company and
// its contact are both its own links, each optional; setting a contact on a
// deal with no company fills the company in (the server does it). `panel`
// renders it in the side panel beside the deals board.
export function DealDetail({ id, navigate, panel = false }: { id: string; navigate: (to: string) => void; panel?: boolean }) {
  const { fetchDeal, updateDeal, fetchActivities, setError, customFields, changes, stages } = useCrm();
  const relationDefs = customFields.filter((d) => d.entity_type === "deal" && d.field_type === "relation");
  const [deal, setDeal] = useState<Deal | null | undefined>(undefined);
  useRecordChat("deal", "Deal", id, deal ? deal.name : undefined);
  const [activities, setActivities] = useState<Activity[]>([]);

  const saveField = async (patch: Partial<Deal>) => {
    if (!deal) return;
    try {
      await updateDeal(deal.id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };
  const reload = async () => {
    const fresh = await fetchDeal(id);
    if (fresh) setDeal(fresh);
    setActivities(await fetchActivities("deal", id));
  };
  // Any record write (here, on the board, a link from another record) re-reads this one.
  const seen = useRef(changes);
  useEffect(() => {
    if (seen.current === changes) return;
    seen.current = changes;
    void reload();
  }, [changes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    setDeal(undefined);
    fetchDeal(id).then((d) => { if (alive) setDeal(d); });
    fetchActivities("deal", id).then((a) => { if (alive) setActivities(a); });
    return () => { alive = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (deal === undefined) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (deal === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
        <p className="text-sm text-muted-foreground">Deal not found.</p>
        <Button size="sm" variant="outline" onClick={() => navigate("/deals")}><ArrowLeft className="size-4" /> Back to deals</Button>
      </div>
    );
  }

  const recent = [...activities].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const noteCount = activities.filter((a) => a.type === "note").length;
  const stage = stages.find((s) => s.key === deal.stage);
  const contactName = `${deal.contact_first_name ?? ""} ${deal.contact_last_name ?? ""}`.trim();
  const company: RelationRecord | undefined = deal.company_id && deal.company_name != null
    ? { id: deal.company_id, label: deal.company_name, domain: deal.company_domain ?? null }
    : undefined;
  const contact: RelationRecord | undefined = deal.contact_id && deal.contact_first_name != null
    ? { id: deal.contact_id, label: contactName, domain: null }
    : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!panel && <RecordTopBar onClose={() => navigate("/deals")} crumb="Deals" />}

      <div className={cn("flex min-h-0 flex-1", panel && "flex-col overflow-y-auto")}>
        <aside className={cn("flex shrink-0 flex-col", !panel && "w-[31.25rem] overflow-y-auto border-r border-border")}>
          <div className="flex items-center gap-3 px-4 pt-4 pb-4">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-success-tint text-success"><Handshake className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <InlineField value={deal.name} placeholder="Deal name" onSave={(v) => { if (v) return saveField({ name: v }); }} className="h-8 w-auto px-1.5 text-base font-semibold" />
            </div>
            <AskAi about={deal.name || "this deal"} />
          </div>

          <DetailsSection title="Deal">
            <dl className="flex flex-col">
              <Attr icon={DollarSign} label="Value">
                <InlineField type="number" value={deal.value ? String(deal.value) : ""} placeholder="Set value…" onSave={(v) => saveField({ value: Number(v) || 0 })}
                  render={(v) => <span className="tabular">{formatMoney(Number(v))}</span>} />
              </Attr>
              <Attr icon={CircleDashed} label="Stage">
                <StageField value={deal.stage} stage={stage} stages={stages} onSave={(key) => saveField({ stage: key })} />
              </Attr>
              <Attr icon={Calendar} label="Close date">
                <InlineField type="date" value={deal.close_date} placeholder="Set close date…" onSave={(v) => saveField({ close_date: v })} render={formatDay} />
              </Attr>
              <Attr icon={StickyNote} label="Notes">
                <InlineField value={deal.notes} placeholder="Set notes…" onSave={(v) => saveField({ notes: v })} />
              </Attr>
            </dl>
          </DetailsSection>

          <DetailsSection title="Relations">
            <dl className="flex flex-col">
              <Attr icon={Building2} label="Company">
                <RelationInput entity="company" value={deal.company_id} known={company} placeholder="Set company…" emptyLabel="No company"
                  onChange={(v) => void saveField({ company_id: v })} />
              </Attr>
              <Attr icon={User} label="Contact">
                <RelationInput entity="contact" value={deal.contact_id} known={contact} placeholder="Set contact…" emptyLabel="No contact"
                  onChange={(v) => void saveField({ contact_id: v })} />
              </Attr>
              <RelationAttrs defs={relationDefs} row={deal} onSave={(key, v) => saveField({ [key]: v } as Partial<Deal>)} />
            </dl>
          </DetailsSection>

          <RelationSections defs={relationDefs} row={deal} />

          <DetailsSection title="System">
            <dl className="flex flex-col">
              <Attr icon={Calendar} label="Created"><span className="px-2 text-sm">{formatTimestamp(deal.created_at)}</span></Attr>
              <Attr icon={Clock} label="Updated"><span className="px-2 text-sm">{formatTimestamp(deal.updated_at)}</span></Attr>
            </dl>
          </DetailsSection>
        </aside>

        <main className={cn("flex min-w-0 flex-col", panel ? "shrink-0 border-t border-border" : "flex-1 overflow-y-auto")}>
          {!panel && <RecordTabs tabs={[
            { key: "overview", label: "Overview", icon: LayoutGrid },
            { key: "activity", label: "Activity", icon: ActivityIcon, count: activities.length },
            { key: "notes", label: "Notes", icon: StickyNote, count: noteCount },
          ]} />}

          <div className={cn("flex flex-col gap-8", panel ? "p-4" : "p-6")}>
            {!panel && (
              <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium">Highlights</h2>
                <div className="grid grid-cols-3 gap-3">
                  <Tile icon={DollarSign} label="Value" empty="No value" value={deal.value ? <span className="tabular">{formatMoney(deal.value)}</span> : undefined} />
                  <Tile icon={CircleDashed} label="Stage" empty="No stage" value={stage?.label ?? deal.stage} />
                  <Tile icon={Calendar} label="Close date" empty="No close date" value={deal.close_date ? formatDay(deal.close_date) : undefined} />
                  <Tile icon={Building2} label="Company" empty="No company" value={deal.company_name} />
                  <Tile icon={User} label="Contact" empty="No contact" value={contactName} />
                  <Tile icon={Clock} label="Last activity" empty="No activity" value={recent[0] ? formatTimestamp(recent[0].created_at) : undefined} />
                </div>
              </section>
            )}

            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">Activity</h2>
              {recent.length === 0 ? (
                <p className="text-sm text-faint">No activity yet.</p>
              ) : (
                <ul className="flex flex-col rounded-md bg-card shadow-edge">
                  {recent.slice(0, 6).map((a) => (
                    <li key={a.id} className="flex items-start gap-3 px-3.5 py-2.5 [&+li]:border-t [&+li]:border-border">
                      <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"><ActivityIcon className="size-3" /></span>
                      <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm">{a.body}</p>
                      <span className="shrink-0 tabular text-xs text-muted-foreground">{formatTimestamp(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <FutureSection label="Notes" count={noteCount} />
          </div>
        </main>
      </div>
    </div>
  );
}

/** The stage as its own control: the stage's dot and name, which opens the pipeline's stages. */
function StageField({ value, stage, stages, onSave }: { value: string; stage?: StageDef; stages: StageDef[]; onSave: (key: string) => Promise<void> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Change stage" className="flex h-8 w-full items-center gap-2 rounded-[0.5rem] px-2 text-left text-sm hover:bg-secondary">
          <span className={cn("size-2 shrink-0 rounded-full", colorClasses(stage?.color).dot)} />
          {stage?.label ?? value}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {stages.map((s) => (
          <DropdownMenuItem key={s.key} onClick={() => { if (s.key !== value) void onSave(s.key); }}>
            <span className={cn("size-2 rounded-full", colorClasses(s.color).dot)} /> {s.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
