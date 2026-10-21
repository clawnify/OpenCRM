import { useState } from "react";
import { Mail, Calendar, MessageSquare } from "lucide-react";
import { useCrm } from "../context";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";

const ITEMS = [
  { key: "email", label: "Gmail", icon: Mail },
  { key: "meeting", label: "Google Calendar", icon: Calendar },
  { key: "slack", label: "Slack", icon: MessageSquare },
] as const;

// Compact integration health: one chip per connection, lit when wired in
// Clawnify, dimmed with a hint when not. Read-only — connecting happens in the
// Clawnify dashboard, not here.
export function ConnectionsIndicator() {
  const { connections, refetchConnections } = useCrm();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try { await refetchConnections(); } finally { setRetrying(false); }
  };
  return (
    <div className="flex items-center gap-1" aria-label="Integration status">
      {ITEMS.map(({ key, label, icon: Icon }) => {
        const on = connections[key];
        const description = connections.error
          ? `${label} status unavailable — ${connections.error}`
          : on ? `${label} connected` : `${label} not connected — connect it in Clawnify`;
        return (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <span
                aria-label={description}
                tabIndex={0}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-sm",
                  connections.error ? "bg-warning-tint text-warning" : on ? "bg-success-tint text-success" : "bg-secondary text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{description}</TooltipContent>
          </Tooltip>
        );
      })}
      {connections.error && (
        <div className="flex items-center gap-1 text-xs text-warning">
          <span role="status">Connection check failed</span>
          <Button variant="ghost" size="sm" onClick={retry} disabled={retrying} aria-label="Retry connection check">
            {retrying ? "Checking…" : "Retry"}
          </Button>
        </div>
      )}
    </div>
  );
}
