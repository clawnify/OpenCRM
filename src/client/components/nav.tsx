import { useEffect } from "react";
import { AppNav, reportLocation, type AppNavItem } from "@clawnify/app/client";
import { useCrm } from "../context";
import type { Route } from "../hooks/use-router";

// One definition of the navigation. <AppNav> paints it as this app's own
// sidebar when opened directly, and hands it to the Clawnify dashboard's
// sidebar when embedded there. The home item is the app name's own link, so
// Contacts appears twice on purpose: once as the home target ("/") and once
// as a row with its count ("/contacts").
const NAV: AppNavItem[] = [
  { id: "home", label: "OpenCRM", href: "/", icon: "contact", home: true },
  { id: "contacts", label: "Contacts", href: "/contacts", icon: "users" },
  { id: "companies", label: "Companies", href: "/companies", icon: "building-2" },
  { id: "deals", label: "Deals", href: "/deals", icon: "dollar-sign" },
];

const SETTINGS_NAV: AppNavItem[] = [
  { id: "properties", label: "Attributes", href: "/settings/properties", icon: "layers" },
];

function activeId(route: Route, path: string): string {
  if (path === "/") return "home";
  if (route.name === "contact") return "contacts";
  return route.name;
}

export function Nav({ route, path, navigate }: { route: Route; path: string; navigate: (to: string) => void }) {
  const { stats } = useCrm();

  // Lets the dashboard restore this exact screen on reload.
  useEffect(() => {
    reportLocation(path);
  }, [path]);

  const counts: Record<string, number> = { contacts: stats.contacts, companies: stats.companies, deals: stats.deals };
  const groups = [
    { items: NAV.map((n) => (n.id in counts ? { ...n, count: counts[n.id] } : n)) },
    { label: "Settings", items: SETTINGS_NAV },
  ];

  return (
    <AppNav
      title="OpenCRM"
      icon="contact"
      groups={groups}
      active={activeId(route, path)}
      onNavigate={(item) => navigate(item.href!)}
    />
  );
}
