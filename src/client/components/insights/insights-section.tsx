import { useEffect, useRef, useState } from "react";
import { Lightbulb, TrendingUp, TriangleAlert, X } from "lucide-react";
import { useCrm } from "@/context";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { meetingWhen } from "@/components/meetings/shared";
import { cn } from "@/lib/utils";
import type { Insight, InsightKind } from "@/types";

const KINDS: Array<{ kind: InsightKind; label: string; icon: typeof Lightbulb; tint: string; done: string }> = [
  { kind: "risk", label: "Risks", icon: TriangleAlert, tint: "bg-destructive-tint text-destructive", done: "Resolved" },
  { kind: "expansion", label: "Room to expand", icon: TrendingUp, tint: "bg-success-tint text-success", done: "Done" },
  { kind: "idea", label: "Ideas to propose", icon: Lightbulb, tint: "bg-warning-tint text-warning", done: "Proposed" },
];

/**
 * What a company's calls said beyond tasks: risks to the relationship, room to
 * grow the account, and ideas worth proposing, each with the words it came
 * from. Open until someone acts on it; an expansion can become a deal.
 */
export function InsightsSection({ companyId, navigate }: { companyId: string; navigate: (to: string) => void }) {
  const { setError, changes, recordsChanged } = useCrm();
  const [insights, setInsights] = useState<Insight[] | null>(null);

  const load = () =>
    api<{ insights: Insight[] }>("GET", `/api/insights?company_id=${encodeURIComponent(companyId)}&limit=200`)
      .then((r) => setInsights(r.insights), (e) => setError(e instanceof Error ? e.message : "Could not load insights"));

  const seen = useRef(changes);
  useEffect(() => { void load(); }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (seen.current === changes) return;
    seen.current = changes;
    void load();
  }, [changes]); // eslint-disable-line react-hooks/exhaustive-deps

  const settle = async (i: Insight, status: "done" | "dismissed") => {
    try {
      await api("PUT", `/api/insights/${encodeURIComponent(i.id)}`, { status });
      setInsights((list) => (list ?? []).filter((x) => x.id !== i.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };
  const toDeal = async (i: Insight) => {
    try {
      const r = await api<{ deal_id: string }>("POST", `/api/insights/${encodeURIComponent(i.id)}/deal`);
      await recordsChanged();
      navigate(`/deals?record=${encodeURIComponent(r.deal_id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the deal");
    }
  };

  const list = insights ?? [];
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-9 items-center">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium">
          From calls <span className="rounded-xs bg-secondary px-1.5 text-xs tabular text-muted-foreground">{list.length}</span>
        </h2>
      </div>
      {insights && !list.length ? (
        <p className="text-sm text-faint">Nothing open. Ideas, room to expand and risks from this company's calls show here.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {KINDS.map(({ kind, label, icon: Icon, tint, done }) => {
            const items = list.filter((i) => i.kind === kind);
            if (!items.length) return null;
            return (
              <div key={kind} className="flex flex-col rounded-md bg-card shadow-edge">
                <div className="flex h-9 items-center gap-2 border-b border-border px-3.5 text-[0.8125rem] font-medium text-muted-foreground">
                  <span className={cn("inline-flex size-5 items-center justify-center rounded-full", tint)}><Icon className="size-3" /></span>
                  {label}
                  <span className="tabular">{items.length}</span>
                </div>
                <ul>
                  {items.map((i) => (
                    <li key={i.id} className="group flex items-start gap-3 px-3.5 py-2.5 [&+li]:border-t [&+li]:border-border">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">{i.text}</p>
                        {(i.quote || i.meeting_starts_at) && (
                          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
                            {i.quote && <>“{i.quote}”</>}
                            {i.quote && i.meeting_starts_at && " · "}
                            {i.meeting_starts_at && `${i.meeting_title || "Call"}, ${meetingWhen(i.meeting_starts_at)}`}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {kind === "expansion" && (
                          <Button size="sm" variant="outline" className="h-7" onClick={() => void toDeal(i)}>Create deal</Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => void settle(i, "done")}>{done}</Button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label="Dismiss" className="size-7" onClick={() => void settle(i, "dismissed")}>
                              <X className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Dismiss: not relevant</TooltipContent>
                        </Tooltip>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
