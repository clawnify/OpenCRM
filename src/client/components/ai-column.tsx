import { useRef, useState, type ReactNode } from "react";
import { AlertCircle, Sparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { RecordColumn } from "@/components/record-table";
import type { AiColumns } from "@/hooks/use-ai-columns";

/** A field the instructions can quote, as {{key}}. */
export interface AiChip {
  key: string;
  label: string;
}

/** The AI half of a record table: its column headers' control and each cell's state. */
export function aiTable<T extends { id: string }>(ai: AiColumns, chips: AiChip[]) {
  return {
    header: (column: RecordColumn<T>, emptyIds: string[]) => (
      <AiHeaderControl ai={ai} fieldKey={column.key} label={column.label} emptyIds={emptyIds} chips={chips} />
    ),
    cell: (row: T, column: RecordColumn<T>) => aiCell(ai, column.key, row.id, column.label),
  };
}

/**
 * The header's AI control: a spark on hover for a field the AI can fill,
 * an "AI" tag once it fills it. Either opens the column's AI settings.
 */
function AiHeaderControl({ ai, fieldKey, label, emptyIds, chips }: {
  ai: AiColumns;
  fieldKey: string;
  label: string;
  emptyIds: string[];
  chips: AiChip[];
}) {
  const [open, setOpen] = useState(false);
  if (!ai.field(fieldKey)) return null;
  const on = !!ai.column(fieldKey);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {on ? (
          <button type="button" aria-label={`AI settings for ${label}`}
            className="inline-flex h-5 shrink-0 items-center rounded-sm bg-secondary px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            AI
          </button>
        ) : (
          <button type="button" aria-label={`Fill ${label} with AI`} title="Fill with AI"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground focus-visible:opacity-100 group-hover/col:opacity-100 data-[state=open]:opacity-100 [[data-agent]_&]:opacity-100">
            <Sparkles className="size-3.5" aria-hidden />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3" onClick={(e) => e.stopPropagation()}>
        <AiColumnPanel ai={ai} fieldKey={fieldKey} label={label} emptyIds={emptyIds} chips={chips} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function AiColumnPanel({ ai, fieldKey, label, emptyIds, chips, onDone }: {
  ai: AiColumns;
  fieldKey: string;
  label: string;
  emptyIds: string[];
  chips: AiChip[];
  onDone: () => void;
}) {
  const column = ai.column(fieldKey);
  const [prompt, setPrompt] = useState(column?.prompt ?? "");
  const [research, setResearch] = useState(!!column?.research);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pending = ai.pendingIn(fieldKey);
  const next = Math.min(emptyIds.length, ai.limit);
  const box = useRef<HTMLTextAreaElement>(null);
  // A chip goes in at the caret and leaves the caret after it, so typing carries on.
  const insert = (key: string) => {
    const el = box.current;
    const start = el?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, start);
    const token = `${before && !/\s$/.test(before) ? " " : ""}{{${key}}}`;
    setPrompt(before + token + prompt.slice(el?.selectionEnd ?? start));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  // Turning the column on is itself the first fill: the spark means "fill this with AI".
  const fill = async () => {
    setBusy(true);
    try {
      if (!column || (ai.canConfigure && (prompt !== column.prompt || research !== !!column.research))) {
        if ((await ai.save(fieldKey, prompt, research)) === null) return;
      }
      const r = await ai.fill(fieldKey, emptyIds);
      if (r && r.queued === 0) setNote("No empty cells in the rows on screen.");
      else if (r) onDone();
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    setBusy(true);
    try {
      await ai.turnOff(fieldKey);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const label13 = "text-[0.8125rem] text-muted-foreground";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden /> AI for {label}
        </div>
        <p className={label13}>
          Fills the empty {label} cells from the rest of each record, {ai.limit} rows at a time. It never replaces a value someone typed.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`ai-prompt-${fieldKey}`}>Instructions <span className="font-normal text-muted-foreground">(optional)</span></Label>
        <Textarea ref={box} id={`ai-prompt-${fieldKey}`} rows={3} value={prompt} disabled={!ai.canConfigure}
          onChange={(e) => setPrompt(e.target.value)} placeholder={`e.g. The ${label.toLowerCase()} of {{${chips[0]?.key ?? "name"}}}, in a few words`} />
        {ai.canConfigure && chips.length > 0 && (
          <>
            <div className="flex flex-wrap gap-1">
              {chips.map((c) => (
                <button key={c.key} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(c.key)} title={`Insert ${c.label}`}
                  className="rounded-sm bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
                  {c.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">If you quote no field, the AI uses them all.</p>
          </>
        )}
      </div>

      <label className={`flex items-center gap-2 ${label13}`}>
        <input type="checkbox" checked={research} disabled={!ai.canConfigure} onChange={(e) => setResearch(e.target.checked)} className="size-3.5" />
        Research the web
      </label>

      {note && <p className={label13}>{note}</p>}

      <div className="flex items-center justify-between gap-2">
        {column && ai.canConfigure ? (
          <button type="button" onClick={turnOff} disabled={busy} className={`${label13} hover:text-foreground`}>Turn off</button>
        ) : <span />}
        <Button size="sm" onClick={fill} disabled={busy || pending > 0 || (!column && !ai.canConfigure) || next === 0}>
          {pending > 0 ? `Filling ${pending}…` : next === 0 ? "No empty cells on screen" : column ? `Fill next ${next}` : `Fill ${next} with AI`}
        </Button>
      </div>
    </div>
  );
}

/**
 * A cell's AI state: "AI is thinking…" in place of its value while it's being
 * filled, a warning that retries when it failed, and on an AI column a hover
 * button that writes the cell again.
 */
function aiCell(ai: AiColumns, fieldKey: string, rowId: string, label: string): { thinking: boolean; control: ReactNode } | null {
  if (!ai.field(fieldKey)) return null;
  const state = ai.cell(rowId, fieldKey);
  if (state && state.status !== "error") {
    return {
      thinking: true,
      control: (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Sparkles className="size-3.5 animate-pulse" aria-hidden /> AI is thinking…
        </span>
      ),
    };
  }
  if (state?.status === "error") {
    return {
      thinking: false,
      control: (
        <CellButton label={`Couldn't fill ${label}: ${state.error ?? "unknown error"}. Try again`} always onClick={() => void ai.regenerate(fieldKey, rowId)}>
          <AlertCircle className="size-3.5 text-destructive" aria-hidden />
        </CellButton>
      ),
    };
  }
  if (!ai.column(fieldKey)) return null;
  return {
    thinking: false,
    control: (
      <CellButton label={`Write ${label} again with AI`} onClick={() => void ai.regenerate(fieldKey, rowId)}>
        <Sparkles className="size-3.5" aria-hidden />
      </CellButton>
    ),
  };
}

/** A small button at a cell's right edge: on the cell's hover, always for an agent (or `always`). */
function CellButton({ label, always = false, onClick, children }: { label: string; always?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`absolute right-1 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm bg-card text-muted-foreground shadow-raised hover:text-foreground focus-visible:opacity-100 ${always ? "opacity-100" : "opacity-0 group-hover/cell:opacity-100 [[data-agent]_&]:opacity-100"}`}
    >
      {children}
    </button>
  );
}
