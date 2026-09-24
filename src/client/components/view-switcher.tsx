import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ChevronDown, Download, Lock, MoreVertical, Plus, Table2, TextCursorInput, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import type { ListView } from "@/hooks/use-table-view";
import { cn } from "@/lib/utils";

type Step = "list" | "create" | "delete";

/**
 * The view bar's title: "<View> · <count> ⌄". Opens the list's views: the
 * default one shows a lock, the others a ⋮ with Edit (the name turns into its
 * own input, in place: no pen, no form) and Delete. "+ Add view" makes a view from the list
 * as it is now.
 */
export function ViewSwitcher({ views, current, count, onOpen, onCreate, onRename, onDelete, onExport }: {
  views: ListView[];
  current: ListView | undefined;
  count: number;
  onOpen: (v: ListView) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (v: ListView, name: string) => Promise<void>;
  onDelete: (v: ListView) => Promise<void>;
  /** Downloads the view as a CSV (its saved filters, sort and columns). */
  onExport: (v: ListView) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("list");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [target, setTarget] = useState<ListView | null>(null);

  const show = (o: boolean) => { setOpen(o); if (!o) { setStep("list"); setRenaming(null); } };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); show(false); } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n) void run(() => onCreate(n));
  };

  return (
    <Popover open={open} onOpenChange={show}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-7 max-w-[16rem] items-center gap-1.5 rounded-sm px-2 text-[0.8125rem] font-medium hover:bg-secondary">
          <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{current?.name ?? "…"}</span>
          <span className="tabular shrink-0 font-normal text-muted-foreground">· {count}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        {step === "list" && (
          <div className="flex flex-col">
            <ul className="flex flex-col p-1">
              {views.map((v) => (
                // The current view is highlighted, not ticked.
                <li key={v.id} className={cn("group/row flex h-8 items-center gap-1 rounded-sm pr-1 hover:bg-secondary", v.id === current?.id && "bg-secondary font-medium")}>
                  {renaming === v.id ? (
                    <RenameInput
                      initial={v.name}
                      onDone={async (next) => {
                        setRenaming(null);
                        if (next && next !== v.name) await onRename(v, next);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => { show(false); onOpen(v); }}
                      aria-current={v.id === current?.id ? "true" : undefined}
                      className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left text-[0.8125rem]"
                    >
                      <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{v.name}</span>
                    </button>
                  )}
                  {v.isDefault ? (
                    <Lock className="mx-1.5 size-3 shrink-0 text-faint" aria-label="Default view, can't be deleted" />
                  ) : renaming !== v.id && (
                    <RowMenu
                      name={v.name}
                      onRename={() => setRenaming(v.id)}
                      onExport={() => { show(false); void onExport(v); }}
                      onDelete={() => { setTarget(v); setStep("delete"); }}
                    />
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => { setName(current?.name ?? ""); setStep("create"); }}
              className="m-1 mt-0 flex h-8 items-center gap-2 rounded-sm border-t border-border px-2 text-[0.8125rem] hover:bg-secondary"
            >
              <Plus className="size-3.5 text-muted-foreground" /> Add view
            </button>
          </div>
        )}

        {step === "create" && (
          <form onSubmit={submit} className="flex flex-col">
            <div className="flex h-9 items-center gap-1 border-b border-border px-2 text-[0.8125rem] font-medium">
              <button type="button" onClick={() => setStep("list")} aria-label="Back to views" className="rounded-xs p-0.5 text-muted-foreground hover:text-foreground">
                <X className="size-4" />
              </button>
              Create view
            </div>
            <div className="flex flex-col gap-2 p-2">
              <Input
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                aria-label="View name"
                className="h-8"
              />
              <p className="px-0.5 text-xs text-muted-foreground">Keeps the current filters, sort and columns. Everyone in the org will see it.</p>
              <Button type="submit" size="sm" disabled={busy || !name.trim()} className="w-full">Create</Button>
            </div>
          </form>
        )}

        {step === "delete" && target && (
          <div className="flex flex-col gap-3 p-3">
            <p className="text-[0.8125rem]">
              Delete <span className="font-medium">{target.name}</span>? It goes for everyone in the org. The records stay.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setStep("list")}>Cancel</Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(() => onDelete(target))}>Delete</Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The view's name as its own input: Enter or blur keeps it, Escape reverts. */
function RenameInput({ initial, onDone }: { initial: string; onDone: (next: string | null) => void | Promise<void> }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    void onDone(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); finish(value.trim() || null); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
  };
  return (
    <input
      ref={ref}
      value={value}
      maxLength={60}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value.trim() || null)}
      aria-label="View name"
      className="h-8 min-w-0 flex-1 rounded-sm bg-card px-2 text-[0.8125rem] shadow-[inset_0_0_0_2px_var(--ring)] outline-none"
    />
  );
}

/** A non-default view's ⋮: Edit, Export and Delete. Shown on hover, always for an agent. */
function RowMenu({ name, onRename, onExport, onDelete }: { name: string; onRename: () => void; onExport: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Options for ${name}`}
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-xs text-muted-foreground hover:bg-border/60 hover:text-foreground",
            !open && "opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 [[data-agent]_&]:opacity-100",
          )}
        >
          <MoreVertical className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-36">
        <Command>
          <CommandList>
            <CommandGroup>
              <CommandItem value="Edit" onSelect={() => { setOpen(false); onRename(); }}>
                <TextCursorInput className="size-3.5 text-muted-foreground" /> Edit
              </CommandItem>
              <CommandItem value="Export" onSelect={() => { setOpen(false); onExport(); }}>
                <Download className="size-3.5 text-muted-foreground" /> Export
              </CommandItem>
              <CommandItem value="Delete" onSelect={() => { setOpen(false); onDelete(); }} className="text-destructive">
                <Trash2 className="size-3.5" /> Delete
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
