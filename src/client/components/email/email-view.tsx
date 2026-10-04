import { useEffect, useState } from "react";
import { ExternalLink, Forward, Mail, Reply, ReplyAll } from "lucide-react";
import { api } from "@/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar } from "@/components/shared";
import { useComposer, type Draft } from "@/components/email/composer";
import type { ContactEmail, EmailAddress, OpenedEmail } from "@/types";

const label = (a: EmailAddress) => a.name || a.email;
const names = (list: EmailAddress[]) => {
  const all = list.map(label);
  return all.length <= 2 ? all.join(" and ") : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
};
const strip = (subject: string) => subject.replace(/^((re|fwd?):\s*)+/i, "");

/**
 * Who a reply goes to. To the sender, or, for an email this mailbox sent, to
 * the people it went to. Reply all adds everyone else on To and Cc. The
 * mailbox itself is never a recipient.
 */
export function replyRecipients(e: OpenedEmail, mailbox: string, all: boolean): Pick<Draft, "to" | "cc"> {
  const me = mailbox.toLowerCase();
  const seen = new Set([me]);
  const take = (list: EmailAddress[]) => list.filter((a) => !seen.has(a.email) && seen.add(a.email));
  const to = take(e.direction === "sent" ? e.to : e.from ? [e.from] : []);
  if (!all) return { to, cc: [] };
  return { to: [...to, ...take(e.to)], cc: take(e.cc) };
}

/** One synced email, opened: who it went between, its text, and Reply / Reply all / Forward. */
export function EmailView({ email, onClose }: { email: ContactEmail | null; onClose: () => void }) {
  const { compose } = useComposer();
  const [opened, setOpened] = useState<OpenedEmail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!email) return;
    setOpened(null);
    setError(null);
    api<OpenedEmail>("GET", `/api/emails/${encodeURIComponent(email.mailbox)}/${encodeURIComponent(email.id)}`)
      .then(setOpened, (e) => setError(e instanceof Error ? e.message : "Could not open this email"));
  }, [email?.mailbox, email?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const when = email ? new Date(email.sent_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const subject = opened?.subject || email?.subject || "";
  const from = opened?.from ?? (email ? { email: email.from_email, name: email.from_name } : null);
  const fromParts = (from ? label(from) : "").split(" ");

  const start = (mode: "reply" | "replyAll" | "forward") => {
    if (!email || !opened) return;
    const ref = { mailbox: email.mailbox, id: email.id };
    if (mode === "forward") {
      compose({ mode: "forward", ref, subject: `Fwd: ${strip(subject)}`, about: `Forwarding ${from ? label(from) : "this email"}'s email of ${when}, below your note.` });
    } else {
      compose({ mode: "reply", ref, subject: `Re: ${strip(subject)}`, about: opened.direction === "sent" || !from ? "Following up in this thread" : `Replying to ${label(from)}`, ...replyRecipients(opened, email.mailbox, mode === "replyAll") });
    }
    onClose();
  };

  const action = (mode: "reply" | "replyAll" | "forward", text: string, Icon: typeof Reply) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={text} disabled={!opened} onClick={() => start(mode)}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );

  return (
    <Dialog open={!!email} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(44rem,calc(100vh-4rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-sm text-muted-foreground">
          <Mail className="size-4" aria-hidden /> View email
        </div>
        <div className="flex shrink-0 items-start gap-3 px-5 pt-4">
          <DialogTitle className="min-w-0 flex-1 text-base leading-6">{subject || "(no subject)"}</DialogTitle>
          {email && (
            <a href={email.gmail_url} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 text-[0.8125rem] text-muted-foreground hover:text-foreground">
              Open in Gmail <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
        <div className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-3">
          <Avatar firstName={fromParts[0]} lastName={fromParts.slice(1).join(" ")} className="size-8" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium" title={from?.email}>{from ? label(from) : ""}</span>
            <DialogDescription className="truncate text-xs">
              {opened ? `To ${names(opened.to) || "(no recipients)"}${opened.cc.length ? `, cc ${names(opened.cc)}` : ""}` : email ? `To ${email.to_emails.join(", ")}` : ""}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {action("reply", "Reply", Reply)}
            {action("replyAll", "Reply all", ReplyAll)}
            {action("forward", "Forward", Forward)}
            <span className="ml-1.5 tabular text-xs text-muted-foreground">{when}</span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <p className="whitespace-pre-wrap text-sm leading-6">
            {error ? <span className="text-destructive">{error}</span> : opened ? opened.text || "(This email has no text.)" : <span className="text-muted-foreground">Loading…</span>}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
