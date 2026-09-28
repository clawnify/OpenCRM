import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Mail, RefreshCw, AlertTriangle } from "lucide-react";
import { useCrm } from "@/context";
import { api } from "@/api";
import { PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { EmailAccountSettings, EmailAutoCreate, EmailHistory, EmailSyncStatus, EmailVisibility } from "@/types";

const VISIBILITY: Array<{ value: EmailVisibility; label: string; hint: string }> = [
  { value: "everything", label: "Everything", hint: "Subject, and the email itself, opened from Gmail when someone reads it. The body is never stored." },
  { value: "subject", label: "Subject and metadata", hint: "Subject, sender, recipients and time." },
  { value: "metadata", label: "Metadata", hint: "Sender, recipients and time." },
];
const AUTO_CREATE: Array<{ value: EmailAutoCreate; label: string; hint: string }> = [
  { value: "sent_and_received", label: "Sent and received", hint: "People you've sent emails to and received emails from." },
  { value: "sent", label: "Sent", hint: "People you've sent emails to." },
  { value: "none", label: "None", hint: "Don't create contacts." },
];
const HISTORY: Array<{ value: EmailHistory; label: string; hint: string }> = [
  { value: "3m", label: "Last 3 months", hint: "Quickest first import." },
  { value: "12m", label: "Last 12 months", hint: "A year of relationships." },
  { value: "all", label: "All time", hint: "Everything in the mailbox. A large mailbox takes a while." },
];

/** The defaults a mailbox starts with, before anything is saved. Mirror the server's. */
const DEFAULTS: Pick<EmailAccountSettings, "labels" | "history" | "visibility" | "auto_create" | "exclude_group" | "exclude_personal" | "blocklist"> = {
  labels: [], history: "12m", visibility: "metadata", auto_create: "sent", exclude_group: true, exclude_personal: true, blocklist: [],
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ago(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`).getTime();
  const min = Math.round((Date.now() - t) / 60_000);
  if (Number.isNaN(min)) return iso;
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : new Date(t).toLocaleDateString();
}

/**
 * Settings → Email. The org's connected Gmail, what the CRM reads from it and
 * what everyone in the workspace sees. Choices save as they're made; turning
 * sync on or off asks first, because both have consequences worth reading.
 */
export function EmailSyncPage() {
  const { setError, recordsChanged } = useCrm();
  const [status, setStatus] = useState<EmailSyncStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<"on" | "off" | null>(null);
  const [labels, setLabels] = useState<Array<{ id: string; name: string }> | null>(null);
  const [blocklist, setBlocklist] = useState("");

  const load = useCallback(async () => {
    try {
      const s = await api<EmailSyncStatus>("GET", "/api/email-sync?check=1");
      setStatus(s);
      return s;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load email sync");
      return null;
    }
  }, [setError]);

  useEffect(() => {
    void load().then((s) => setBlocklist((s?.account?.blocklist ?? []).join("\n")));
  }, [load]);

  // Follow a running import closely, a live mailbox now and then.
  const phase = status?.account?.enabled ? status.account.phase : null;
  useEffect(() => {
    if (!phase) return;
    const t = setInterval(() => void load(), phase === "importing" ? 4000 : 60_000);
    return () => clearInterval(t);
  }, [phase, load]);

  const account = status?.account ?? null;
  const settings = account ?? { ...DEFAULTS, enabled: false };
  const editable = !!status?.can_configure && !saving;

  // Labels are read when "Some labels" is on screen.
  const someLabels = settings.labels.length > 0;
  useEffect(() => {
    if (!someLabels || labels || !status?.can_configure) return;
    api<{ labels: Array<{ id: string; name: string }> }>("GET", "/api/email-sync/labels").then((r) => setLabels(r.labels), (e) => setError(e.message));
  }, [someLabels, labels, status?.can_configure, setError]);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      const r = await api<{ account: EmailAccountSettings; counts: EmailSyncStatus["counts"] }>("PUT", "/api/email-sync", patch);
      setStatus((s) => (s ? { ...s, account: r.account, counts: r.counts, mailbox: r.account.mailbox, mailbox_changed: false } : s));
      if ("enabled" in patch) await recordsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const syncNow = async () => {
    setSaving(true);
    try {
      const r = await api<{ account: EmailAccountSettings | null; counts: EmailSyncStatus["counts"]; error?: string }>("POST", "/api/email-sync/run", {});
      setStatus((s) => (s ? { ...s, account: r.account ?? s.account, counts: r.counts } : s));
      await recordsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sync");
    } finally {
      setSaving(false);
    }
  };

  if (!status) {
    return (
      <>
        <PageHeader title="Email" />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>
      </>
    );
  }

  const on = !!account?.enabled;
  const label = (list: Array<{ value: string; label: string }>, v: string) => list.find((x) => x.value === v)?.label ?? v;

  return (
    <>
      <PageHeader title="Email" />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          <p className="text-sm text-muted-foreground">
            Sync the workspace's connected Gmail: see when you last emailed each contact, and their emails on their page.
            Email bodies stay in Gmail.
          </p>

          {!status.connected ? (
            <section className="rounded-md p-4 shadow-edge">
              <p className="text-sm">Gmail isn't connected. Connect Gmail in Clawnify (Settings → Integrations), then come back here.</p>
            </section>
          ) : (
            <section aria-label="Mailbox" className="flex flex-col gap-3 rounded-md p-4 shadow-edge">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-info-tint text-info"><Mail className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{status.mailbox ?? "Connected Gmail"}</div>
                  <div className="text-[0.8125rem] text-muted-foreground">
                    {!on ? "Sync is off" : account!.phase === "importing" ? "Importing…" : `On · last synced ${ago(account!.last_run_at)}`}
                    {on && ` · ${plural(status.counts.emails, "email")} with ${plural(status.counts.contacts, "contact")}`}
                    {on && account!.contacts_created > 0 && ` · ${plural(account!.contacts_created, "contact")} added`}
                  </div>
                </div>
                {status.can_configure && (on ? (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => void syncNow()} disabled={saving}><RefreshCw className="size-4" /> Sync now</Button>
                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirm("off")} disabled={saving}>Turn off</Button>
                  </div>
                ) : (
                  <Button size="sm" onClick={() => setConfirm("on")} disabled={saving}>Turn on sync</Button>
                ))}
              </div>
              {status.mailbox_changed && account && (
                <Notice>
                  The Google connection now signs in as {status.mailbox}. Turning sync on switches to it and deletes what was synced from {account.mailbox}.
                </Notice>
              )}
              {on && account!.last_error && !status.mailbox_changed && <Notice>{account!.last_error}</Notice>}
              {!status.can_configure && <p className="text-[0.8125rem] text-muted-foreground">Only people signed in to Clawnify can change these settings.</p>}
            </section>
          )}

          {status.connected && (
            <>
              <Section title="Import" description="Which mail the sync reads. Addresses on the blocklist are always skipped.">
                <Choices
                  name="scope" disabled={!editable}
                  value={someLabels ? "labels" : "all"}
                  options={[
                    { value: "all", label: "Everything", hint: "All mail." },
                    { value: "labels", label: "Some labels", hint: "Only mail with the labels you pick." },
                  ]}
                  onChange={(v) => {
                    if (v === "all") void save({ labels: [] });
                    else if (!someLabels) api<{ labels: Array<{ id: string; name: string }> }>("GET", "/api/email-sync/labels").then((r) => {
                      setLabels(r.labels);
                      if (r.labels.length) void save({ labels: [r.labels[0].name] });
                      else setError("This mailbox has no labels of its own yet. Create one in Gmail first.");
                    }, (e) => setError(e.message));
                  }}
                />
                {someLabels && (
                  <div className="flex flex-wrap gap-2 pt-1" role="group" aria-label="Labels to import">
                    {(labels ?? settings.labels.map((n) => ({ id: n, name: n }))).map((l) => {
                      const picked = settings.labels.includes(l.name);
                      return (
                        <button
                          key={l.id} type="button" disabled={!editable} aria-pressed={picked}
                          onClick={() => {
                            const next = picked ? settings.labels.filter((n) => n !== l.name) : [...settings.labels, l.name];
                            if (next.length) void save({ labels: next });
                          }}
                          className={cn("rounded-xs px-2 py-1 text-[0.8125rem]", picked ? "bg-foreground text-background" : "bg-secondary text-muted-foreground hover:text-foreground")}
                        >
                          {l.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="pt-2 text-[0.8125rem] font-medium text-muted-foreground">How far back</div>
                <Choices name="history" disabled={!editable} value={settings.history} options={HISTORY} onChange={(v) => void save({ history: v })} />
              </Section>

              <Section title="Visibility" description="What everyone in this workspace sees of emails with contacts.">
                <Choices name="visibility" disabled={!editable} value={settings.visibility} options={VISIBILITY} onChange={(v) => void save({ visibility: v })} />
              </Section>

              <Section title="Contact auto-creation" description="Create contacts from this mailbox automatically.">
                <Choices name="auto_create" disabled={!editable} value={settings.auto_create} options={AUTO_CREATE} onChange={(v) => void save({ auto_create: v })} />
              </Section>

              <Section title="Options" description="Which emails count.">
                <Toggle
                  label="Exclude group emails" hint="Don't import emails from team@, support@, noreply@…"
                  checked={settings.exclude_group} disabled={!editable} onChange={(v) => void save({ exclude_group: v })}
                />
                <Toggle
                  label="Exclude non-professional emails" hint="Don't create contacts from Gmail, Outlook and other personal addresses."
                  checked={settings.exclude_personal} disabled={!editable} onChange={(v) => void save({ exclude_personal: v })}
                />
              </Section>

              <Section title="Blocklist" description="Emails from these addresses or domains are never imported. One per line, like ada@example.com or example.com.">
                <Textarea
                  aria-label="Blocklist" value={blocklist} disabled={!editable} rows={4}
                  onChange={(e) => setBlocklist(e.target.value)}
                />
                <div className="flex justify-end pt-2">
                  <Button
                    size="sm" variant="outline" disabled={!editable || blocklist.split("\n").map((l) => l.trim()).filter(Boolean).join("\n") === settings.blocklist.join("\n")}
                    onClick={() => void save({ blocklist: blocklist.split("\n").map((l) => l.trim()).filter(Boolean) })}
                  >
                    Save blocklist
                  </Button>
                </div>
              </Section>
            </>
          )}
        </div>
      </div>

      <Dialog open={confirm === "on"} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Turn on email sync?</DialogTitle>
            <DialogDescription>
              The CRM will read {status.mailbox} and keep a record of each email with a contact.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-1.5 text-sm">
            <li>Everyone in this workspace sees: <strong>{label(VISIBILITY, settings.visibility)}</strong></li>
            <li>New contacts from: <strong>{label(AUTO_CREATE, settings.auto_create)}</strong></li>
            <li>First import reads: <strong>{label(HISTORY, settings.history)}</strong></li>
          </ul>
          <DialogFooter>
            <DialogClose asChild><Button size="sm" variant="outline">Cancel</Button></DialogClose>
            <Button size="sm" disabled={saving} onClick={() => { setConfirm(null); void save({ enabled: true }); }}>Turn on</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm === "off"} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Turn off email sync?</DialogTitle>
            <DialogDescription>
              This deletes the {status.counts.emails} synced emails from the CRM and clears "last contacted". Contacts the sync added stay.
              Gmail itself is not touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild><Button size="sm" variant="outline">Cancel</Button></DialogClose>
            <Button size="sm" variant="destructive" disabled={saving} onClick={() => { setConfirm(null); void save({ enabled: false }); }}>Turn off</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="text-[0.8125rem] text-muted-foreground">{description}</p>
      <div className="flex flex-col gap-2 pt-1">{children}</div>
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-warning-tint px-3 py-2 text-[0.8125rem] text-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> <span>{children}</span>
    </p>
  );
}

/** One choice from a few, as the cards Twenty uses: the whole row is the control. */
function Choices<T extends string>({ name, value, options, onChange, disabled }: {
  name: string;
  value: T;
  options: Array<{ value: T; label: string; hint: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-col rounded-md shadow-edge">
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value} type="button" role="radio" aria-checked={checked} disabled={disabled}
            onClick={() => { if (!checked) onChange(o.value); }}
            className="flex items-center gap-3 px-4 py-3 text-left disabled:opacity-60 [&+button]:border-t [&+button]:border-border hover:bg-secondary/50"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-[0.8125rem] text-muted-foreground">{o.hint}</span>
            </span>
            <span aria-hidden className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-full border", checked ? "border-foreground" : "border-border")}>
              {checked && <span className="size-2 rounded-full bg-foreground" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-3 rounded-md px-4 py-3 text-left shadow-edge disabled:opacity-60 hover:bg-secondary/50"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[0.8125rem] text-muted-foreground">{hint}</span>
      </span>
      <span aria-hidden className={cn("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-foreground" : "bg-border")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-background transition-transform", checked ? "translate-x-[1.125rem]" : "translate-x-0.5")} />
      </span>
    </button>
  );
}
