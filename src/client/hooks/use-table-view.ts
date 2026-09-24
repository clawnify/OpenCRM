import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";
import { useCrm } from "@/context";
import type { EntityType } from "@/types";

interface ViewField {
  key: string;
  visible: boolean;
  size: number | null;
  /** The footer calculation for this column (count, sum…), if one is set. */
  aggregate: string | null;
}

/** A named, shared view of a list. Every list has one default ("All contacts"). */
export interface ListView {
  id: string;
  entity: EntityType;
  name: string;
  icon: string;
  isDefault: boolean;
  position: number;
}

// Last layout seen per view, so a list that remounts (back from a record's
// full page) paints with it at once while the fresh copy loads.
const seen = new Map<string, Record<string, ViewField>>();

/**
 * A list's views and the current one's column layout: which columns show, how
 * wide they are, and what the footer calculates under each. Shared by the
 * whole org and stored server-side (`views`, `view_fields`); columns nobody
 * has touched fall back to the defaults the page passes. `viewId` picks the
 * view (the list's default when absent). Widths move live while a column is
 * dragged and are saved once, when the drag ends.
 */
export function useTableView(entity: EntityType, viewId: string | undefined, defaultWidths: Record<string, number>, fallbackWidth = 160) {
  const { setError } = useCrm();
  const [views, setViews] = useState<ListView[]>([]);
  const view = views.find((v) => v.id === viewId) ?? views.find((v) => v.isDefault);
  const id = view?.id;
  const [fields, setFields] = useState<Record<string, ViewField>>({});

  const reloadViews = useCallback(async () => {
    try {
      setViews((await api<{ views: ListView[] }>("GET", `/api/views?entity=${entity}`)).views);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the views");
    }
  }, [entity, setError]);

  useEffect(() => { void reloadViews(); }, [reloadViews]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setFields(seen.get(id) ?? {});
    api<{ fields: ViewField[] }>("GET", `/api/views/${id}/fields`)
      .then(({ fields: rows }) => {
        const next = Object.fromEntries(rows.map((f) => [f.key, f]));
        seen.set(id, next);
        if (alive) setFields(next);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the column layout"));
    return () => { alive = false; };
  }, [id, setError]);

  const patch = useCallback((key: string, change: Partial<Omit<ViewField, "key">>) => {
    setFields((prev) => {
      const next = { ...prev, [key]: { ...(prev[key] ?? { key, visible: true, size: null, aggregate: null }), ...change } };
      if (id) seen.set(id, next);
      return next;
    });
  }, [id]);

  const save = useCallback((key: string, change: { visible?: boolean; size?: number; aggregate?: string | null }) => {
    if (!id) return;
    patch(key, change);
    api("PUT", `/api/views/${id}/fields/${key}`, change)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not save the column layout"));
  }, [id, patch, setError]);

  return {
    views,
    view,
    reloadViews,
    width: (key: string) => fields[key]?.size ?? defaultWidths[key] ?? fallbackWidth,
    visible: (key: string) => fields[key]?.visible ?? true,
    aggregate: (key: string) => fields[key]?.aggregate ?? null,
    /** Live width while dragging; not saved. */
    resize: (key: string, size: number) => patch(key, { size }),
    /** The final width, saved for everyone. */
    commitWidth: (key: string, size: number) => save(key, { size }),
    setVisible: (key: string, visible: boolean) => save(key, { visible }),
    setAggregate: (key: string, aggregate: string | null) => save(key, { aggregate }),
  };
}

/**
 * The footer totals: each column's chosen calculation, run by the server over
 * the whole filtered list (`listQuery` is the list's own query string, minus
 * paging). Refetches when the calculations, the query or the rows change.
 */
export function useAggregates(path: string, listQuery: string, ops: Array<{ key: string; op: string }>, rows: unknown) {
  const { setError } = useCrm();
  const [values, setValues] = useState<Record<string, number | string | null>>({});
  const opsKey = JSON.stringify(ops);
  useEffect(() => {
    if (!ops.length) { setValues({}); return; }
    let alive = true;
    const p = new URLSearchParams(listQuery);
    p.set("ops", opsKey);
    api<{ values: Record<string, number | string | null> }>("GET", `${path}?${p}`)
      .then((r) => { if (alive) setValues(r.values); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not calculate"));
    return () => { alive = false; };
  }, [path, listQuery, opsKey, rows, setError]); // eslint-disable-line react-hooks/exhaustive-deps
  return values;
}

export type TableView = ReturnType<typeof useTableView>;

/** The part of a list's query the footer totals share: search and filters, no paging. */
export function listFilterQuery(pag: { search: string; filters: unknown[] }): string {
  const p = new URLSearchParams();
  if (pag.search) p.set("search", pag.search);
  if (pag.filters.length) p.set("filters", JSON.stringify(pag.filters));
  return p.toString();
}
