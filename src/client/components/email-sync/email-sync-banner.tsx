import { useEffect, useState } from "react";
import { Mail, X } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import type { EmailSyncStatus } from "@/types";

const DISMISSED = "opencrm.emailSyncBanner.dismissed";

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
}

/**
 * The first time the CRM sees a connected Gmail it has never been set up to
 * sync, it says so, once, above the contacts list. Only to someone who can set
 * it up; dismissing it is remembered in this browser.
 */
export function EmailSyncBanner({ navigate }: { navigate: (to: string) => void }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (wasDismissed()) return;
    let alive = true;
    api<EmailSyncStatus>("GET", "/api/email-sync")
      .then((s) => { if (alive) setShow(s.connected && !s.account && s.can_configure); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!show) return null;
  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {
      /* private window: it shows again next time */
    }
  };

  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-border bg-info-tint px-6 py-2.5 text-sm">
      <Mail className="size-4 shrink-0 text-info" />
      <p className="min-w-0 flex-1">Gmail is connected. Sync it to see when you last emailed each contact, and their emails on their page.</p>
      <Button size="sm" variant="outline" onClick={() => navigate("/settings/email")}>Choose what to sync</Button>
      <Button size="icon" variant="ghost" onClick={dismiss} aria-label="Dismiss" title="Dismiss"><X className="size-4" /></Button>
    </div>
  );
}
