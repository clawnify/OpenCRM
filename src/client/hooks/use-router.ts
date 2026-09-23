import { useState, useEffect, useCallback } from "react";

// A list route may carry `record`: the id open in the side panel beside the
// table (`/contacts?record=<id>`). The record's own path (`/contacts/<id>`) is
// the full page, so a deep link to a record still lands on the whole record.
export type Route =
  | { name: "contacts"; record?: string }
  | { name: "contact"; id: string }
  | { name: "companies"; record?: string }
  | { name: "company"; id: string }
  | { name: "deals" }
  | { name: "properties" }
  | { name: "not-found" };

function parse(pathname: string, search: string): Route {
  const record = new URLSearchParams(search).get("record") || undefined;
  if (pathname === "/" || pathname === "/contacts") return { name: "contacts", record };
  const m = pathname.match(/^\/contacts\/([^/]+)$/);
  if (m) return { name: "contact", id: decodeURIComponent(m[1]) };
  if (pathname === "/companies") return { name: "companies", record };
  const cm = pathname.match(/^\/companies\/([^/]+)$/);
  if (cm) return { name: "company", id: decodeURIComponent(cm[1]) };
  if (pathname === "/deals") return { name: "deals" };
  if (pathname === "/settings/properties") return { name: "properties" };
  return { name: "not-found" };
}

const current = () => window.location.pathname + window.location.search;

export function useRouter() {
  const [path, setPath] = useState<string>(current);

  // `replace` swaps the entry instead of stacking one, so moving the panel
  // from record to record does not bury the list under a trail of history.
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (to === current()) return;
    if (opts?.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setPath(current());
  }, []);

  useEffect(() => {
    const handler = () => setPath(current());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const url = new URL(path, window.location.origin);
  return { path, route: parse(url.pathname, url.search), navigate };
}
