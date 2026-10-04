import { useCallback, useEffect, useRef, useState } from "react";
import { AlarmClock, Check, PhoneCall, TriangleAlert, CalendarCheck } from "lucide-react";
import { useCrm } from "@/context";
import { api } from "@/api";
import { EntityIcon, EmptyState, PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Eyebrow, HEALTH, HealthPill, StatusPill, daysAgo, meetingWhen, tzOffset } from "@/components/meetings/shared";
import { cn } from "@/lib/utils";
import type { CustomersOverview, FocusItem, MeetingSyncStatus } from "@/types";

const FOCUS_ICON: Record<FocusItem["kind"], typeof AlarmClock> = {
  overdue: AlarmClock,
  due_today: CalendarCheck,
  reach_out: PhoneCall,
  risk: TriangleAlert,
};

/**
 * Customers: how each account is doing, worst first, with the reasons in plain
 * words; the few things worth doing first; and the calls coming up this week.
 * A company is a customer from its "Customer since" day (set on its page, or
 * from the close date of its first won deal).
 */
export function CustomersPage({ navigate }: { navigate: (to: string) => void }) {
  const { setError, changes } = useCrm();
  const [data, setData] = useState<CustomersOverview | null>(null);
  const [sync, setSync] = useState<MeetingSyncStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const [overview, status] = await Promise.all([
        api<CustomersOverview>("GET", `/api/customers?tz=${tzOffset()}`),
        api<MeetingSyncStatus>("GET", "/api/meetings/sync"),
      ]);
      setData(overview);
      setSync(status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load customers");
    }
  }, [setError]);

  const seen = useRef(changes);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (seen.current === changes) return;
    seen.current = changes;
    void load();
  }, [changes, load]);

  const done = async (taskId: string) => {
    try {
      await api("PUT", `/api/tasks/${encodeURIComponent(taskId)}`, { done: true });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the task");
    }
  };

  const open = (id: string) => navigate(`/companies/${encodeURIComponent(id)}`);
  const syncOff = !!sync && !sync.settings?.enabled;

  if (!data) {
    return (
      <>
        <PageHeader title="Customers" />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Customers" count={data.customers.length}>
        {data.customers.length > 0 && (
          <div className="flex items-center gap-1.5">
            {(["red", "yellow", "green"] as const).map((s) => data.counts[s] > 0 && (
              <StatusPill key={s} tone={HEALTH[s].tone}><span className="tabular">{data.counts[s]}</span> {HEALTH[s].label.toLowerCase()}</StatusPill>
            ))}
          </div>
        )}
      </PageHeader>

      {data.customers.length === 0 ? (
        <EmptyState
          title="No customers yet. A company becomes a customer when one of its deals is won (from that deal's close date), or when you set Customer since on its page."
          action={<Button size="sm" variant="outline" onClick={() => navigate("/companies")}>Go to companies</Button>}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-8 p-6">
            {syncOff && (
              <p className="rounded-md bg-info-tint px-3 py-2 text-[0.8125rem] text-info">
                Meetings aren't synced yet, so calls, promises and ideas from calls are missing here.{" "}
                <button type="button" className="font-medium underline" onClick={() => navigate("/settings/meetings")}>Set up meetings</button>
              </p>
            )}

            {data.focus.length > 0 && (
              <section className="flex flex-col gap-3">
                <Eyebrow>Today</Eyebrow>
                <div className="grid gap-3 md:grid-cols-3">
                  {data.focus.map((f, i) => {
                    const Icon = FOCUS_ICON[f.kind];
                    return (
                      <div key={`${f.kind}-${f.task_id ?? f.company_id}-${i}`} className="flex flex-col gap-3 rounded-md bg-card p-3.5 shadow-edge">
                        <div className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
                          <Icon className={cn("size-3.5", (f.kind === "overdue" || f.kind === "risk") && "text-destructive")} />
                          <button type="button" className="truncate hover:text-foreground hover:underline" onClick={() => open(f.company_id)}>{f.company_name}</button>
                        </div>
                        <p className="text-sm">{f.text}</p>
                        <div className="mt-auto flex gap-2">
                          {f.task_id ? (
                            <Button size="sm" variant="outline" className="h-7" onClick={() => void done(f.task_id!)}><Check className="size-3.5" strokeWidth={2.5} /> Done</Button>
                          ) : (
                            <Button size="sm" variant="outline" className="h-7" onClick={() => open(f.company_id)}>Open</Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="flex flex-col gap-3">
              <Eyebrow>Accounts</Eyebrow>
              <div className="overflow-hidden rounded-md shadow-edge">
                <Table grid>
                  <TableHeader>
                    <TableRow>
                      <TableHead pinned width={220}>Company</TableHead>
                      <TableHead width={340}>Status</TableHead>
                      <TableHead width={120}>Last contact</TableHead>
                      <TableHead width={150}>Next call</TableHead>
                      <TableHead width={130} className="text-right">Our promises</TableHead>
                      <TableHead width={120} className="text-right">Waiting on them</TableHead>
                      <TableHead width={80} className="text-right">Ideas</TableHead>
                      <TableHead width={96} className="text-right">Expansion</TableHead>
                      <TableHead width={72} className="text-right">Risks</TableHead>
                      <TableHead aria-hidden="true" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.customers.map((c) => (
                      <TableRow key={c.id} className="cursor-pointer" onClick={() => open(c.id)}>
                        <TableCell pinned>
                          <a href={`/companies/${encodeURIComponent(c.id)}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(c.id); }} className="flex min-w-0 items-center gap-2 font-medium">
                            <EntityIcon name={c.name} domain={c.domain} className="size-5" />
                            <span className="truncate">{c.name}</span>
                          </a>
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-0 items-center gap-2" title={c.reasons.join("\n") || undefined}>
                            <HealthPill status={c.status} />
                            <span className="truncate text-muted-foreground">{c.reasons[0] ?? (c.last_summary ? c.last_summary : "")}</span>
                          </div>
                        </TableCell>
                        <TableCell className="tabular">{daysAgo(c.days_quiet)}</TableCell>
                        <TableCell className="tabular">{c.next_meeting_at ? meetingWhen(c.next_meeting_at) : <span className="text-faint">None booked</span>}</TableCell>
                        <TableCell className="text-right tabular">
                          {c.ours_open}
                          {c.ours_overdue > 0 && <span className="text-destructive"> · {c.ours_overdue} late</span>}
                        </TableCell>
                        <TableCell className="text-right tabular">{c.theirs_open || <span className="text-faint">0</span>}</TableCell>
                        <TableCell className="text-right tabular">{c.ideas || <span className="text-faint">0</span>}</TableCell>
                        <TableCell className="text-right tabular">{c.expansion || <span className="text-faint">0</span>}</TableCell>
                        <TableCell className={cn("text-right tabular", c.risks > 0 && "text-destructive")}>{c.risks || <span className="text-faint">0</span>}</TableCell>
                        <TableCell aria-hidden="true" />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <Eyebrow>Calls in the next 7 days</Eyebrow>
              {data.upcoming.length === 0 ? (
                <p className="text-sm text-faint">No calls with customers booked this week.</p>
              ) : (
                <ul className="flex flex-col rounded-md bg-card shadow-edge">
                  {data.upcoming.map((m) => (
                    <li key={m.id} className="flex items-start gap-3 px-3.5 py-2.5 [&+li]:border-t [&+li]:border-border">
                      <EntityIcon name={m.company_name} domain={m.company_domain} className="mt-0.5 size-5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <button type="button" className="truncate text-sm font-medium hover:underline" onClick={() => open(m.company_id)}>{m.company_name}</button>
                          <span className="truncate text-[0.8125rem] text-muted-foreground">{m.title}</span>
                        </div>
                        {m.last_summary && <p className="mt-0.5 line-clamp-2 text-[0.8125rem] text-muted-foreground">Last call: {m.last_summary}</p>}
                        {m.ours_open > 0 && <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">{m.ours_open} open {m.ours_open === 1 ? "promise" : "promises"} from us</p>}
                      </div>
                      <span className="shrink-0 tabular text-[0.8125rem]">{meetingWhen(m.starts_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}
