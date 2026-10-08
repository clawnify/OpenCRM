import { CalendarClock, CircleDashed, ListChecks } from "lucide-react";
import { dueWhen, localToday, meetingWhen } from "@/components/meetings/shared";
import { toIsoDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { DealProgress } from "@/types";

/**
 * A deal's next step in one line: the call booked with its company, or its
 * soonest dated task with who owes it, overdue in red. A deal with none says
 * so, because "nobody agreed on what happens next" is the thing to fix.
 */
export function NextStepLine({ progress, icon = true, compact = false, className }: {
  progress: DealProgress | null | undefined;
  icon?: boolean;
  /** The day alone ("11 Oct", "Today"), for a narrow card: overdue shows in red. */
  compact?: boolean;
  className?: string;
}) {
  if (!progress) return null;
  const step = progress.next_step;
  if (!step) {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-warning", className)}>
        {icon && <CircleDashed className="size-3.5 shrink-0" aria-hidden />}
        <span className="truncate">No next step</span>
      </span>
    );
  }
  const when = compact ? shortDay(step.kind === "meeting" ? toIsoDate(new Date(step.at)) : step.at)
    : step.kind === "meeting" ? meetingWhen(step.at) : dueWhen(step.at).label;
  const Icon = step.kind === "meeting" ? CalendarClock : ListChecks;
  const who = step.kind === "task" && step.owed_by === "them" ? "They owe: " : "";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", step.overdue && "text-destructive", className)}>
      {icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="truncate">{who}{step.title || "Call"}</span>
      <span className="shrink-0 tabular text-muted-foreground">· {when}</span>
    </span>
  );
}

/** A day as "Today", "Tomorrow" or "11 Oct". */
function shortDay(day: string): string {
  const today = localToday();
  if (day === today) return "Today";
  if (day === toIsoDate(new Date(new Date(`${today}T00:00:00`).getTime() + 86_400_000))) return "Tomorrow";
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
