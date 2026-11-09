"use client";

import { useCallback, useEffect, useRef } from "react";
import type { BudgetData, Query } from "@ynab/logic";
import { ROW_HEIGHT } from "./registerConstants.js";
import type { Txn } from "./registerTypes.js";
import type { RegisterState } from "./useRegisterState.js";

export function useRegisterKeyboard({
  data,
  accountFilter,
  focusTransaction,
  externalFilter,
  onEdit,
  onCycleStatus,
  onDelete,
  onClearFilter,
  state,
  filtered,
  isSelectableTxn,
}: {
  data: BudgetData;
  accountFilter: number | null;
  focusTransaction?: { id: number; nonce: number } | null;
  externalFilter?: {
    payee?: string;
    categoryId?: number | null;
    text?: string;
    query?: Query;
    nonce: number;
  } | null;
  onEdit: (id: number) => void;
  onCycleStatus: (id: number) => void;
  onDelete: (id: number) => void;
  onClearFilter?: () => void;
  state: RegisterState;
  filtered: Txn[];
  isSelectableTxn: (r: {
    parentId?: number | null;
    transferAccountId?: number | null;
  }) => boolean;
}) {
  const {
    selectedId,
    setSelectedId,
    setSelectedIds,
    setExpandedSplitIds,
    setAppliedQuery,
    setScrollTop,
    lastHandledNonce,
    containerRef,
    containerHeight,
  } = state;
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Keyboard selection skips ↳ sub-rows, mirroring the checkboxes.
      const selectableRows = filtered.filter(isSelectableTxn);
      if (selectableRows.length === 0) return;
      const currentIndex =
        selectedId != null ? selectableRows.findIndex((r) => r.id === selectedId) : -1;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIndex = currentIndex < selectableRows.length - 1 ? currentIndex + 1 : 0;
        const nextRow = selectableRows[nextIndex];
        if (nextRow) setSelectedId(nextRow.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : selectableRows.length - 1;
        const prevRow = selectableRows[prevIndex];
        if (prevRow) setSelectedId(prevRow.id);
      } else if (e.key === "Enter" && selectedId != null) {
        e.preventDefault();
        const row = selectableRows.find((r) => r.id === selectedId);
        if (row) {
          setSelectedId(null);
          onEdit(row.parentId ?? row.id);
        }
      } else if ((e.key === "c" || e.key === "C" || e.key === " ") && selectedId != null) {
        e.preventDefault();
        const row = selectableRows.find((r) => r.id === selectedId);
        if (row) {
          const isIncoming = accountFilter != null && row.transferAccountId === accountFilter;
          const currentStatus = isIncoming ? (row.transferStatus ?? row.status) : row.status;
          if (currentStatus !== "r") onCycleStatus(row.id);
        }
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId != null) {
        e.preventDefault();
        onDelete(selectedId);
      }
    },
    [filtered, selectedId, onEdit, onCycleStatus, onDelete, accountFilter]
  );

  // Handle focusing/selecting a transaction from external navigation (e.g. Reports, Transfer links)
  useEffect(() => {
    if (!focusTransaction || focusTransaction.nonce === lastHandledNonce.current) return;

    const targetId = focusTransaction.id;
    // A focused jump is fresh navigation: a stale applied filter could hide
    // the target row, so clear it (including the owner's copy).
    setAppliedQuery(null);
    onClearFilter?.();
    const txn = data.transactions.find((x) => x.id === targetId);
    // Selection is parent-only: a sub-row focus lands on its parent (and
    // expands it). Incoming transfer legs stay as-is — they render as
    // top-level rows on the destination account.
    const isIncomingLeg =
      txn?.parentId != null && accountFilter != null && txn.transferAccountId === accountFilter;
    const selectId = txn?.parentId != null && !isIncomingLeg ? txn.parentId : targetId;
    setSelectedIds(new Set([selectId]));
    setSelectedId(selectId);

    if (txn?.parentId != null) {
      setExpandedSplitIds((prev) => {
        if (prev.has(txn.parentId!)) return prev;
        const next = new Set(prev);
        next.add(txn.parentId!);
        return next;
      });
    }

    const targetIndex = filtered.findIndex((r) => r.id === selectId);
    if (targetIndex !== -1) {
      lastHandledNonce.current = focusTransaction.nonce;
      const effH = containerHeight > 0 ? containerHeight : 500;
      const targetScroll = Math.max(0, targetIndex * ROW_HEIGHT - Math.floor(effH / 2));
      if (containerRef.current) {
        containerRef.current.scrollTop = targetScroll;
      }
      setScrollTop(targetScroll);
    }
  }, [focusTransaction, filtered, containerHeight, data.transactions, onClearFilter, accountFilter]);

  // Handle register filtering from global search. The applied query becomes
  // the single source of truth, shown as chips in the toolbar.
  const lastHandledFilterNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!externalFilter || externalFilter.nonce === lastHandledFilterNonce.current) return;
    lastHandledFilterNonce.current = externalFilter.nonce;
    if (externalFilter.query) {
      setAppliedQuery(externalFilter.query);
    } else if (externalFilter.text) {
      setAppliedQuery({ filters: [], text: externalFilter.text });
    } else if (externalFilter.payee) {
      setAppliedQuery({ filters: [{ kind: "payee", value: externalFilter.payee }], text: "" });
    } else if (externalFilter.categoryId != null) {
      const cat = data.categories.find((c) => c.id === externalFilter.categoryId);
      setAppliedQuery(
        cat ? { filters: [{ kind: "category", value: cat.name, exact: true }], text: "" } : null
      );
    }
    setSelectedIds(new Set());
    setSelectedId(null);
  }, [externalFilter, data.categories]);

  return handleKeyDown;
}
