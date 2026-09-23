import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";
import { useCrm } from "@/context";
import { withQuery } from "@/hooks/use-router";
import { sanitize, type FilterNode } from "@/lib/filters";
import type { EntityType } from "@/types";

function parseFilters(raw: string): FilterNode[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Unsaved edits per list, kept for the session: they outlive the list page
// unmounting (opening a record's full page and coming back), not a reload.
const drafts = new Map<EntityType, FilterNode[]>();

/**
 * A list's filters. The saved view (shared by the org) is what the list opens
 * with. Editing makes a draft that lives in memory, leaving the URL alone,
 * until Save view stores it for everyone or Reset drops it. A `?filters=`
 * query value is an entry point: read once into the draft, then taken off the
 * URL. The list refetches after a pause in editing.
 */
export function useListFilters({ entity, param, current, apply, navigate }: {
  entity: EntityType;
  /** The route's raw `filters` query value, if a link opened the list with one. */
  param: string | undefined;
  /** The filters the list is currently fetched with. */
  current: FilterNode[];
  /** Refetches the list with these filters. */
  apply: (f: FilterNode[]) => void;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}) {
  const { setError } = useCrm();
  const [saved, setSaved] = useState<FilterNode[] | null>(null);
  const [draft, setDraftState] = useState<FilterNode[] | undefined>(() => drafts.get(entity));

  const setDraft = useCallback((next: FilterNode[] | undefined) => {
    if (next === undefined) drafts.delete(entity);
    else drafts.set(entity, next);
    setDraftState(next);
  }, [entity]);

  useEffect(() => {
    let alive = true;
    api<{ filters: FilterNode[] }>("GET", `/api/list-views/${entity}`)
      .then((r) => { if (alive) setSaved(r.filters); })
      .catch((e) => { if (alive) { setSaved([]); setError(e instanceof Error ? e.message : "Could not load the saved view"); } });
    return () => { alive = false; };
  }, [entity, setError]);

  // A link's `?filters=` becomes the draft, and the URL goes back to clean.
  useEffect(() => {
    if (param === undefined) return;
    setDraft(parseFilters(param));
    navigate(withQuery({ filters: null }), { replace: true });
  }, [param]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters = draft ?? saved ?? [];
  const key = (f: FilterNode[]) => JSON.stringify(sanitize(f));
  const dirty = draft !== undefined && saved !== null && key(draft) !== key(saved);

  // Refetch once editing pauses, and only when the query would change.
  const wanted = key(filters);
  useEffect(() => {
    if (saved === null && draft === undefined) return;
    if (wanted === key(current)) return;
    const t = setTimeout(() => apply(JSON.parse(wanted)), 250);
    return () => clearTimeout(t);
  }, [wanted, saved === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = useCallback(() => setDraft(undefined), [setDraft]);

  const save = useCallback(async () => {
    const next = sanitize(filters);
    try {
      await api("PUT", `/api/list-views/${entity}`, { filters: next });
      setSaved(next);
      setDraft(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the view");
    }
  }, [entity, filters, setDraft, setError]);

  return { filters, setFilters: setDraft as (next: FilterNode[]) => void, dirty, save, reset };
}
