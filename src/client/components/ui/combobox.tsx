import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ComboOption {
  value: string;
  label: string;
}

/** Searchable single-select (shadcn combobox pattern) — a trigger button that
 *  opens an inline panel with a filter input and the matching options. Built
 *  without a popover/cmdk dependency; closes on outside click or Escape.
 *
 *  Two modes:
 *   • Static — pass `options`; filtering happens client-side.
 *   • Async  — pass `onSearch(query)`; options are fetched from the server as
 *     the user types (debounced), so the picker never loads the whole table.
 *     `options` is then treated as always-present extras (e.g. a "None" entry)
 *     shown above the results. Pass `valueLabel` so the trigger shows the
 *     current selection's label before any fetch (edit mode, where `value` may
 *     not be in the first page of results). */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  id,
  onSearch,
  valueLabel,
}: {
  options: ComboOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  id?: string;
  onSearch?: (query: string) => Promise<ComboOption[]>;
  valueLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ComboOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState<ComboOption | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Async mode: fetch options from the server as the query changes (debounced),
  // starting when the panel opens. Never pages the whole table into the client.
  useEffect(() => {
    if (!onSearch || !open) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      onSearch(q)
        .then((r) => { if (!cancelled) setResults(r); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [onSearch, open, q]);

  const staticFiltered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))
    : options;
  const list = onSearch ? [...staticFiltered, ...results] : staticFiltered;

  // Trigger label: the option the user just picked, else a static match (e.g.
  // "None"), else the seeded label (edit mode), else a match from fetched results.
  const selected =
    (chosen && chosen.value === value ? chosen : undefined) ??
    options.find((o) => o.value === value) ??
    (valueLabel != null && value ? { value, label: valueLabel } : undefined) ??
    results.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        id={id}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-sm bg-card shadow-edge px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected?.label ?? placeholder}</span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md bg-popover shadow-float">
          <div className="flex items-center gap-2 border-b border-border px-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-60 overflow-auto p-1">
            {loading && onSearch ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">Searching…</div>
            ) : list.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">{emptyText}</div>
            ) : (
              list.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { setChosen(o); onChange(o.value); setOpen(false); setQ(""); }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-secondary",
                    o.value === value && "bg-secondary",
                  )}
                >
                  <Check className={cn("size-4 shrink-0", o.value === value ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{o.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
