import { useEffect, useState } from "react";
import { useCrm } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { api } from "@/api";
import { cn, colorClasses, colorPalette, type ColorToken } from "@/lib/utils";
import type { StageDef } from "@/types";

const COLORS = Object.keys(colorPalette) as ColorToken[];

/** Create or edit a pipeline stage: label, color, and the semantic flags that
 *  drive behavior (won → Slack celebrate; lost → pass semantics). The key is
 *  immutable — it's what deals store. */
export function StageDialog({
  open,
  onOpenChange,
  stage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stage?: StageDef;
}) {
  const { refetchStages, setError } = useCrm();
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<string>("slate");
  const [outcome, setOutcome] = useState<"none" | "won" | "lost">("none");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setLabel(stage?.label ?? "");
      setColor(stage?.color ?? "slate");
      setOutcome(stage?.is_won ? "won" : stage?.is_lost ? "lost" : "none");
    }
  }, [open, stage]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    try {
      const payload = {
        label: label.trim(),
        color,
        is_won: outcome === "won",
        is_lost: outcome === "lost",
      };
      if (stage) await api("PUT", `/api/stages/${encodeURIComponent(stage.key)}`, payload);
      else await api("POST", "/api/stages", payload);
      await refetchStages();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save stage");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{stage ? "Edit stage" : "Add stage"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="stage-label">Label</Label>
            <Input id="stage-label" required value={label} placeholder="e.g. IC Review"
              onChange={(e) => setLabel(e.target.value)} />
            {stage && <span className="font-mono text-xs text-muted-foreground">{stage.key} (immutable)</span>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((token) => {
                const c = colorClasses(token);
                return (
                  <button
                    key={token}
                    type="button"
                    aria-label={`Color ${token}`}
                    onClick={() => setColor(token)}
                    className={cn(
                      "size-6 rounded-full transition-shadow",
                      c.dot,
                      color === token && "ring-2 ring-offset-2 " + c.ring,
                    )}
                  />
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Outcome</Label>
            <div className="flex gap-2">
              {([
                { v: "none", label: "In progress" },
                { v: "won", label: "Won 🎉" },
                { v: "lost", label: "Passed" },
              ] as const).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setOutcome(o.v)}
                  className={cn(
                    "rounded-sm px-2.5 py-1.5 text-sm shadow-edge transition-colors",
                    outcome === o.v
                      ? "border-foreground bg-secondary font-medium"
                      : "border-border text-muted-foreground hover:bg-secondary",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              Won announces to Slack; Passed asks for a reason and leaves the pipeline value.
            </span>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" size="sm" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={busy || !label.trim()}>
              {busy ? "Saving…" : stage ? "Save" : "Add stage"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
