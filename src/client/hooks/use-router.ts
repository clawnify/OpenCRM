import { useState, useEffect, useCallback } from "react";

// A list route may carry `record`: the id open in the side panel beside the
// table (`/contacts?record=<id>`). The record's own path (`/contacts/<id>`) is
// the full page, so a deep link to a record still lands on the whole record.
// `view` is the list's named view (absent: its default view). `filters` opens
// a list pre-filtered (a filter tree, as the API takes it); the list reads it
// once and drops it from the URL (see useListView).
export type Route =
  | { name: "contacts"; record?: string; view?: string; filters?: string }
  | { name: "contact"; id: string }
  | { name: "companies"; record?: string; view?: string; filters?: string }
  | { name: "company"; id: string }
  | { name: "deals" }
  | { name: "properties" }
  | { name: "not-found" };

function parse(pathname: string, search: string): Route {
  const q = new URLSearchParams(search);
  const record = q.get("record") || undefined;
  const filters = q.get("filters") ?? undefined;
  const view = q.get("view") || undefined;
  if (pathname === "/" || pathname === "/contacts") return { name: "contacts", record, view, filters };
  const m = pathname.match(/^\/contacts\/([^/]+)$/);
  if (m) return { name: "contact", id: decodeURIComponent(m[1]) };
  if (pathname === "/companies") return { name: "companies", record, view, filters };
  const cm = pathname.match(/^\/companies\/([^/]+)$/);
  if (cm) return { name: "company", id: decodeURIComponent(cm[1]) };
  if (pathname === "/deals") return { name: "deals" };
  if (pathname === "/settings/properties") return { name: "properties" };
  return { name: "not-found" };
}

const current = () => window.location.pathname + window.location.search;

/** The current path with some query params set (or removed, with null); the rest kept. */
export function withQuery(changes: Record<string, string | null>): string {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return window.location.pathname + (s ? `?${s}` : "");
}

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
