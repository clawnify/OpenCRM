import { useState } from "react";
import { Users, Building2, CircleDollarSign, SlidersHorizontal, PanelLeft } from "lucide-react";
import { useCrm } from "../context";
import { cn } from "../lib/utils";
import type { Route } from "../hooks/use-router";

// Record types own a colour: the tile behind the icon is the type's category
// family, and the same family follows the type onto its page header and its
// chips inside other records. Plain nav rows (settings) get a bare line icon.
const NAV = [
  { key: "contacts", path: "/contacts", label: "Contacts", icon: Users, tile: "bg-cat-0-solid" },
  { key: "companies", path: "/companies", label: "Companies", icon: Building2, tile: "bg-cat-9-solid" },
  { key: "deals", path: "/deals", label: "Deals", icon: CircleDollarSign, tile: "bg-cat-4-solid" },
] as const;

const SETTINGS_NAV = [
  { key: "properties", path: "/settings/properties", label: "Attributes", icon: SlidersHorizontal },
] as const;

export function Sidebar({ route, navigate }: { route: Route; navigate: (to: string) => void }) {
  const { stats } = useCrm();
  const counts: Record<string, number> = { contacts: stats.contacts, companies: stats.companies, deals: stats.deals };
  const activeKey = route.name === "contact" ? "contacts" : route.name === "company" ? "companies" : route.name;
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={cn("flex shrink-0 flex-col bg-sidebar border-r border-sidebar-border transition-[width] duration-150", collapsed ? "w-14" : "w-[275px]")}>
      {/* Same height and rule as the page toolbar, so the line runs across the app. */}
      <div className={cn("flex h-14 items-center border-b border-sidebar-border", collapsed ? "justify-center" : "gap-2.5 px-4")}>
        <button type="button" onClick={() => navigate("/contacts")} aria-label="CRM home" className="flex size-7 items-center justify-center rounded-md bg-accent-brand text-white">
          <Users className="size-4" />
        </button>
        {!collapsed && (
          <>
            <span className="font-semibold text-sidebar-foreground">CRM</span>
            <button type="button" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar" title="Collapse sidebar"
              className="ml-auto inline-flex size-7 items-center justify-center rounded-[0.5rem] text-muted-foreground hover:bg-border/60 hover:text-foreground">
              <PanelLeft className="size-4" />
            </button>
          </>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-px px-2 py-2">
        {!collapsed && <div className="section-label px-2.5 pb-1.5 pt-2">Records</div>}
        {NAV.map((item) => {
          const active = activeKey === item.key;
          return (
            <button
              key={item.key}
              onClick={() => navigate(item.path)}
              aria-label={`View ${item.label}`}
              aria-current={active ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex h-7 items-center rounded-[9px] text-sm font-medium tracking-[-0.01em] transition-colors",
                collapsed ? "justify-center px-0" : "gap-1.5 pl-2 pr-4",
                active
                  ? "bg-black/[0.04] text-foreground"
                  : "text-sidebar-foreground hover:bg-black/[0.03]",
              )}
            >
              <span className={cn("flex size-[18px] shrink-0 items-center justify-center rounded-xs text-white", item.tile)}>
                <item.icon className="size-3" strokeWidth={2.5} />
              </span>
              {!collapsed && <span className="flex-1 text-left">{item.label}</span>}
              {!collapsed && (
                <span className={cn("tabular text-xs", active ? "text-foreground" : "text-muted-foreground")}>
                  {counts[item.key]}
                </span>
              )}
            </button>
          );
        })}

        {!collapsed && <div className="section-label px-2.5 pb-1.5 pt-4">Settings</div>}
        {SETTINGS_NAV.map((item) => {
          const active = activeKey === item.key;
          return (
            <button
              key={item.key}
              onClick={() => navigate(item.path)}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex h-7 items-center rounded-[9px] text-sm font-medium tracking-[-0.01em] transition-colors",
                collapsed ? "justify-center px-0" : "gap-1.5 pl-2 pr-4",
                active
                  ? "bg-black/[0.04] text-foreground"
                  : "text-sidebar-foreground hover:bg-black/[0.03]",
              )}
            >
              <item.icon className="size-4 shrink-0" />
              {!collapsed && <span className="flex-1 text-left">{item.label}</span>}
            </button>
          );
        })}
      </nav>
      {collapsed && (
        <button type="button" onClick={() => setCollapsed(false)} aria-label="Expand sidebar" title="Expand sidebar"
          className="mx-auto mb-3 inline-flex size-7 items-center justify-center rounded-[0.5rem] text-muted-foreground hover:bg-border/60 hover:text-foreground">
          <PanelLeft className="size-4" />
        </button>
      )}
    </aside>
  );
}
