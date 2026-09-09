import { useEffect, useState } from "react";
import { PanelLeft } from "lucide-react";
import { AppNav, reportLocation, type AppNavItem } from "@clawnify/app/client";
import { useCrmState } from "./hooks/use-crm";
import { CrmContext } from "./context";
import { useRouter, type Route } from "./hooks/use-router";
import { ErrorBanner } from "./components/error-banner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ContactsPage } from "./components/contacts/contacts-page";
import { ContactDetail } from "./components/contacts/contact-detail";
import { CompaniesPage } from "./components/companies/companies-page";
import { CompanyDetail } from "./components/companies/company-detail";
import { DealsBoard } from "./components/deals/deals-board";
import { PropertiesPage } from "./components/properties/properties-page";

// One definition of the navigation. <AppNav> paints it as this app's own
// sidebar when opened directly, and hands it to the Clawnify dashboard's
// sidebar when embedded there. Record types own a colour: the tile behind
// the icon is the type's hue, and the same hue follows the type onto its
// page header and its chips inside other records.
const RECORDS: AppNavItem[] = [
  // The CRM opens on contacts. This hidden item is what the app's name opens
  // (the brand row standalone, the app's row in the dashboard).
  { id: "home", label: "Contacts", href: "/", home: true },
  { id: "contacts", label: "Contacts", href: "/contacts", icon: "users", color: "blue" },
  { id: "companies", label: "Companies", href: "/companies", icon: "building-2", color: "violet" },
  { id: "deals", label: "Deals", href: "/deals", icon: "dollar-sign", color: "green" },
];
const SETTINGS: AppNavItem[] = [
  { id: "properties", label: "Attributes", href: "/settings/properties", icon: "layers" },
];

function activeFor(route: Route): string {
  if (route.name === "contact") return "contacts";
  if (route.name === "company") return "companies";
  return route.name;
}

export function App() {
  const isAgent = document.documentElement.hasAttribute("data-agent");
  const state = useCrmState(isAgent);
  const { path, route, navigate } = useRouter();

  // Lets the dashboard restore this exact screen on reload.
  useEffect(() => {
    reportLocation(path);
  }, [path]);

  // Collapse folds the SDK sidebar to icons. The toggle lives here, not in
  // <AppNav>, because the SDK has no slot for it; the proper home is the SDK.
  const [navCollapsed, setNavCollapsed] = useState(false);

  const counts: Record<string, number> = { contacts: state.stats.contacts, companies: state.stats.companies, deals: state.stats.deals };
  const groups = [
    { items: RECORDS.map((n) => (counts[n.id] ? { ...n, count: counts[n.id] } : n)) },
    { label: "Settings", items: SETTINGS },
  ];

  return (
    <CrmContext.Provider value={state}>
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground md:flex-row" data-nav-collapsed={navCollapsed || undefined}>
        {/* flex, so the SDK aside stretches to the row height like a direct child */}
        <div className="relative flex shrink-0">
          <button
            type="button"
            onClick={() => setNavCollapsed((v) => !v)}
            aria-label={navCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={navCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="absolute right-2 top-3.5 z-10 hidden size-7 items-center justify-center rounded-[0.5rem] text-muted-foreground hover:bg-border/60 hover:text-foreground md:inline-flex"
          >
            <PanelLeft className="size-4" />
          </button>
          <AppNav
            title="OpenCRM"
            icon="contact"
            groups={groups}
            active={activeFor(route)}
            onNavigate={(item) => navigate(item.href ?? "/")}
          />
        </div>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {state.loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              {route.name === "contacts" && <ContactsPage navigate={navigate} />}
              {route.name === "contact" && <ContactDetail id={route.id} navigate={navigate} />}
              {route.name === "companies" && <CompaniesPage navigate={navigate} />}
              {route.name === "company" && <CompanyDetail id={route.id} navigate={navigate} />}
              {route.name === "deals" && <DealsBoard />}
              {route.name === "properties" && <PropertiesPage />}
              {route.name === "not-found" && (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-center">
                  <h1 className="text-xl font-bold tracking-tight">Not found</h1>
                  <p className="text-sm text-muted-foreground">That page doesn't exist.</p>
                  <button className="text-sm text-[var(--ring)] hover:underline" onClick={() => navigate("/contacts")}>
                    Back to contacts
                  </button>
                </div>
              )}
            </>
          )}
        </main>
        <ErrorBanner />
      </div>
    </TooltipProvider>
    </CrmContext.Provider>
  );
}
