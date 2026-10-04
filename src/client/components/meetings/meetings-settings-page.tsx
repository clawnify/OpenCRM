import { useCallback, useEffect, useState } from "react";
import { CalendarDays, FileText, Link2, RefreshCw } from "lucide-react";
import { useCrm } from "@/context";
import { api } from "@/api";
import { PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Section, Notice, Choices } from "@/components/settings-ui";
import { RecordPicker } from "@/lib/relations";
import { meetingWhen } from "@/components/meetings/shared";
import type { Meeting, MeetingSyncStatus } from "@/types";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ago(iso: string | null): string {
  if (!iso) return "never";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(min)) return iso;
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString();
}

const HISTORY_LABEL: Record<number, { label: string; hint: string }> = {
  30: { label: "Last 30 days", hint: "Quickest first import." },
  90: { label: "Last 90 days", hint: "A quarter of calls." },
  365: { label: "Last 12 months", hint: "A year of calls. Older calls bring their summary and ideas, not tasks." },
};

/**
 * Settings → Meetings. The workspace's calendar and Granola call notes, read
 * into the CRM: each meeting with people from outside lands on its company, and
 * each call's summary, promises and ideas become tasks and insights. Meetings
 * the CRM can't place wait here for someone to link them.
 */
export function MeetingsSettingsPage() {
  const { setError, recordsChanged } = useCrm();
  const [status, setStatus] = useState<MeetingSyncStatus | null>(null);
  const [unmatched, setUnmatched] = useState<{ meetings: Meeting[]; total: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [about, setAbout] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, u] = await Promise.all([
        api<MeetingSyncStatus>("GET", "/api/meetings/sync"),
        api<{ meetings: Meeting[]; total: number }>("GET", "/api/meetings?link=unmatched&limit=50"),
      ]);
      setStatus(s);
      setUnmatched(u);
      return s;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load meeting sync");
      return null;
    }
  }, [setError]);

  useEffect(() => {
    void load().then((s) => setAbout(s?.settings?.about ?? ""));
  }, [load]);

  // Follow an import (and calls being read) closely, a live sync now and then.
  const settings = status?.settings ?? null;
  const busy = !!settings?.enabled && (settings.phase === "importing" || (status?.counts.waiting ?? 0) > 0);
  useEffect(() => {
    if (!settings?.enabled) return;
    const t = setInterval(() => void load(), busy ? 5000 : 60_000);
    return () => clearInterval(t);
  }, [settings?.enabled, busy, load]);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      const r = await api<Pick<MeetingSyncStatus, "settings" | "counts">>("PUT", "/api/meetings/sync", patch);
      setStatus((s) => (s ? { ...s, ...r } : s));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const syncNow = async () => {
    setSaving(true);
    try {
      await api("POST", "/api/meetings/sync-now", {});
      await load();
      await recordsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sync");
    } finally {
      setSaving(false);
    }
  };

  const link = async (m: Meeting, to: { company_id: string } | { ignored: true }) => {
    // Off the list at once; the reload then brings in what else the link placed.
    setUnmatched((u) => (u ? { meetings: u.meetings.filter((x) => x.id !== m.id), total: Math.max(0, u.total - 1) } : u));
    try {
      await api("PATCH", `/api/meetings/${encodeURIComponent(m.id)}`, to);
      await load();
      await recordsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link the meeting");
      await load();
    }
  };

  if (!status) {
    return (
      <>
        <PageHeader title="Meetings" />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>
      </>
    );
  }

  const on = !!settings?.enabled;
  const editable = status.can_configure && !saving;
  const { counts } = status;
  const history = settings?.history_days ?? 90;

  return (
    <>
      <PageHeader title="Meetings" />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          <p className="text-sm text-muted-foreground">
            Read the workspace's calendar and Granola call notes. Every meeting with people from outside lands on its company,
            and each call's summary, promises and ideas become tasks and insights for that account. Transcripts stay in Granola.
          </p>

          <section aria-label="Sources" className="flex flex-col rounded-md shadow-edge">
            <Source icon={CalendarDays} name="Google Calendar" connected={status.sources.calendar}
              detail={status.sources.calendar ? settings?.calendar_owner ?? "Connected" : "Not connected. Connect Google Calendar in Clawnify (Settings → Integrations)."} />
            <Source icon={FileText} name="Granola" connected={status.sources.notes}
              detail={status.sources.notes ? "Call notes and transcripts" : "Not connected. Without it, meetings come in without what was said in them."} />
          </section>

          <section aria-label="Sync" className="flex flex-col gap-3 rounded-md p-4 shadow-edge">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{!on ? "Sync is off" : settings!.phase === "importing" ? "Importing…" : `On · last read ${ago(settings!.calendar_synced_at)}`}</div>
                {on && (
                  <div className="text-[0.8125rem] text-muted-foreground">
                    {plural(counts.meetings, "meeting")} · {counts.linked} on a company · {plural(counts.digested, "call")} read
                    {counts.waiting > 0 && ` · ${counts.waiting} being read`}
                    {counts.failed > 0 && ` · ${counts.failed} couldn't be read`}
                  </div>
                )}
              </div>
              {status.can_configure && (on ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => void syncNow()} disabled={saving}><RefreshCw className="size-4" /> Sync now</Button>
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void save({ enabled: false })} disabled={saving}>Turn off</Button>
                </div>
              ) : (
                <Button size="sm" onClick={() => setConfirm(true)} disabled={saving || !status.sources.calendar}>Turn on sync</Button>
              ))}
            </div>
            {on && settings!.last_error && <Notice>{settings!.last_error}</Notice>}
            {!status.can_configure && <p className="text-[0.8125rem] text-muted-foreground">Only people signed in to Clawnify can change these settings.</p>}
          </section>

          <Section title="How far back" description="The first import reads this far back. Reaching further later reads the older calls too.">
            <Choices
              name="history" disabled={!editable} value={String(history)}
              options={status.history_choices.map((d) => ({ value: String(d), label: HISTORY_LABEL[d]?.label ?? `Last ${d} days`, hint: HISTORY_LABEL[d]?.hint ?? "" }))}
              onChange={(v) => void save({ history_days: Number(v) })}
            />
          </Section>

          <Section title="What you sell" description="One or two sentences. The AI uses it to spot ideas worth proposing and room to expand in each call.">
            <Textarea aria-label="What you sell" value={about} disabled={!editable} rows={3} maxLength={1000}
              placeholder="e.g. Custom internal apps and AI agents for service companies, built on Clawnify."
              onChange={(e) => setAbout(e.target.value)} />
            <div className="flex justify-end pt-2">
              <Button size="sm" variant="outline" disabled={!editable || about.trim() === (settings?.about ?? "")} onClick={() => void save({ about })}>Save</Button>
            </div>
          </Section>

          <Section
            title={`Unmatched meetings${unmatched?.total ? ` (${unmatched.total})` : ""}`}
            description="Meetings with people the CRM doesn't know yet. Link one to a company and its other meetings with people from the same domain follow."
          >
            {!unmatched?.meetings.length ? (
              <p className="text-sm text-faint">Nothing to link.</p>
            ) : (
              <ul className="flex flex-col rounded-md shadow-edge">
                {unmatched.meetings.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 [&+li]:border-t [&+li]:border-border">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{m.title || "Untitled meeting"}</div>
                      <div className="truncate text-[0.8125rem] text-muted-foreground">
                        {meetingWhen(m.starts_at)}{m.attendees.length ? ` · ${m.attendees.map((p) => p.name || p.email).join(", ")}` : ""}
                      </div>
                    </div>
                    <LinkMenu meeting={m} onLink={(id) => void link(m, { company_id: id })} />
                    <Button size="sm" variant="ghost" onClick={() => void link(m, { ignored: true })}>Ignore</Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>

      <Dialog open={confirm} onOpenChange={(o) => !o && setConfirm(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Turn on meeting sync?</DialogTitle>
            <DialogDescription>
              The CRM will read {settings?.calendar_owner ?? "the connected calendar"}{status.sources.notes ? " and its Granola notes" : ""}, from {HISTORY_LABEL[history]?.label.toLowerCase() ?? `the last ${history} days`} on.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-1.5 text-sm">
            <li>Everyone in this workspace sees each meeting with people from outside, on its company.</li>
            <li>Meetings with only your own team are never shown.</li>
            {status.sources.notes && <li>Each linked call is read by the AI once (charged to your Clawnify credits) for a summary, promises and ideas. Transcripts are not stored.</li>}
          </ul>
          <DialogFooter>
            <DialogClose asChild><Button size="sm" variant="outline">Cancel</Button></DialogClose>
            <Button size="sm" disabled={saving} onClick={() => { setConfirm(false); void save({ enabled: true }); }}>Turn on</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Source({ icon: Icon, name, connected, detail }: { icon: typeof CalendarDays; name: string; connected: boolean; detail: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 [&+div]:border-t [&+div]:border-border">
      <span className={connected ? "inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-info-tint text-info" : "inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{name}</div>
        <div className="truncate text-[0.8125rem] text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

/** Link to an existing company, or add one named as typed; its domain then comes from the people met. */
function LinkMenu({ meeting, onLink }: { meeting: Meeting; onLink: (companyId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" aria-label={`Link ${meeting.title || "meeting"} to a company`}><Link2 className="size-3.5" /> Link</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <RecordPicker entity="company" selected={[]} creatable placeholder="Find or add a company…"
          onPick={(r) => { setOpen(false); onLink(r.id); }} />
      </PopoverContent>
    </Popover>
  );
}
