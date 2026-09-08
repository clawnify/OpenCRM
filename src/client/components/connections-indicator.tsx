import { Mail, Calendar, MessageSquare } from "lucide-react";
import { useCrm } from "../context";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const ITEMS = [
  { key: "email", label: "Gmail", icon: Mail },
  { key: "meeting", label: "Google Calendar", icon: Calendar },
  { key: "slack", label: "Slack", icon: MessageSquare },
] as const;

// Compact integration health: one chip per connection, lit when wired in
// Clawnify, dimmed with a hint when not. Read-only — connecting happens in the
// Clawnify dashboard, not here.
export function ConnectionsIndicator() {
  const { connections } = useCrm();
  return (
    <div className="flex items-center gap-1" aria-label="Integration status">
      {ITEMS.map(({ key, label, icon: Icon }) => {
        const on = connections[key];
        return (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-sm",
                  on ? "bg-success-tint text-success" : "bg-secondary text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{on ? `${label} connected` : `${label} not connected — connect it in Clawnify`}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
