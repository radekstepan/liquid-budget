"use client";

import { useCallback, useMemo } from "react";
import type { BudgetData, DuplicateGroup, Transaction } from "@ynab/logic";
import {
  applyQuery,
  buildSearchCtx,
  computeRunningBalances,
  findDuplicateGroups,
  num,
} from "@ynab/logic";
import { useTodayISO } from "../useTodayISO.js";
import { CLEARED_RANK, FLAG_RANK, OVERSCAN, ROW_HEIGHT } from "./registerConstants.js";
import type { Txn } from "./registerTypes.js";
import type { RegisterState } from "./useRegisterState.js";

export function useRegisterData({
  data,
  accountFilter,
  state,
}: {
  data: BudgetData;
  accountFilter: number | null;
  state: RegisterState;
}) {
  const {
    appliedQuery,
    clearAppliedQuery,
    selectedId,
    selectedIds,
    setSelectedId,
    setSelectedIds,
    setSelectedRecurringIds,
    expandedSplitIds,
    sort,
    scrollTop,
    containerHeight,
    containerRef,
    duplicateInspectorId,
    setDuplicateInspectorId,
  } = state;
  const accountById = useMemo(
    () => new Map(data.accounts.map((a) => [a.id, a] as const)),
    [data.accounts]
  );
  const categoryById = useMemo(
    () => new Map(data.categories.map((c) => [c.id, c] as const)),
    [data.categories]
  );
  const accountBalances = useMemo(
    () => new Map(data.accounts.map((a) => [a.id, num(a.balance)] as const)),
    [data.accounts]
  );

  const rows = useMemo<Txn[]>(() => {
    const filteredList: (Omit<Transaction, "amount"> & { amount: number })[] = [];
    const len = data.transactions.length;
    for (let i = 0; i < len; i++) {
      const t = data.transactions[i]!;
      if (
        accountFilter == null ||
        t.accountId === accountFilter ||
        (t.transferAccountId != null && t.transferAccountId === accountFilter)
      ) {
        filteredList.push({ ...t, amount: num(t.amount) });
      }
    }
    filteredList.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    return computeRunningBalances(filteredList, accountBalances, accountFilter ?? undefined);
  }, [data.transactions, accountFilter, accountBalances]);

  const splitParentIds = useMemo(() => {
    const set = new Set<number>();
    for (let i = 0; i < data.transactions.length; i++) {
      const t = data.transactions[i]!;
      if (t.parentId != null) set.add(t.parentId);
    }
    return set;
  }, [data.transactions]);

  const childrenByParent = useMemo(() => {
    const map = new Map<number, Txn[]>();
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i]!;
      if (t.parentId != null) {
        let list = map.get(t.parentId);
        if (!list) {
          list = [];
          map.set(t.parentId, list);
        }
        list.push(t);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.id - b.id);
    }
    return map;
  }, [rows]);

  // Duplicate groups over the full ledger (same fingerprint the analyzer
  // uses), so a flagged row's D badge can reveal its matching rows — the
  // keeper is unflagged and stays hidden while filtered to duplicates.
  const duplicateGroupById = useMemo(() => {
    const entries = data.transactions
      .map((t) => ({
        id: t.id,
        accountId: t.accountId,
        date: t.date,
        payee: t.payee,
        memo: t.memo ?? "",
        amount: num(t.amount),
        flagColor: t.flagColor ?? null,
        status: t.status,
        parentId: t.parentId ?? null,
        transferAccountId: t.transferAccountId ?? null,
      }))
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    const map = new Map<number, DuplicateGroup>();
    for (const g of findDuplicateGroups(entries)) {
      for (const id of [g.keeper.id, ...g.duplicates.map((d) => d.id)]) {
        if (id != null) map.set(id, g);
      }
    }
    return map;
  }, [data.transactions]);

  const activeDuplicateGroup =
    duplicateInspectorId != null ? (duplicateGroupById.get(duplicateInspectorId) ?? null) : null;

  // Leave the duplicates filter behind and highlight the whole group in the
  // register so each row can be compared (and deleted) in context.
  const showDuplicateGroupInRegister = useCallback(() => {
    if (!activeDuplicateGroup) {
      setDuplicateInspectorId(null);
      return;
    }
    const ids = [activeDuplicateGroup.keeper.id, ...activeDuplicateGroup.duplicates.map((d) => d.id)].filter(
      (id): id is number => id != null
    );
    clearAppliedQuery();
    setSelectedIds(new Set(ids));
    setSelectedId(ids[0] ?? null);
    setDuplicateInspectorId(null);
    const firstId = ids[0];
    if (firstId != null) {
      window.setTimeout(() => {
        containerRef.current
          ?.querySelector(`tr[data-txn-id="${firstId}"]`)
          ?.scrollIntoView?.({ block: "center" });
      }, 50);
    }
  }, [activeDuplicateGroup, clearAppliedQuery, setSelectedId, setSelectedIds]);

  // Top-level rows for the active account. Free-text narrowing now lives in
  // the structured `appliedQuery` stage below (fed by the search modal), so
  // there is no separate substring pass here anymore.
  const searchFilteredTopLevel = useMemo(() => {
    const isTopLevel = (r: Txn) => {
      if (r.parentId == null) return true;
      if (accountFilter != null && r.transferAccountId === accountFilter) return true;
      return false;
    };
    return rows.filter(isTopLevel);
  }, [rows, accountFilter]);

  // Structured filter stage for the applied search query (chips + text from
  // the global search modal). Evaluated on raw transactions, then intersected
  // with the account-scoped rows by id. Split parents are kept when any of
  // their children match, mirroring the substring behaviour above.
  const searchCtx = useMemo(() => buildSearchCtx(data), [data]);
  const queryIdSet = useMemo(() => {
    if (!appliedQuery) return null;
    if (appliedQuery.filters.length === 0 && !appliedQuery.text.trim()) return null;
    const matched = applyQuery(data.transactions, appliedQuery, searchCtx);
    return new Set(matched.map((t) => t.id));
  }, [data.transactions, appliedQuery, searchCtx]);

  const queryFilteredTopLevel = useMemo(() => {
    if (!queryIdSet) return searchFilteredTopLevel;
    return searchFilteredTopLevel.filter((r) => {
      if (queryIdSet.has(r.id)) return true;
      const children = childrenByParent.get(r.id);
      return children != null && children.some((c) => queryIdSet.has(c.id));
    });
  }, [searchFilteredTopLevel, queryIdSet, childrenByParent]);

  // Apply the user-selected column sort on top of the query-filtered rows.
  // The default (Date descending) returns `queryFilteredTopLevel` unchanged
  // since `rows` is already date-descending — running balances stay anchored
  // to that canonical order regardless of how the display is sorted.
  const filtered = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const payeeOf = (t: Txn): string => {
      const isIncoming = accountFilter != null && t.transferAccountId === accountFilter;
      return isIncoming ? `Transfer : ${accountById.get(t.accountId)?.name ?? "Unknown"}` : t.payee;
    };
    const catOf = (t: Txn): string => {
      if (splitParentIds.has(t.id)) return "Split (Multiple Categories)";
      if (t.categoryId != null) return categoryById.get(t.categoryId)?.name ?? "";
      return t.transferAccountId ? "Transfer" : "";
    };
    const effAmtOf = (t: Txn): number => {
      const isIncoming = accountFilter != null && t.transferAccountId === accountFilter;
      return isIncoming ? -t.amount : t.amount;
    };
    const effStatusOf = (t: Txn): string => {
      const isIncoming = accountFilter != null && t.transferAccountId === accountFilter;
      return isIncoming ? (t.transferStatus ?? t.status) : t.status;
    };

    let sortedTopLevel: Txn[];
    if (sort.key === "date" && sort.dir === "desc") {
      sortedTopLevel = queryFilteredTopLevel;
    } else {
      sortedTopLevel = [...queryFilteredTopLevel].sort((a, b) => {
        let cmp = 0;
        switch (sort.key) {
          case "date":
            cmp = a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
            break;
          case "account": {
            const an = accountById.get(a.accountId)?.name ?? "";
            const bn = accountById.get(b.accountId)?.name ?? "";
            cmp = an < bn ? -1 : an > bn ? 1 : 0;
            break;
          }
          case "payee": {
            const an = payeeOf(a);
            const bn = payeeOf(b);
            cmp = an < bn ? -1 : an > bn ? 1 : 0;
            break;
          }
          case "category": {
            const an = catOf(a);
            const bn = catOf(b);
            cmp = an < bn ? -1 : an > bn ? 1 : 0;
            break;
          }
          case "memo": {
            const an = a.memo ?? "";
            const bn = b.memo ?? "";
            cmp = an < bn ? -1 : an > bn ? 1 : 0;
            break;
          }
          case "outflow": {
            const an = effAmtOf(a) < 0 ? -effAmtOf(a) : 0;
            const bn = effAmtOf(b) < 0 ? -effAmtOf(b) : 0;
            cmp = an - bn;
            break;
          }
          case "inflow": {
            const an = effAmtOf(a) > 0 ? effAmtOf(a) : 0;
            const bn = effAmtOf(b) > 0 ? effAmtOf(b) : 0;
            cmp = an - bn;
            break;
          }
          case "cleared":
            cmp = (CLEARED_RANK[effStatusOf(a)] ?? 0) - (CLEARED_RANK[effStatusOf(b)] ?? 0);
            break;
          case "flag": {
            const an = a.flagColor != null ? FLAG_RANK[a.flagColor] ?? 0 : 0;
            const bn = b.flagColor != null ? FLAG_RANK[b.flagColor] ?? 0 : 0;
            cmp = an - bn;
            break;
          }
          case "balance":
            // Rows without a walk entry ("—") sort as 0.
            cmp = (a.runningBalance ?? 0) - (b.runningBalance ?? 0);
            break;
        }
        if (cmp === 0) {
          if (sort.key === "date") {
            cmp = a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
            if (cmp === 0) cmp = a.id - b.id;
          } else {
            cmp = a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
            if (cmp === 0) cmp = b.id - a.id;
          }
        }
        return cmp * dir;
      });
    }

    const result: Txn[] = [];
    for (const parent of sortedTopLevel) {
      result.push(parent);
      if (splitParentIds.has(parent.id)) {
        const children = childrenByParent.get(parent.id);
        if (children && children.length > 0) {
          const hasMatchingChild =
            queryIdSet != null && children.some((c) => queryIdSet.has(c.id));
          // Selection is parent-only: sub-rows are never in selectedId /
          // selectedIds, so expansion only follows the parent.
          const isParentSelected = selectedId === parent.id || selectedIds.has(parent.id);
          const isExpanded =
            expandedSplitIds.has(parent.id) ||
            isParentSelected ||
            hasMatchingChild;

          if (isExpanded) {
            for (const child of children) {
              result.push(child);
            }
          }
        }
      }
    }
    return result;
  }, [
    queryFilteredTopLevel,
    queryIdSet,
    sort,
    accountById,
    categoryById,
    accountFilter,
    splitParentIds,
    childrenByParent,
    expandedSplitIds,
    selectedId,
    selectedIds,
  ]);

  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    let count = 0;
    const parentsWithVisibleChildren = new Set<number>();
    for (const r of filtered) {
      if (r.parentId != null) {
        parentsWithVisibleChildren.add(r.parentId);
      }
    }
    for (const r of filtered) {
      if (splitParentIds.has(r.id) && parentsWithVisibleChildren.has(r.id)) {
        continue;
      }
      count++;
      const isIncoming = accountFilter != null && r.transferAccountId === accountFilter;
      const effAmt = isIncoming ? -r.amount : r.amount;
      if (effAmt > 0) inflow += effAmt;
      else outflow += -effAmt;
    }
    return { inflow, outflow, net: inflow - outflow, count };
  }, [filtered, accountFilter, splitParentIds]);

  const filterAccount = accountFilter != null ? accountById.get(accountFilter) : null;
  const hasFlagColumn = useMemo(
    () => filtered.some((r) => r.flagColor != null),
    [filtered]
  );
  const colCount = (accountFilter ? 8 : 9) + 1 + (hasFlagColumn ? 1 : 0);

  // Scheduled transactions for the active account / view (always sorted by date ASC)
  const scheduledRows = useMemo(() => {
    const list = data.recurring.filter((r) => {
      if (accountFilter == null) return true;
      if (r.accountId === accountFilter || r.transferAccountId === accountFilter) return true;
      const subChildren = r.subTransactions ?? [];
      return subChildren.some((c) => c.transferAccountId === accountFilter);
    });

    // Scheduled rows only understand free text (they are Recurring, not
    // Transactions), so they follow the text part of the applied query.
    const q = (appliedQuery?.text ?? "").trim().toLowerCase();
    const filteredList = !q
      ? list
      : list.filter((r) => {
          const isIncoming = accountFilter != null && r.transferAccountId === accountFilter;
          const payeeText = isIncoming
            ? `Transfer : ${accountById.get(r.accountId)?.name ?? "Unknown"}`
            : r.payee;
          const catName = (r.categoryId != null ? categoryById.get(r.categoryId)?.name : "") ?? "";
          if (
            payeeText.toLowerCase().includes(q) ||
            catName.toLowerCase().includes(q)
          ) {
            return true;
          }
          const children = r.subTransactions ?? [];
          return children.some((c) => {
            const childDest = c.transferAccountId != null ? accountById.get(c.transferAccountId)?.name : "";
            const childPayee = childDest ? `Transfer : ${childDest}` : "";
            const childCat = (c.categoryId != null ? categoryById.get(c.categoryId)?.name : "") ?? "";
            const childMemo = c.memo ?? "";
            return (
              childPayee.toLowerCase().includes(q) ||
              childCat.toLowerCase().includes(q) ||
              childMemo.toLowerCase().includes(q)
            );
          });
        });

    return [...filteredList].sort((a, b) =>
      a.nextDate < b.nextDate ? -1 : a.nextDate > b.nextDate ? 1 : a.payee.localeCompare(b.payee)
    );
  }, [data.recurring, accountFilter, appliedQuery, accountById, categoryById]);

  const today = useTodayISO();
  const dueScheduledCount = useMemo(() => {
    return scheduledRows.filter((r) => r.active && r.nextDate <= today).length;
  }, [scheduledRows, today]);

  const hasScheduledFlag = useMemo(
    () => scheduledRows.some((r) => r.flagColor != null),
    [scheduledRows]
  );

  const scheduledColCount = (accountFilter ? 8 : 9) + 1 + (hasScheduledFlag ? 1 : 0);

  // Virtualization window calculations
  const totalCount = filtered.length;
  const effectiveHeight =
    containerHeight > 0
      ? containerHeight
      : typeof window !== "undefined" && window.innerHeight > 0
        ? window.innerHeight
        : 800;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(totalCount, Math.ceil((scrollTop + effectiveHeight) / ROW_HEIGHT) + OVERSCAN);

  const topHeight = startIndex * ROW_HEIGHT;
  const bottomHeight = Math.max(0, (totalCount - endIndex) * ROW_HEIGHT);
  const visibleRows = filtered.slice(startIndex, endIndex);

  // Selectable rows: parents plus incoming split-transfer legs, which render
  // as top-level rows on the destination account. Expanded ↳ sub-rows
  // (parentId set, not an incoming leg) are never selectable.
  const isSelectableTxn = (r: {
    parentId?: number | null;
    transferAccountId?: number | null;
  }) => r.parentId == null || (accountFilter != null && r.transferAccountId === accountFilter);
  const topLevelVisibleRows = visibleRows.filter(isSelectableTxn);
  const allVisibleSelected =
    topLevelVisibleRows.length > 0 && topLevelVisibleRows.every((r) => selectedIds.has(r.id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const allSelected = topLevelVisibleRows.length > 0 && topLevelVisibleRows.every((r) => prev.has(r.id));
      if (allSelected) {
        return new Set();
      } else {
        const next = new Set(prev);
        for (const r of topLevelVisibleRows) next.add(r.id);
        return next;
      }
    });
  };

  const toggleRowSelect = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const txn = data.transactions.find((t) => t.id === id);
    if (txn && !isSelectableTxn(txn)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleRecurringRowSelect = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedRecurringIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return {
    accountById,
    categoryById,
    splitParentIds,
    childrenByParent,
    activeDuplicateGroup,
    showDuplicateGroupInRegister,
    queryIdSet,
    filtered,
    totals,
    filterAccount,
    hasFlagColumn,
    colCount,
    scheduledRows,
    today,
    dueScheduledCount,
    hasScheduledFlag,
    scheduledColCount,
    startIndex,
    topHeight,
    bottomHeight,
    visibleRows,
    isSelectableTxn,
    allVisibleSelected,
    toggleSelectAll,
    toggleRowSelect,
    toggleRecurringRowSelect,
  };
}

export type RegisterData = ReturnType<typeof useRegisterData>;
