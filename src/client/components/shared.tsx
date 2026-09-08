import { useState, type ReactNode } from "react";
import { cn, getInitials, categoryClasses } from "../lib/utils";
import { Badge } from "./ui/badge";

/** Initials avatar tinted by a stable category color. */
export function Avatar({ firstName, lastName, className }: { firstName?: string | null; lastName?: string | null; className?: string }) {
  const initials = getInitials(firstName, lastName);
  const c = categoryClasses(`${firstName ?? ""} ${lastName ?? ""}`.trim() || "?");
  return (
    <span className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold", c.bg, c.text, className)}>
      {initials}
    </span>
  );
}

/** Company icon: favicon from the domain, letter fallback tinted by name. */
export function EntityIcon({ name, domain, className }: { name: string; domain?: string | null; className?: string }) {
  const [err, setErr] = useState(false);
  const c = categoryClasses(name);
  // Tolerate a stored value that's a full URL ("https://www.acme.com/x") — the
  // favicon service needs a bare host ("acme.com").
  const host = (domain || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "");
  if (host && !err) {
    return (
      <span className={cn("inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-secondary", className)}>
        <img src={`https://www.google.com/s2/favicons?sz=64&domain=${host}`} alt="" width={16} height={16} onError={() => setErr(true)} />
      </span>
    );
  }
  return (
    <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-[0.625rem] font-semibold", c.bg, c.text, className)}>
      {(name?.[0] || "?").toUpperCase()}
    </span>
  );
}

/** A quiet, fact-style category badge (status, stage, industry). Color = data. */
export function CategoryBadge({ value, className }: { value?: string | null; className?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const c = categoryClasses(value);
  return (
    <span
      title={value}
      className={cn("inline-block max-w-[12rem] truncate rounded-full px-2.5 py-1 align-middle text-xs font-medium capitalize", c.bg, c.text, className)}
    >
      {value}
    </span>
  );
}

/** Sticky page toolbar: heading-1 left (with live count), actions right. */
export function PageHeader({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">{title}</h1>
        {count !== undefined && (
          <span className="tabular text-[0.8125rem] text-muted-foreground">{count} {count === 1 ? "record" : "records"}</span>
        )}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}

/** Borderless empty state: one line + an action, floating in whitespace. */
export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
      <p className="text-muted-foreground">{title}</p>
      {action}
    </div>
  );
}

export { Badge };
