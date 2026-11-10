"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BudgetData,
  MergeableTransaction,
  MergeOverrides,
  Query,
  Transaction,
} from "@ynab/logic";
import { num, pickMergePrimary } from "@ynab/logic";
// TODO(P2) [merge-dedupe]: selection recomputes pickMergePrimary client-side — prefer server
// merged.id response to avoid duplicating merge-rule knowledge in UI.
import { useLocalStorage } from "../useLocalStorage.js";
import type { SortKey, SortState } from "./registerTypes.js";
import {
  SCHEDULED_HEIGHT_STORAGE_KEY,
  MIN_SCHEDULED_HEIGHT,
  isScheduledHeights,
  clampScheduledHeight,
} from "./scheduledHeights.js";

export function useRegisterState({
  data,
  accountFilter,
  controlledSelectedId,
  onSelectedIdChange,
  controlledSelectedIds,
  onSelectedIdsChange,
  controlledSelectedRecurringIds,
  onSelectedRecurringIdsChange,
  onMergeTransactions,
  onClearFilter,
}: {
  data: BudgetData;
  accountFilter: number | null;
  controlledSelectedId?: number | null;
  onSelectedIdChange?: (update: number | null | ((prev: number | null) => number | null)) => void;
  controlledSelectedIds?: Set<number>;
  onSelectedIdsChange?: (update: Set<number> | ((prev: Set<number>) => Set<number>)) => void;
  controlledSelectedRecurringIds?: Set<number>;
  onSelectedRecurringIdsChange?: (update: Set<number> | ((prev: Set<number>) => Set<number>)) => void;
  onMergeTransactions?: (ids: number[], overrides?: MergeOverrides) => Promise<void> | void;
  onClearFilter?: () => void;
}) {
  const [appliedQuery, setAppliedQuery] = useState<Query | null>(null);

  // Clearing must also notify the owner: BudgetApp's registerFilter persists
  // across view switches, so a locally-cleared filter would otherwise
  // re-apply when the register remounts (filter "comes back" after Clear +
  // navigating away and back).
  const clearAppliedQuery = useCallback(() => {
    setAppliedQuery(null);
    onClearFilter?.();
  }, [onClearFilter]);

  const removeAppliedFilterChip = useCallback(
    (idx: number) => {
      if (!appliedQuery) return;
      const next = { ...appliedQuery, filters: appliedQuery.filters.filter((_, j) => j !== idx) };
      if (next.filters.length === 0 && !next.text.trim()) clearAppliedQuery();
      else setAppliedQuery(next);
    },
    [appliedQuery, clearAppliedQuery]
  );

  const removeAppliedTextChip = useCallback(() => {
    if (!appliedQuery) return;
    if (appliedQuery.filters.length === 0) clearAppliedQuery();
    else setAppliedQuery({ ...appliedQuery, text: "" });
  }, [appliedQuery, clearAppliedQuery]);

  // Register selection lives here when uncontrolled, or in the owner
  // (BudgetApp) when the controlled props are provided — the register
  // unmounts on every view switch, so owner-held selection is what lets a
  // selection survive navigating away and back.
  const [internalSelectedId, setInternalSelectedId] = useState<number | null>(
    controlledSelectedId ?? null
  );
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<number>>(
    () => new Set(controlledSelectedIds ?? [])
  );
  const [internalSelectedRecurringIds, setInternalSelectedRecurringIds] = useState<Set<number>>(
    () => new Set(controlledSelectedRecurringIds ?? [])
  );
  const selectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId;
  const setSelectedId =
    controlledSelectedId !== undefined && onSelectedIdChange
      ? onSelectedIdChange
      : setInternalSelectedId;
  const selectedIds =
    controlledSelectedIds !== undefined ? controlledSelectedIds : internalSelectedIds;
  const setSelectedIds =
    controlledSelectedIds !== undefined && onSelectedIdsChange
      ? onSelectedIdsChange
      : setInternalSelectedIds;
  const selectedRecurringIds =
    controlledSelectedRecurringIds !== undefined
      ? controlledSelectedRecurringIds
      : internalSelectedRecurringIds;
  const setSelectedRecurringIds =
    controlledSelectedRecurringIds !== undefined && onSelectedRecurringIdsChange
      ? onSelectedRecurringIdsChange
      : setInternalSelectedRecurringIds;

  // Confirm a merge preview: run the merge, then leave the surviving
  // (merged) row selected. On failure the modal stays open with the
  // error and the selection is untouched.
  const confirmMergePreview = useCallback(
    async (ids: number[], overrides: MergeOverrides) => {
      if (!onMergeTransactions) return;
      await onMergeTransactions(ids, overrides);
      const [a, b] = ids.map((id) => data.transactions.find((t) => t.id === id));
      if (a && b) {
        const toMergeable = (t: Transaction): MergeableTransaction => ({
          ...t,
          transferAccountId: t.transferAccountId ?? null,
          amount: num(t.amount),
        });
        const [survivor] = pickMergePrimary(toMergeable(a), toMergeable(b));
        setSelectedIds(new Set([survivor.id]));
      } else {
        setSelectedIds(new Set());
      }
      setMergePreviewIds(null);
    },
    [data.transactions, onMergeTransactions, setSelectedIds]
  );
  const [mergePreviewIds, setMergePreviewIds] = useState<number[] | null>(null);
  const [duplicateInspectorId, setDuplicateInspectorId] = useState<number | null>(null);
  const [sort, setSort] = useLocalStorage<SortState>(
    "ynab:transactions:sort",
    { key: "date", dir: "desc" },
    (v): v is SortState => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
      const s = v as Record<string, unknown>;
      const validKeys: SortKey[] = [
        "date",
        "account",
        "payee",
        "category",
        "memo",
        "outflow",
        "inflow",
        "cleared",
        "flag",
        "balance",
      ];
      return (
        typeof s.key === "string" &&
        validKeys.includes(s.key as SortKey) &&
        (s.dir === "asc" || s.dir === "desc")
      );
    }
  );
  const lastHandledNonce = useRef<number | null>(null);

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      }
      return { key, dir: key === "date" ? "desc" : "asc" };
    });
  }, [setSort]);

  // Scheduled drawer state
  const [showScheduledDrawer, setShowScheduledDrawer] = useLocalStorage<boolean>(
    "ynab:transactions:showScheduledDrawer",
    true,
    (v): v is boolean => typeof v === "boolean"
  );

  const toggleScheduledDrawer = () => {
    setShowScheduledDrawer((prev) => !prev);
  };

  // Resizable scheduled drawer height, remembered per account ("all" for
  // the unfiltered register). No stored value means auto height. While
  // dragging the live value stays local and only the final height is
  // persisted — mirroring the sidebar width resize.
  const [scheduledHeights, setScheduledHeights] = useLocalStorage<Record<string, number>>(
    SCHEDULED_HEIGHT_STORAGE_KEY,
    {},
    isScheduledHeights
  );
  const scheduledHeightKey = accountFilter == null ? "all" : String(accountFilter);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const isScheduledResizing = useRef(false);

  useEffect(() => {
    setDragHeight(null);
  }, [accountFilter]);

  const scheduledHeight = dragHeight ?? scheduledHeights[scheduledHeightKey] ?? null;

  const startScheduledResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    const key = scheduledHeightKey;
    const startY = e.clientY;
    const startHeight = drawerRef.current?.getBoundingClientRect().height ?? MIN_SCHEDULED_HEIGHT;
    isScheduledResizing.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isScheduledResizing.current) return;
      setDragHeight(clampScheduledHeight(startHeight + (startY - moveEvent.clientY)));
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      if (!isScheduledResizing.current) return;
      isScheduledResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      const finalHeight = clampScheduledHeight(startHeight + (startY - upEvent.clientY));
      setDragHeight(null);
      setScheduledHeights((prev) => ({ ...prev, [key]: finalHeight }));
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const resetScheduledHeight = () => {
    const key = scheduledHeightKey;
    setDragHeight(null);
    setScheduledHeights((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const [expandedSplitIds, setExpandedSplitIds] = useState<Set<number>>(new Set());

  const toggleExpandSplit = useCallback((id: number) => {
    setExpandedSplitIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerHeight(entry.contentRect.height);
        }
      });
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);

  return {
    appliedQuery,
    setAppliedQuery,
    clearAppliedQuery,
    removeAppliedFilterChip,
    removeAppliedTextChip,
    selectedId,
    setSelectedId,
    selectedIds,
    setSelectedIds,
    selectedRecurringIds,
    setSelectedRecurringIds,
    confirmMergePreview,
    mergePreviewIds,
    setMergePreviewIds,
    duplicateInspectorId,
    setDuplicateInspectorId,
    sort,
    setSort,
    lastHandledNonce,
    toggleSort,
    showScheduledDrawer,
    setShowScheduledDrawer,
    toggleScheduledDrawer,
    scheduledHeights,
    setScheduledHeights,
    scheduledHeightKey,
    dragHeight,
    setDragHeight,
    drawerRef,
    scheduledHeight,
    startScheduledResizing,
    resetScheduledHeight,
    expandedSplitIds,
    setExpandedSplitIds,
    toggleExpandSplit,
    containerRef,
    scrollTop,
    setScrollTop,
    containerHeight,
    setContainerHeight,
    handleScroll,
  };
}

export type RegisterState = ReturnType<typeof useRegisterState>;
