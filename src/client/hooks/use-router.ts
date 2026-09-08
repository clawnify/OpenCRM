import { useState, useEffect, useCallback } from "react";

export type Route =
  | { name: "contacts" }
  | { name: "contact"; id: string }
  | { name: "companies" }
  | { name: "company"; id: string }
  | { name: "deals" }
  | { name: "properties" }
  | { name: "not-found" };

function parse(path: string): Route {
  if (path === "/" || path === "/contacts") return { name: "contacts" };
  const m = path.match(/^\/contacts\/([^/]+)$/);
  if (m) return { name: "contact", id: decodeURIComponent(m[1]) };
  if (path === "/companies") return { name: "companies" };
  const cm = path.match(/^\/companies\/([^/]+)$/);
  if (cm) return { name: "company", id: decodeURIComponent(cm[1]) };
  if (path === "/deals") return { name: "deals" };
  if (path === "/settings/properties") return { name: "properties" };
  return { name: "not-found" };
}

export function useRouter() {
  const [path, setPath] = useState<string>(() => window.location.pathname);

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, "", to);
    setPath(to);
  }, []);

  useEffect(() => {
    const handler = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  return { path, route: parse(path), navigate };
}
