import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ExternalLink, Plus } from "lucide-react";
import { useCrm } from "@/context";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { formatDate, cn } from "@/lib/utils";
import type { ContactEmail } from "@/types";

const FIRST = 5;

/**
 * A contact's emails from the synced Gmail (Settings → Email), newest first.
 * What each row shows is the mailbox's visibility: the subject only when it
 * shares subjects, the text (read live from Gmail) only when it shares everything.
 * Re-reads on `changes`, so the chat's edits and a sync show without a reload.
 */
export function ContactEmails({ contactId, contactName, onCompose, canCompose, navigate }: {
  contactId: string;
  contactName: string;
  onCompose: () => void;
  canCompose: boolean;
  navigate: (to: string) => void;
}) {
  const { changes } = useCrm();
  const [data, setData] = useState<{ emails: ContactEmail[]; total: number; sync_on: boolean } | null>(null);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Record<string, string | null>>({});

  const load = () =>
    api<{ emails: ContactEmail[]; total: number; sync_on: boolean }>("GET", `/api/contacts/${encodeURIComponent(contactId)}/emails`)
      .then(setData, () => setData({ emails: [], total: 0, sync_on: false }));

  const seen = useRef(changes);
  useEffect(() => { void load(); }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (seen.current === changes) return;
    seen.current = changes;
    void load();
  }, [changes]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (e: ContactEmail) => {
    if (e.id in open) {
      setOpen(({ [e.id]: _, ...rest }) => rest);
      return;
    }
    setOpen((o) => ({ ...o, [e.id]: null }));
    try {
      const r = await api<{ text: string }>("GET", `/api/emails/${encodeURIComponent(e.mailbox)}/${encodeURIComponent(e.id)}`);
      setOpen((o) => ({ ...o, [e.id]: r.text || "(This email has no text.)" }));
    } catch (err) {
      setOpen((o) => ({ ...o, [e.id]: err instanceof Error ? err.message : "Could not open this email" }));
    }
  };

  const emails = data?.emails ?? [];
  const shown = all ? emails : emails.slice(0, FIRST);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-9 items-center justify-between">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium">
          Emails <span className="rounded-xs bg-secondary px-1.5 text-xs tabular text-muted-foreground">{data?.total ?? 0}</span>
        </h2>
        <Button variant="ghost" size="icon" aria-label="Compose email" title={canCompose ? "Compose email" : "Connect Gmail in Clawnify"} disabled={!canCompose} onClick={onCompose}>
          <Plus className="size-4" />
        </Button>
      </div>

      {!data ? null : emails.length === 0 ? (
        data.sync_on ? (
          <p className="text-sm text-faint">No emails with {contactName} yet.</p>
        ) : (
          <p className="text-sm text-faint">
            Turn on email sync to see emails with {contactName} here.{" "}
            <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => navigate("/settings/email")}>Settings → Email</button>
          </p>
        )
      ) : (
        <ul className="flex flex-col rounded-md bg-card shadow-edge">
          {shown.map((e) => {
            const sent = e.direction === "sent";
            const other = sent ? e.to_emails.join(", ") : e.from_name || e.from_email;
            const body = open[e.id];
            return (
              <li key={`${e.mailbox}:${e.id}`} className="[&+li]:border-t [&+li]:border-border">
                <div className="flex items-start gap-3 px-3.5 py-2.5">
                  <span className={cn("mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full", sent ? "bg-secondary text-muted-foreground" : "bg-info-tint text-info")}>
                    {sent ? <ArrowUpRight className="size-3" /> : <ArrowDownLeft className="size-3" />}
                  </span>
                  <button
                    type="button" disabled={!e.can_open} onClick={() => void toggle(e)} aria-expanded={e.can_open ? e.id in open : undefined}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:cursor-default"
                  >
                    <span className={cn("truncate text-sm", e.subject ? "text-foreground" : "text-muted-foreground")}>{e.subject || (sent ? "Email sent" : "Email received")}</span>
                    <span className="truncate text-xs text-muted-foreground">{sent ? `You → ${other}` : `${other} → you`}</span>
                  </button>
                  <span className="shrink-0 tabular text-xs text-muted-foreground">{formatDate(e.sent_at)}</span>
                  <a href={e.gmail_url} target="_blank" rel="noreferrer" aria-label="Open in Gmail" title={`Open in Gmail (${e.mailbox})`} className="shrink-0 text-muted-foreground hover:text-foreground">
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
                {e.id in open && (
                  <p className="mx-3.5 mb-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-secondary/50 p-3 text-[0.8125rem]">
                    {body ?? "Loading…"}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {emails.length > FIRST && (
        <button type="button" onClick={() => setAll((v) => !v)} className="self-start text-[0.8125rem] text-muted-foreground hover:text-foreground">
          {all ? "Show fewer" : data && data.total > emails.length ? `Show the latest ${emails.length} of ${data.total}` : `Show all ${emails.length}`}
        </button>
      )}
    </section>
  );
}
