import { useCrmState } from "./hooks/use-crm";
import { CrmContext } from "./context";
import { useRouter } from "./hooks/use-router";
import { Sidebar } from "./components/sidebar";
import { ErrorBanner } from "./components/error-banner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ContactsPage } from "./components/contacts/contacts-page";
import { ContactDetail } from "./components/contacts/contact-detail";
import { CompaniesPage } from "./components/companies/companies-page";
import { CompanyDetail } from "./components/companies/company-detail";
import { DealsBoard } from "./components/deals/deals-board";
import { PropertiesPage } from "./components/properties/properties-page";

export function App() {
  const isAgent = document.documentElement.hasAttribute("data-agent");
  const state = useCrmState(isAgent);
  const { route, navigate } = useRouter();

  return (
    <CrmContext.Provider value={state}>
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen min-h-0 overflow-hidden bg-background text-foreground">
        <Sidebar route={route} navigate={navigate} />
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
