import { useEffect, useRef, useState } from "react";
import { CalendarDays, ExternalLink, FileText, RotateCw } from "lucide-react";
import { useCrm } from "@/context";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MoodPill, meetingWhen } from "@/components/meetings/shared";
import type { Meeting } from "@/types";

const FIRST = 5;

/**
 * A company's meetings from the synced calendar and Granola (Settings →
 * Meetings): the calls coming up, then the ones held, newest first, each with
 * what the call produced once its note was read.
 */
export function MeetingsSection({ companyId, onCount }: { companyId: string; onCount?: (n: number) => void }) {
  const { setError, changes } = useCrm();
  const [upcoming, setUpcoming] = useState<Meeting[]>([]);
  const [past, setPast] = useState<{ meetings: Meeting[]; total: number } | null>(null);
  const [all, setAll] = useState(false);

  const load = async () => {
    try {
      const id = encodeURIComponent(companyId);
      const [next, held] = await Promise.all([
        api<{ meetings: Meeting[] }>("GET", `/api/meetings?company_id=${id}&when=upcoming&limit=3`),
        api<{ meetings: Meeting[]; total: number }>("GET", `/api/meetings?company_id=${id}&when=past&limit=${all ? 100 : FIRST}`),
      ]);
      setUpcoming(next.meetings);
      setPast(held);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load meetings");
    }
  };

  const seen = useRef(changes);
  useEffect(() => { void load(); }, [companyId, all]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (seen.current === changes) return;
    seen.current = changes;
    void load();
  }, [changes]); // eslint-disable-line react-hooks/exhaustive-deps

  // While a call is being read, look again now and then.
  const reading = (past?.meetings ?? []).some((m) => m.digest_status === "queued" || m.digest_status === "running");
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [reading]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = (past?.total ?? 0) + upcoming.length;
  useEffect(() => { onCount?.(total); }, [total]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = async (m: Meeting) => {
    try {
      await api("POST", `/api/meetings/${encodeURIComponent(m.id)}/digest`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the call again");
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-9 items-center justify-between">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium">
          Meetings <span className="rounded-xs bg-secondary px-1.5 text-xs tabular text-muted-foreground">{total}</span>
        </h2>
        {(past?.total ?? 0) > FIRST && (
          <button type="button" onClick={() => setAll((v) => !v)} className="text-[0.8125rem] text-muted-foreground hover:text-foreground">
            {all ? "Show fewer" : "View all"}
          </button>
        )}
      </div>

      {past && total === 0 ? (
        <p className="text-sm text-faint">No meetings yet. Calls on the synced calendar show here (Settings → Meetings).</p>
      ) : (
        <ul className="flex flex-col rounded-md bg-card shadow-edge">
          {upcoming.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-3.5 py-2.5 [&+li]:border-t [&+li]:border-border">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-info-tint text-info"><CalendarDays className="size-3" /></span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{m.title || "Untitled meeting"}</div>
                <div className="truncate text-[0.8125rem] text-muted-foreground">{people(m)}</div>
              </div>
              <span className="shrink-0 tabular text-[0.8125rem] text-foreground">{meetingWhen(m.starts_at)}</span>
              {m.calendar_url && <LinkOut href={m.calendar_url} label="Open in Google Calendar" icon={CalendarDays} />}
            </li>
          ))}
          {(past?.meetings ?? []).map((m) => (
            <li key={m.id} className="flex flex-col gap-1.5 px-3.5 py-2.5 [&+li]:border-t [&+li]:border-border">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"><CalendarDays className="size-3" /></span>
                <div className="min-w-0 flex-1 truncate text-sm font-medium">{m.title || "Untitled meeting"}</div>
                <MoodPill value={m.sentiment} reason={m.sentiment_reason} />
                <span className="shrink-0 tabular text-xs text-muted-foreground">{meetingWhen(m.starts_at)}</span>
                {m.note_url && <LinkOut href={m.note_url} label="Open the Granola note" icon={FileText} />}
                {m.calendar_url && <LinkOut href={m.calendar_url} label="Open in Google Calendar" icon={CalendarDays} />}
              </div>
              <div className="pl-9 text-sm">
                {m.summary ? (
                  <p className="text-foreground">{m.summary}</p>
                ) : m.digest_status === "queued" || m.digest_status === "running" ? (
                  <p className="text-faint">Reading the call…</p>
                ) : m.digest_status === "error" ? (
                  <p className="flex items-center gap-2 text-[0.8125rem] text-destructive">
                    Couldn't read the call: {m.digest_error}
                    <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => void retry(m)}><RotateCw className="size-3" /> Retry</Button>
                  </p>
                ) : !m.has_note ? (
                  <p className="text-[0.8125rem] text-faint">{people(m) || "No notes"}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function people(m: Meeting): string {
  return m.attendees.map((p) => p.name || p.email).join(", ");
}

function LinkOut({ href, label, icon: Icon }: { href: string; label: string; icon: typeof ExternalLink }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" asChild className="size-7 shrink-0">
          <a href={href} target="_blank" rel="noreferrer" aria-label={label}><Icon className="size-3.5" /></a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
