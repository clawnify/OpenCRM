import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { useCrm } from "@/context";
import { withQuery } from "@/hooks/use-router";
import { sanitize, type FilterNode } from "@/lib/filters";
import type { ListView, TableView } from "@/hooks/use-table-view";
import type { EntityType, PaginatedState } from "@/types";

/** The order a view with no saved sort shows its list in. */
const DEFAULT_SORT = { sort: "created_at", order: "desc" as const };

// Unsaved filter edits per view, kept for the session: they outlive the list
// page unmounting (opening a record's full page and coming back), not a reload.
const drafts = new Map<string, FilterNode[]>();

function parseFilters(raw: string): FilterNode[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const key = (f: FilterNode[]) => JSON.stringify(sanitize(f));
const sortOf = (v: ListView) => ({ sort: v.sort ?? DEFAULT_SORT.sort, order: v.order ?? DEFAULT_SORT.order });

/**
 * The list's current view and its unsaved edits. Opening a view applies its
 * filters and sort. Editing filters makes a draft in memory and clicking a
 * column header changes the sort, both on this page only, leaving the URL
 * alone, until Update view stores them for everyone or Reset goes back. A new
 * view takes the current state, unsaved edits included. A `?filters=` query
 * value is an entry point: read once into the draft, then taken off the URL.
 */
export function useListView({ entity, table, filtersParam, pag, setFilters: applyFilters, setView: applyView, navigate }: {
  entity: EntityType;
  table: TableView;
  /** The route's raw `filters` query value, if a link opened the list with one. */
  filtersParam: string | undefined;
  /** The list's live query: what it is fetched with now. */
  pag: PaginatedState;
  setFilters: (f: FilterNode[]) => void;
  setView: (v: { filters: FilterNode[]; sort: string; order: "asc" | "desc" }) => void;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}) {
  const { setError } = useCrm();
  const view = table.view;
  const id = view?.id;
  const [draft, setDraftState] = useState<FilterNode[] | undefined>(undefined);

  const setDraft = useCallback((next: FilterNode[] | undefined) => {
    if (!id) return;
    if (next === undefined) drafts.delete(id);
    else drafts.set(id, next);
    setDraftState(next);
  }, [id]);

  // Opening a view (or its first load): apply its filters, or this session's
  // draft of them, and its sort, in one fetch.
  const applied = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!view || applied.current === view.id) return;
    applied.current = view.id;
    const d = drafts.get(view.id);
    setDraftState(d);
    applyView({ filters: sanitize(d ?? view.filters), ...sortOf(view) });
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  // A link's `?filters=` becomes the draft, and the URL goes back to clean.
  useEffect(() => {
    if (filtersParam === undefined || !id) return;
    setDraft(parseFilters(filtersParam));
    navigate(withQuery({ filters: null }), { replace: true });
  }, [filtersParam, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters = draft ?? view?.filters ?? [];

  // Refetch once filter editing pauses, and only when the query would change.
  const wanted = key(filters);
  useEffect(() => {
    if (!view || applied.current !== view.id || wanted === key(pag.filters)) return;
    const t = setTimeout(() => applyFilters(JSON.parse(wanted)), 250);
    return () => clearTimeout(t);
  }, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = view ? sortOf(view) : DEFAULT_SORT;
  const dirty = !!view && (
    (draft !== undefined && key(draft) !== key(view.filters)) ||
    pag.sort !== saved.sort || pag.order !== saved.order
  );

  const fail = (what: string) => (e: unknown) => setError(e instanceof Error ? e.message : `Could not ${what}`);

  const reset = useCallback(() => {
    if (!view) return;
    setDraft(undefined);
    applyView({ filters: sanitize(view.filters), ...sortOf(view) });
  }, [view, setDraft, applyView]);

  const update = useCallback(async () => {
    if (!view) return;
    try {
      await api("PATCH", `/api/views/${view.id}`, { filters: sanitize(filters), sort: pag.sort, order: pag.order });
      setDraft(undefined);
      await table.reloadViews();
    } catch (e) { fail("update the view")(e); }
  }, [view, filters, pag.sort, pag.order, setDraft, table]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((v: ListView) => {
    navigate(withQuery({ view: v.isDefault ? null : v.id, record: null }));
  }, [navigate]);

  const create = useCallback(async (name: string) => {
    try {
      const r = await api<{ view: ListView }>("POST", "/api/views", {
        entity, name, from: view?.id, filters: sanitize(filters), sort: pag.sort, order: pag.order,
      });
      // The unsaved edits moved into the new view; the old one goes back to itself.
      if (view) drafts.delete(view.id);
      drafts.delete(r.view.id);
      await table.reloadViews();
      open(r.view);
    } catch (e) { fail("create the view")(e); }
  }, [entity, view, filters, pag.sort, pag.order, table, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const rename = useCallback(async (v: ListView, name: string) => {
    try {
      await api("PATCH", `/api/views/${v.id}`, { name });
      await table.reloadViews();
    } catch (e) { fail("rename the view")(e); }
  }, [table]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deleting the view on screen goes back to the list's default view.
  const remove = useCallback(async (v: ListView) => {
    if (v.isDefault) return;
    try {
      await api("DELETE", `/api/views/${v.id}`);
      drafts.delete(v.id);
      await table.reloadViews();
      if (v.id === view?.id) navigate(withQuery({ view: null }));
    } catch (e) { fail("delete the view")(e); }
  }, [view, table, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  // The default view is locked: its filters and sort are for the moment only,
  // kept by saving a new view.
  const locked = !!view?.isDefault;
  return { view, views: table.views, filters, setFilters: setDraft as (next: FilterNode[]) => void, dirty, locked, update, reset, open, create, rename, remove };
}
