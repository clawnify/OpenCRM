import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * Click-to-edit value. The value itself is the control: at rest it reads as
 * text (or a faint placeholder when empty), hover fills it, click turns it into
 * an input, blur or Enter saves, Escape reverts. No edit mode, no pencil icon.
 *
 * The rest state reserves no input chrome, and the ring on focus is an inset
 * box-shadow, so nothing shifts by a pixel between reading and editing.
 */
export function InlineField({
  value,
  placeholder,
  onSave,
  type = "text",
  className,
  displayClassName,
  render,
}: {
  value: string | null | undefined;
  placeholder: string;
  onSave: (next: string) => Promise<void> | void;
  type?: "text" | "email" | "tel";
  className?: string;
  displayClassName?: string;
  /** Optional read-mode renderer (e.g. wrap an email in a mailto link). */
  render?: (value: string) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(value ?? ""); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (next === (value ?? "")) return;
    setSaving(true);
    try { await onSave(next); } finally { setSaving(false); }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); void commit(); }
    if (e.key === "Escape") { e.preventDefault(); setDraft(value ?? ""); setEditing(false); }
  };

  const box = "h-8 w-full rounded-[0.5rem] px-2 text-sm transition-[background-color,box-shadow]";

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKey}
        className={cn(box, "bg-card text-foreground outline-none", className)}
        style={{ boxShadow: "inset 0 0 0 1px var(--ring), 0 0 0 3px var(--accent-tint)" }}
      />
    );
  }

  const empty = !value;
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      disabled={saving}
      aria-label={empty ? placeholder : `Edit ${placeholder.toLowerCase()}`}
      className={cn(
        box,
        "flex items-center text-left hover:bg-secondary disabled:opacity-60",
        empty ? "text-faint" : "text-foreground",
        displayClassName,
        className,
      )}
    >
      <span className="truncate">{empty ? placeholder : render ? render(value!) : value}</span>
    </button>
  );
}
