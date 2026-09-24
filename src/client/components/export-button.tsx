import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

/**
 * The selection bar's Export. With every row on the page selected and more
 * records in the list than the page shows, it asks which (the selected rows,
 * or all the records the list selects), highlighted when picked, and Export
 * confirms. Otherwise it exports the selection at once.
 */
export function ExportButton({ selected, pageRows, total, onSelected, onAll }: {
  selected: number;
  pageRows: number;
  total: number;
  onSelected: () => void;
  onAll: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<"selected" | "all">("selected");
  const button = (props: { onClick?: () => void }) => (
    <Button size="sm" variant="secondary" disabled={busy} {...props}>
      <Download className="size-4" />
      {busy ? "Exporting…" : "Export"}
    </Button>
  );
  if (!(selected === pageRows && total > pageRows)) return button({ onClick: onSelected });

  const confirm = async () => {
    setOpen(false);
    if (choice === "selected") return onSelected();
    setBusy(true);
    try { await onAll(); } finally { setBusy(false); }
  };
  const options = [
    { value: "selected" as const, label: "Selected rows", count: selected },
    { value: "all" as const, label: "All records", count: total },
  ];
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setChoice("selected"); }}>
      <PopoverTrigger asChild>{button({})}</PopoverTrigger>
      <PopoverContent align="end" className="w-60">
        <Command>
          <CommandList>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.value} value={o.value} onSelect={() => setChoice(o.value)} aria-selected={choice === o.value}
                  className={cn(choice === o.value && "bg-secondary font-medium")}>
                  <span className="flex-1">{o.label}</span>
                  <span className="tabular text-muted-foreground">{o.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className="border-t border-border p-2">
          <Button size="sm" className="w-full" onClick={() => void confirm()}>
            <Download className="size-4" />
            Export {choice === "all" ? total : selected}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
