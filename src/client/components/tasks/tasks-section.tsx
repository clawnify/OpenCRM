import { useEffect, useRef, useState } from "react";
import { Check, MessageSquareQuote, Trash2 } from "lucide-react";
import { useCrm } from "@/context";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { InlineField } from "@/components/ui/inline-field";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { dueWhen, meetingWhen } from "@/components/meetings/shared";
import { cn } from "@/lib/utils";
import type { Task, OwedBy } from "@/types";

const OWED: Record<OwedBy, string> = { us: "We owe", them: "They owe" };

/**
 * A company's tasks: what we promised and what we're waiting on, typed here or
 * taken from its calls. Open ones by due date; done ones on request. Each value
 * is the control (title and due date edit in place, the chip flips who owes it).
 * With `dealId`, a deal's: its own tasks and its company's on no deal, and a
 * new one is the deal's (a task with a date is a next step).
 */
export function TasksSection({ companyId, dealId, onCount }: { companyId: string | null; dealId?: string; onCount?: (n: number) => void }) {
  const { setError, changes } = useCrm();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState("");

  const load = () =>
    api<{ tasks: Task[] }>("GET", `/api/tasks?${dealId ? `deal_id=${encodeURIComponent(dealId)}` : `company_id=${encodeURIComponent(companyId ?? "")}`}&status=${showDone ? "all" : "open"}&limit=200`)
      .then((r) => setTasks(r.tasks), (e) => setError(e instanceof Error ? e.message : "Could not load tasks"));

  const seen = useRef(changes);
  useEffect(() => { void load(); }, [companyId, dealId, showDone]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (seen.current === changes) return;
    seen.current = changes;
    void load();
  }, [changes]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (tasks ?? []).filter((t) => !t.done);
  useEffect(() => { onCount?.(open.length); }, [open.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (id: string, patch: Partial<Pick<Task, "title" | "owed_by" | "due_date" | "done">>) => {
    try {
      const r = await api<{ task: Task }>("PUT", `/api/tasks/${encodeURIComponent(id)}`, patch);
      setTasks((list) => (list ?? []).map((t) => (t.id === id ? r.task : t)).filter((t) => showDone || !t.done));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the task");
    }
  };
  const remove = async (id: string) => {
    try {
      await api("DELETE", `/api/tasks/${encodeURIComponent(id)}`);
      setTasks((list) => (list ?? []).filter((t) => t.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the task");
    }
  };
  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    try {
      const r = await api<{ task: Task }>("POST", "/api/tasks", { title, company_id: companyId, ...(dealId ? { deal_id: dealId } : {}) });
      setTasks((list) => [...(list ?? []), r.task]);
    } catch (e) {
      setDraft(title);
      setError(e instanceof Error ? e.message : "Could not add the task");
    }
  };

  const shown = showDone ? tasks ?? [] : open;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-9 items-center justify-between">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium">
          Tasks <span className="rounded-xs bg-secondary px-1.5 text-xs tabular text-muted-foreground">{open.length}</span>
        </h2>
        <button type="button" onClick={() => setShowDone((v) => !v)} className="text-[0.8125rem] text-muted-foreground hover:text-foreground">
          {showDone ? "Hide done" : "Show done"}
        </button>
      </div>
      <ul className="flex flex-col rounded-md bg-card shadow-edge">
        {shown.map((t) => <TaskRow key={t.id} task={t} onSave={(p) => save(t.id, p)} onRemove={() => remove(t.id)} />)}
        <li className="flex items-center gap-3 px-3.5 py-1.5 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border">
          <span className="size-4 shrink-0" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
            placeholder={tasks === null ? "Loading…" : "Add a task…"}
            aria-label="Add a task"
            className="h-8 min-w-0 flex-1 rounded-[0.5rem] bg-transparent px-2 text-sm outline-none placeholder:text-faint focus:shadow-[inset_0_0_0_1px_var(--ring)]"
          />
        </li>
      </ul>
    </section>
  );
}

function TaskRow({ task, onSave, onRemove }: {
  task: Task;
  onSave: (patch: Partial<Pick<Task, "title" | "owed_by" | "due_date" | "done">>) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const due = task.due_date ? dueWhen(task.due_date) : null;
  return (
    <li className="group flex items-center gap-3 px-3.5 py-1.5 [&+li]:border-t [&+li]:border-border">
      <button
        type="button" role="checkbox" aria-checked={task.done} aria-label={task.done ? "Mark as not done" : "Mark as done"}
        onClick={() => void onSave({ done: !task.done })}
        className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-sm border", task.done ? "border-foreground bg-foreground text-background" : "border-faint hover:border-foreground")}
      >
        {task.done && <Check className="size-3" strokeWidth={2.5} />}
      </button>
      <div className={cn("min-w-0 flex-1", task.done && "text-muted-foreground line-through")}>
        <InlineField value={task.title} placeholder="Task" onSave={(v) => onSave({ title: v })} />
      </div>
      {task.quote && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground" aria-label="From a call">
              <MessageSquareQuote className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            “{task.quote}”{task.meeting_starts_at ? ` · ${task.meeting_title || "Call"}, ${meetingWhen(task.meeting_starts_at)}` : ""}
          </TooltipContent>
        </Tooltip>
      )}
      <button
        type="button" onClick={() => void onSave({ owed_by: task.owed_by === "us" ? "them" : "us" })}
        title="Who promised it: click to switch"
        className="h-5 shrink-0 rounded-sm border border-border bg-secondary px-1.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
      >
        {OWED[task.owed_by]}
      </button>
      <div className={cn("w-40 shrink-0", due?.overdue && !task.done && "text-destructive")}>
        <InlineField type="date" value={task.due_date ?? ""} placeholder="No date" onSave={(v) => onSave({ due_date: v || null })}
          render={() => <span className="tabular">{due?.label}</span>} />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Delete task" onClick={() => void onRemove()} className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [[data-agent]_&]:opacity-100">
            <Trash2 className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Delete task</TooltipContent>
      </Tooltip>
    </li>
  );
}
