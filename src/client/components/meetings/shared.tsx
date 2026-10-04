import type { ReactNode } from "react";
import { cn, toIsoDate } from "@/lib/utils";
import type { HealthStatus } from "@/types";

type Tone = "success" | "warning" | "danger" | "neutral";

const TONES: Record<Tone, string> = {
  success: "border-success/30 bg-success-tint text-success",
  warning: "border-warning/30 bg-warning-tint text-warning",
  danger: "border-destructive/30 bg-destructive-tint text-destructive",
  neutral: "border-border bg-secondary text-muted-foreground",
};

/** A status that asks for attention (DESIGN.md: a badge is a pill, tinted, thin same-hue border, normal weight). */
export function StatusPill({ tone, children, className, title }: { tone: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-xs leading-none whitespace-nowrap", TONES[tone], className)}>
      {children}
    </span>
  );
}

export const HEALTH: Record<HealthStatus, { label: string; tone: Tone }> = {
  red: { label: "At risk", tone: "danger" },
  yellow: { label: "Watch", tone: "warning" },
  green: { label: "On track", tone: "success" },
};

export function HealthPill({ status }: { status: HealthStatus }) {
  return <StatusPill tone={HEALTH[status].tone}>{HEALTH[status].label}</StatusPill>;
}

const MOODS: Record<number, { label: string; tone: Tone }> = {
  2: { label: "Went very well", tone: "success" },
  1: { label: "Went well", tone: "success" },
  0: { label: "Neutral", tone: "neutral" },
  [-1]: { label: "Uneasy", tone: "warning" },
  [-2]: { label: "Went badly", tone: "danger" },
};

/** How a call went, from its digest. The reason shows on hover. */
export function MoodPill({ value, reason }: { value: number | null; reason?: string | null }) {
  if (value === null || !(value in MOODS)) return null;
  return <StatusPill tone={MOODS[value].tone} title={reason ?? undefined}>{MOODS[value].label}</StatusPill>;
}

/** The viewer's offset from UTC in minutes, as the API's `tz` takes it. */
export const tzOffset = () => -new Date().getTimezoneOffset();

export const localToday = () => toIsoDate(new Date());

/** When a meeting is, as people say it: "Today, 14:00", "Tomorrow, 09:30", "Tue 7 Oct, 14:00", or a past date. */
export function meetingWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = toIsoDate(d);
  const today = toIsoDate(now);
  const tomorrow = toIsoDate(new Date(now.getTime() + 86_400_000));
  if (day === today) return `Today, ${time}`;
  if (day === tomorrow) return `Tomorrow, ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  if (d.getTime() > now.getTime()) return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
  return d.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** A due date against today: overdue, today, tomorrow, or the day. */
export function dueWhen(day: string, today = localToday()): { label: string; overdue: boolean } {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { label: day, overdue: false };
  const tomorrow = toIsoDate(new Date(new Date(`${today}T00:00:00`).getTime() + 86_400_000));
  const short = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (day < today) return { label: `Overdue · ${short}`, overdue: true };
  if (day === today) return { label: "Today", overdue: false };
  if (day === tomorrow) return { label: "Tomorrow", overdue: false };
  return { label: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }), overdue: false };
}

/** "3 days ago", "today", for the last time we were in touch. */
export function daysAgo(days: number | null): string {
  if (days === null) return "Never";
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

/** An eyebrow: the 11px uppercase label that names a zone (DESIGN.md signature 1). */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground", className)}>{children}</h2>;
}
