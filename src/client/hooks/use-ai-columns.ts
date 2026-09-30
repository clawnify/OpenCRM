import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import { useCrm } from "@/context";
import type { AiCellState, AiColumnConfig, AiField } from "@/types";

interface AiState {
  fields: AiField[];
  columns: AiColumnConfig[];
  cells: AiCellState[];
  limit: number;
  can_configure: boolean;
}

/**
 * A table's AI columns: the fields the AI can fill, the columns it does, and
 * the cells being filled. Polls while a fill runs, and refreshes the records
 * each time cells finish, so their values appear as they land.
 */
export function useAiColumns(entity: "company" | "contact") {
  const { recordsChanged, setError } = useCrm();
  const [state, setState] = useState<AiState | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api<AiState>("GET", `/api/ai-columns?entity_type=${entity}`));
    } catch {
      /* AI unavailable: the table works without it */
    }
  }, [entity]);
  useEffect(() => { void load(); }, [load]);

  const cells = useMemo(() => new Map((state?.cells ?? []).map((c) => [`${c.record_id}:${c.field_key}`, c])), [state]);
  const pending = state?.cells.filter((c) => c.status !== "error").length ?? 0;
  const lastPending = useRef(0);
  useEffect(() => {
    if (pending < lastPending.current) void recordsChanged();
    lastPending.current = pending;
    if (!pending) return;
    const t = setTimeout(() => void load(), 1500);
    return () => clearTimeout(t);
  }, [state, pending, load, recordsChanged]);

  const act = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The AI request failed");
      return null;
    } finally {
      await load();
    }
  };

  return {
    limit: state?.limit ?? 20,
    canConfigure: state?.can_configure ?? false,
    field: (key: string) => state?.fields.find((f) => f.key === key) ?? null,
    column: (key: string) => state?.columns.find((c) => c.field_key === key) ?? null,
    cell: (rowId: string, key: string) => cells.get(`${rowId}:${key}`) ?? null,
    pendingIn: (key: string) => state?.cells.filter((c) => c.field_key === key && c.status !== "error").length ?? 0,
    save: (key: string, prompt: string, research: boolean) => act(() => api("PUT", `/api/ai-columns/${entity}/${key}`, { prompt, research })),
    turnOff: (key: string) => act(() => api("DELETE", `/api/ai-columns/${entity}/${key}`)),
    fill: (key: string, ids: string[]) => act(() => api<{ queued: number }>("POST", `/api/ai-columns/${entity}/${key}/fill`, { ids })),
    regenerate: (key: string, id: string) => act(() => api("POST", `/api/ai-columns/${entity}/${key}/cells/${encodeURIComponent(id)}`, {})),
  };
}

export type AiColumns = ReturnType<typeof useAiColumns>;
