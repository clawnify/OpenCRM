import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// The pieces settings pages are made of (Settings → Email, Settings → Meetings).

export function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="text-[0.8125rem] text-muted-foreground">{description}</p>
      <div className="flex flex-col gap-2 pt-1">{children}</div>
    </section>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-warning-tint px-3 py-2 text-[0.8125rem] text-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> <span>{children}</span>
    </p>
  );
}

/** One choice from a few, as cards: the whole row is the control. */
export function Choices<T extends string>({ name, value, options, onChange, disabled }: {
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
