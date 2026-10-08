import { useCallback, useEffect, useRef, useState } from "react";
import { useCrm } from "@/context";
import { api } from "@/api";
import { EntityIcon, EmptyState, PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HEALTH, HealthPill, StatusPill, daysAgo, sightNotice, tzOffset } from "@/components/meetings/shared";
import { NextStepLine } from "@/components/deals/next-step";
import { DealsViewSwitch } from "@/components/deals/deals-view-switch";
import { withQuery } from "@/hooks/use-router";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import type { DealsProgressOverview, MeetingSyncStatus } from "@/types";

/**
 * Open deals by what needs attention: worst first, then the biggest, each
 * with its next step and the reasons in plain words. A deal opens in the side
 * panel, as on the board.
 */
export function DealsProgressPage({ navigate, openId }: { navigate: (to: string) => void; openId?: string }) {
  const { setError, changes } = useCrm();
  const [data, setData] = useState<DealsProgressOverview | null>(null);
  const [sync, setSync] = useState<MeetingSyncStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const [overview, status] = await Promise.all([
        api<DealsProgressOverview>("GET", `/api/deals/progress?tz=${tzOffset()}`),
        api<MeetingSyncStatus>("GET", "/api/meetings/sync"),
      ]);
      setData(overview);
      setSync(status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load deals");
    }
  }, [setError]);

  const seen = useRef(changes);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (seen.current === changes) return;
    seen.current = changes;
    void load();
  }, [changes, load]);

  const open = (id: string) => navigate(withQuery({ record: id }));
  const notice = data ? sightNotice(data.sight, "these deals") : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Open deals" count={data?.total}>
        {data && data.total > 0 && (
          <div className="flex items-center gap-1.5">
            {(["red", "yellow", "unknown", "green"] as const).map((s) => data.counts[s] > 0 && (
              <StatusPill key={s} tone={HEALTH[s].tone}><span className="tabular">{data.counts[s]}</span> {HEALTH[s].label.toLowerCase()}</StatusPill>
            ))}
          </div>
        )}
        <DealsViewSwitch view="next-steps" navigate={navigate} />
      </PageHeader>

      {!data ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>
      ) : data.total === 0 ? (
        <EmptyState
          title="No open deals. Deals that are neither won nor lost show here with their next step."
          action={<Button size="sm" variant="outline" onClick={() => navigate(withQuery({ view: null }))}>Go to the board</Button>}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 p-6">
            {notice && (
              <p className="rounded-md bg-info-tint px-3 py-2 text-[0.8125rem] text-info">
                {notice.text}
                {sync?.can_configure && notice.links.map((l, i) => (
                  <span key={l.href}>{i > 0 ? " · " : " "}<button type="button" className="font-medium underline" onClick={() => navigate(l.href)}>{l.label}</button></span>
                ))}
              </p>
            )}
            <div className="overflow-hidden rounded-md shadow-edge">
              <Table grid>
                <TableHeader>
                  <TableRow>
                    <TableHead pinned width={240}>Deal</TableHead>
                    <TableHead width={340}>Status</TableHead>
                    <TableHead width={300}>Next step</TableHead>
                    <TableHead width={120}>Last contact</TableHead>
                    <TableHead width={120} className="text-right">Value</TableHead>
                    <TableHead width={120}>Close date</TableHead>
                    <TableHead aria-hidden="true" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.deals.map((d) => (
                    <TableRow key={d.id} className={cn("cursor-pointer", openId === d.id && "bg-muted")} onClick={() => open(d.id)}>
                      <TableCell pinned>
                        <a href={`/deals/${encodeURIComponent(d.id)}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(d.id); }} className="flex min-w-0 items-center gap-2">
                          {d.company_name && <EntityIcon name={d.company_name} domain={d.company_domain} className="size-5" />}
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{d.name}</span>
                            {d.company_name && <span className="block truncate text-xs text-muted-foreground">{d.company_name}</span>}
                          </span>
                        </a>
                      </TableCell>
                      <TableCell>
                        {d.progress && (
                          <div className="flex min-w-0 items-center gap-2" title={d.progress.reasons.join("\n") || undefined}>
                            <HealthPill status={d.progress.status} />
                            <span className="truncate text-muted-foreground">{d.progress.reasons[0] ?? ""}</span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell><NextStepLine progress={d.progress} className="max-w-full" /></TableCell>
                      <TableCell className="tabular">{daysAgo(d.progress?.days_quiet ?? null)}</TableCell>
                      <TableCell className="text-right tabular">{formatMoney(d.value)}</TableCell>
                      <TableCell className="tabular">{d.close_date ? formatDate(d.close_date) : <span className="text-faint">Not set</span>}</TableCell>
                      <TableCell aria-hidden="true" />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {data.total > data.deals.length && (
              <p className="text-[0.8125rem] text-muted-foreground">Showing the {data.deals.length} that need attention most, of {data.total} open deals.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
