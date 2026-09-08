import type { ComponentType, ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Icon = ComponentType<{ className?: string }>;

/**
 * The record page's shared anatomy (DESIGN.md → Record pages): a top bar the
 * same height as the sidebar brand row, a details column on the left, and a
 * main column with tabs, highlights, activity and the sections that exist
 * before their features do. Contacts and companies compose the same pieces.
 */

/** Top bar: h-14 + rule, continuous with the sidebar. */
export function RecordTopBar({ onClose, crumb }: { onClose: () => void; crumb: string }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-3">
      <Button variant="ghost" size="icon" onClick={onClose} aria-label={`Back to ${crumb.toLowerCase()}`}>
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </Button>
      <span className="text-[0.8125rem] text-muted-foreground">{crumb}</span>
    </header>
  );
}

/** One attribute row: icon, 144px label, then the value as the control. */
export function Attr({ icon: Icon, label, children }: { icon: Icon; label: string; children: ReactNode }) {
  return (
    <div className="flex h-9 items-center gap-2">
      <dt className="flex w-36 shrink-0 items-center gap-2 text-[0.8125rem] text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

/** A collapsible details section: label with a chevron, optional right action. */
export function DetailsSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-border px-4 py-3">
      <div className="flex h-8 items-center justify-between text-[0.8125rem] font-medium text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          {title}
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Highlight tile: label + icon on line one, the value on line two; an empty value says what is missing. */
export function Tile({ icon: Icon, label, value, empty }: { icon: Icon; label: string; value?: ReactNode; empty: string }) {
  return (
    <div className="flex flex-col gap-4 rounded-md bg-card p-3.5 shadow-edge">
      <div className="flex items-center justify-between text-[0.8125rem] text-muted-foreground">
        {label} <Icon className="size-3.5" />
      </div>
      <div className={cn("truncate text-sm", value ? "text-foreground" : "text-faint")}>{value || empty}</div>
    </div>
  );
}

/** The tab strip: icon + label + count chip, the active tab underlined in ink. */
export function RecordTabs({ tabs }: { tabs: Array<{ key: string; label: string; icon: Icon; count?: number }> }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
      {tabs.map((t, i) => (
        <button
          key={t.key}
          type="button"
          aria-current={i === 0 ? "page" : undefined}
          className={cn(
            "relative inline-flex h-12 items-center gap-1.5 px-3 text-sm",
            i === 0
              ? "font-medium text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <t.icon className="size-4" /> {t.label}
          {t.count !== undefined && <span className="rounded-xs bg-secondary px-1.5 text-xs tabular text-muted-foreground">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A section that exists before its feature does: title, count, and a + at the far right. */
export function FutureSection({ label, count, onAdd }: { label: string; count: number; onAdd?: () => void }) {
  return (
    <section className="flex h-9 items-center justify-between">
      <h2 className="inline-flex items-center gap-2 text-sm font-medium">
        {label} <span className="rounded-xs bg-secondary px-1.5 text-xs tabular text-muted-foreground">{count}</span>
      </h2>
      <Button variant="ghost" size="icon" aria-label={`Add ${label.toLowerCase()}`} disabled={!onAdd} onClick={onAdd}>
        <Plus className="size-4" />
      </Button>
    </section>
  );
}
