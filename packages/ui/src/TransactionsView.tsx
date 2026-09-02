"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetData, BulkUpdateTransactionPatch, Transaction, TransactionFlagColor } from "@ynab/logic";
import {
  computeRunningBalances,
  frequencyLabel,
  num,
  recurringFlavour,
  todayISO,
} from "@ynab/logic";
import { Icon, ClearedFlag, FlagCell, Toolbar, ToolbarSep, TextField, Button, money, cx } from "@ynab/theme";
import { useLocalStorage } from "./useLocalStorage.js";

type Txn = Omit<Transaction, "amount"> & { amount: number; runningBalance: number | null };

type SortKey =
  | "date"
  | "account"
  | "payee"
  | "category"
  | "memo"
  | "outflow"
  | "inflow"
  | "cleared"
  | "flag"
  | "balance";

type SortState = { key: SortKey; dir: "asc" | "desc" };

const CLEARED_RANK: Record<string, number> = { u: 0, c: 1, r: 2 };

// Flag sort order: unflagged rows first, then the YNAB4 palette order, with
// the read-only duplicate marker last.
const FLAG_RANK: Record<string, number> = {
  red: 1,
  orange: 2,
  yellow: 3,
  green: 4,
  blue: 5,
  purple: 6,
  duplicate: 7,
};

function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  className,
  style,
  title,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
      className={className}
      style={style}
    >
      <button
        type="button"
        className="y-sort-btn"
        onClick={() => onSort(sortKey)}
        title={title ?? `Sort by ${label}`}
      >
        {label}
        {/* The indicator slot is always reserved (even when inactive) so a
            column's intrinsic width never changes when the sort key moves —
            otherwise the register columns would reflow on every click. */}
        <span
          aria-hidden="true"
          className="y-sort-ind"
          style={{ display: "inline-block", width: 10, fontSize: 8, textAlign: "center" }}
        >
          {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

const ROW_HEIGHT = 27;
const OVERSCAN = 15;

export const TransactionsView = memo(function TransactionsView({
  data,
  accountFilter,
  focusTransaction,
  onAdd,
  onAddTransfer,
  onEdit,
  onBulkEdit,
  onDelete,
  onReconcile,
  onCycleStatus,
  onFlag,
  onBulkDelete,
  onBulkUpdate,
  onAddRecurring,
  onAddRecurringTransfer,
  onEditRecurring,
  onDeleteRecurring,
  onPostRecurring,
  onFlagRecurring,
  onBulkPostRecurring,
  onBulkUpdateRecurring,
  onBulkDeleteRecurring,
}: {
  data: BudgetData;
  accountFilter: number | null;
  focusTransaction?: { id: number; nonce: number } | null;
  onAdd: () => void;
  onAddTransfer?: () => void;
  onEdit: (id: number) => void;
  onBulkEdit?: (ids: number[]) => void;
  onDelete: (id: number) => void;
  onReconcile: (accountId: number) => void;
  onCycleStatus: (id: number) => void;
  onFlag: (id: number, color: TransactionFlagColor | null) => void;
  onBulkDelete?: (ids: number[]) => Promise<void> | void;
  onBulkUpdate?: (ids: number[], patch: BulkUpdateTransactionPatch) => Promise<void> | void;
  onAddRecurring?: () => void;
  onAddRecurringTransfer?: () => void;
  onEditRecurring?: (id: number) => void;
  onDeleteRecurring?: (id: number) => void;
  onPostRecurring?: (id: number, date?: string) => void;
  onFlagRecurring?: (id: number, color: TransactionFlagColor | null) => void;
  onBulkPostRecurring?: (ids: number[], date?: string) => Promise<void> | void;
  onBulkUpdateRecurring?: (ids: number[], patch: { flagColor?: TransactionFlagColor | null; active?: boolean }) => Promise<void> | void;
  onBulkDeleteRecurring?: (ids: number[]) => Promise<void> | void;
}) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectedRecurringIds, setSelectedRecurringIds] = useState<Set<number>>(new Set());
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

  const searchFilteredTopLevel = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    const isTopLevel = (r: Txn) => {
      if (r.parentId == null) return true;
      if (accountFilter != null && r.transferAccountId === accountFilter) return true;
      return false;
    };
    const topLevelRows = rows.filter(isTopLevel);
    if (!q) return topLevelRows;

    return topLevelRows.filter((r) => {
      const isIncoming = accountFilter != null && r.transferAccountId === accountFilter;
      const payeeText = isIncoming
        ? `Transfer : ${accountById.get(r.accountId)?.name ?? "Unknown"}`
        : r.payee;
      const catName = (r.categoryId != null ? categoryById.get(r.categoryId)?.name : "") ?? "";
      if (
        payeeText.toLowerCase().includes(q) ||
        catName.toLowerCase().includes(q) ||
        (r.memo ?? "").toLowerCase().includes(q)
      ) {
        return true;
      }
      const children = childrenByParent.get(r.id);
      if (children) {
        return children.some((c) => {
          const childDest = c.transferAccountId != null ? accountById.get(c.transferAccountId)?.name : "";
          const childPayee = childDest ? `Transfer : ${childDest}` : c.payee;
          const childCat = (c.categoryId != null ? categoryById.get(c.categoryId)?.name : "") ?? "";
          return (
            childPayee.toLowerCase().includes(q) ||
            childCat.toLowerCase().includes(q) ||
            (c.memo ?? "").toLowerCase().includes(q)
          );
        });
      }
      return false;
    });
  }, [rows, deferredSearch, childrenByParent, categoryById, accountFilter, accountById]);

  // Apply the user-selected column sort on top of the search-filtered rows.
  // The default (Date descending) returns `searchFilteredTopLevel` unchanged since
  // `rows` is already date-descending — running balances stay anchored to
  // that canonical order regardless of how the display is sorted.
  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
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
      sortedTopLevel = searchFilteredTopLevel;
    } else {
      sortedTopLevel = [...searchFilteredTopLevel].sort((a, b) => {
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
            q !== "" &&
            children.some((c) => {
              const childDest = c.transferAccountId != null ? accountById.get(c.transferAccountId)?.name : "";
              const childPayee = childDest ? `Transfer : ${childDest}` : c.payee;
              const childCat = (c.categoryId != null ? categoryById.get(c.categoryId)?.name : "") ?? "";
              return (
                childPayee.toLowerCase().includes(q) ||
                childCat.toLowerCase().includes(q) ||
                (c.memo ?? "").toLowerCase().includes(q)
              );
            });
          const isChildSelected = selectedId != null && children.some((c) => c.id === selectedId);
          const isChildInMultiSelect = Array.from(selectedIds).some((id) => children.some((c) => c.id === id));
          const isParentSelected = selectedId === parent.id || selectedIds.has(parent.id);
          const isExpanded =
            expandedSplitIds.has(parent.id) ||
            isParentSelected ||
            isChildSelected ||
            isChildInMultiSelect ||
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
    searchFilteredTopLevel,
    sort,
    accountById,
    categoryById,
    accountFilter,
    splitParentIds,
    childrenByParent,
    deferredSearch,
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

    const q = deferredSearch.trim().toLowerCase();
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
  }, [data.recurring, accountFilter, deferredSearch, accountById, categoryById]);

  const today = useMemo(() => todayISO(), []);
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

  const topLevelVisibleRows = visibleRows.filter((r) => r.parentId == null);
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (filtered.length === 0) return;
      const currentIndex = selectedId != null ? filtered.findIndex((r) => r.id === selectedId) : -1;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIndex = currentIndex < filtered.length - 1 ? currentIndex + 1 : 0;
        const nextRow = filtered[nextIndex];
        if (nextRow) setSelectedId(nextRow.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : filtered.length - 1;
        const prevRow = filtered[prevIndex];
        if (prevRow) setSelectedId(prevRow.id);
      } else if (e.key === "Enter" && selectedId != null) {
        e.preventDefault();
        const row = filtered.find((r) => r.id === selectedId);
        if (row) {
          setSelectedId(null);
          onEdit(row.parentId ?? row.id);
        }
      } else if ((e.key === "c" || e.key === "C" || e.key === " ") && selectedId != null) {
        e.preventDefault();
        const row = filtered.find((r) => r.id === selectedId);
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
    [filtered, selectedId, onEdit, onCycleStatus, onDelete]
  );

  // Handle focusing/selecting a transaction from external navigation (e.g. Reports)
  useEffect(() => {
    if (!focusTransaction || focusTransaction.nonce === lastHandledNonce.current) return;
    lastHandledNonce.current = focusTransaction.nonce;

    const targetId = focusTransaction.id;
    if (search) setSearch("");
    setSelectedIds(new Set([targetId]));
    setSelectedId(targetId);

    const targetIndex = filtered.findIndex((r) => r.id === targetId);
    if (targetIndex !== -1) {
      const effH = containerHeight > 0 ? containerHeight : 500;
      const targetScroll = Math.max(0, targetIndex * ROW_HEIGHT - Math.floor(effH / 2));
      if (containerRef.current) {
        containerRef.current.scrollTop = targetScroll;
      }
      setScrollTop(targetScroll);
    }
  }, [focusTransaction, filtered, containerHeight, search]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white" onKeyDown={handleKeyDown} tabIndex={0}>
      {/* Top Register Header Toolbar */}
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="swap" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>
            {filterAccount ? filterAccount.name : "All Transactions"}
          </span>
          {filterAccount?.archived && (
            <span
              className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded border"
              style={{
                backgroundColor: "var(--y-gray-100, #f1f5f9)",
                borderColor: "var(--y-gray-300, #cbd5e1)",
                color: "var(--y-ink-soft, #64748b)",
              }}
            >
              Archived
            </span>
          )}
        </div>
        <ToolbarSep />
        <TextField
          search
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search register"
          style={{ width: 168 }}
        />
      </Toolbar>

      {/* Register Summary Strip / Multi-Selection Actions Bar (in-place replacement, no layout shift) */}
      <div className="y-subbar flex items-center gap-2 px-3 py-1 text-[11px] flex-shrink-0 min-h-[28px]">
        {selectedIds.size > 0 ? (
          <>
            <span className="y-caps font-bold" style={{ color: "var(--y-ink)" }}>
              {selectedIds.size} selected
            </span>
            <div className="y-tb-sep mx-1" style={{ height: 14 }} />
            <Button
              variant="default"
              size="sm"
              className="!py-0.5 !px-2 text-[11px]"
              onClick={() => {
                const ids = Array.from(selectedIds);
                if (ids.length === 1 && ids[0] !== undefined) {
                  onEdit(ids[0]);
                } else if (onBulkEdit) {
                  onBulkEdit(ids);
                } else if (ids.length > 0 && ids[0] !== undefined) {
                  onEdit(ids[0]);
                }
              }}
            >
              Edit{selectedIds.size > 1 ? ` (${selectedIds.size})` : ""}
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="!py-0.5 !px-2 text-[11px]"
              onClick={async () => {
                const ids = Array.from(selectedIds);
                setSelectedIds(new Set());
                if (onBulkDelete) await onBulkDelete(ids);
                else for (const id of ids) onDelete(id);
              }}
            >
              Delete ({selectedIds.size})
            </Button>
            <Button
              variant="default"
              size="sm"
              className="ml-auto !py-0.5 !px-2 text-[11px]"
              onClick={() => setSelectedIds(new Set())}
            >
              Deselect All
            </Button>
          </>
        ) : (
          <>
            <span className="y-caps">{totals.count} transactions</span>
            <span className="y-num font-bold" style={{ color: "var(--y-ink)" }}>
              Inflow {money(totals.inflow)}
            </span>
            <span className="y-num font-bold" style={{ color: "var(--y-ink-soft)" }}>
              Outflow −{money(totals.outflow)}
            </span>
            <span
              className="y-num font-bold ml-auto"
              style={{ color: totals.net >= 0 ? "var(--y-green-dk)" : "var(--y-red)" }}
            >
              Net {money(totals.net)}
            </span>
          </>
        )}
      </div>

      {/* Main Register Table View */}
      <div
        ref={containerRef}
        tabIndex={0}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-auto y-scroll bg-white"
        style={{ minHeight: 120, background: "#ffffff" }}
      >
        <table className="y-table w-full text-left bg-white">
          <thead className="y-thead--sticky">
            <tr>
              <th
                style={{ width: 34, minWidth: 34, textAlign: "center", padding: "4px 6px" }}
                className="text-center"
              >
                <input
                  type="checkbox"
                  aria-label="Select all transactions"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer align-middle inline-block"
                  style={{ verticalAlign: "middle", margin: "0 auto", display: "inline-block" }}
                />
              </th>
              {hasFlagColumn && (
                <SortableTh
                  label="F"
                  title="Sort by Flag"
                  sortKey="flag"
                  sort={sort}
                  onSort={toggleSort}
                  className="text-center"
                  style={{ width: 32 }}
                />
              )}
              <SortableTh label="Date" sortKey="date" sort={sort} onSort={toggleSort} style={{ width: 85 }} />
              {!accountFilter && (
                <SortableTh
                  label="Account"
                  sortKey="account"
                  sort={sort}
                  onSort={toggleSort}
                  style={{ width: 120 }}
                />
              )}
              <SortableTh label="Payee" sortKey="payee" sort={sort} onSort={toggleSort} />
              <SortableTh
                label="Category"
                sortKey="category"
                sort={sort}
                onSort={toggleSort}
                style={{ width: 180 }}
              />
              <SortableTh
                label="Memo"
                sortKey="memo"
                sort={sort}
                onSort={toggleSort}
                style={{ width: 160 }}
              />
              <SortableTh
                label="Outflow"
                sortKey="outflow"
                sort={sort}
                onSort={toggleSort}
                className="num"
                style={{ width: 95 }}
              />
              <SortableTh
                label="Inflow"
                sortKey="inflow"
                sort={sort}
                onSort={toggleSort}
                className="num"
                style={{ width: 95 }}
              />
              <SortableTh
                label="C"
                sortKey="cleared"
                sort={sort}
                onSort={toggleSort}
                className="text-center"
                style={{ width: 32 }}
              />
              <SortableTh
                label="Balance"
                sortKey="balance"
                sort={sort}
                onSort={toggleSort}
                className="num"
                style={{ width: 108 }}
              />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="text-center py-6 y-hint">
                  No transactions match your filter.
                </td>
              </tr>
            ) : (
              <>
                {topHeight > 0 && (
                  <tr style={{ height: topHeight }}>
                    <td colSpan={colCount} style={{ height: topHeight, padding: 0, border: 0 }} />
                  </tr>
                )}
                {visibleRows.map((t, idx) => {
                  const globalIndex = startIndex + idx;
                  const isSelected = t.id === selectedId || selectedIds.has(t.id);
                  const isChecked = selectedIds.has(t.id);
                  const isIncoming = accountFilter != null && t.transferAccountId === accountFilter;
                  const effAmt = isIncoming ? -t.amount : t.amount;
                  const effStatus = isIncoming ? (t.transferStatus ?? t.status) : t.status;
                  const isReconciled = effStatus === "r";
                  const outflow = effAmt < 0 ? -effAmt : 0;
                  const inflow = effAmt > 0 ? effAmt : 0;
                  const isSplit = splitParentIds.has(t.id);
                  const isChildRow = t.parentId != null && !isIncoming;
                  const catName =
                    t.categoryId != null ? categoryById.get(t.categoryId)?.name ?? "" : "";
                  const displayCat = isChildRow
                    ? (catName || (t.transferAccountId ? "Transfer" : ""))
                    : isSplit
                      ? "Split (Multiple Categories)"
                      : catName || (t.transferAccountId ? "Transfer" : "");
                  const displayPayee = isIncoming
                    ? `Transfer : ${accountById.get(t.accountId)?.name ?? "Unknown"}`
                    : isChildRow && t.transferAccountId != null
                      ? `Transfer : ${accountById.get(t.transferAccountId)?.name ?? "Unknown"}`
                      : t.payee;

                  const children = childrenByParent.get(t.id);
                  const hasMatchingChild =
                    deferredSearch.trim() !== "" &&
                    (children?.some((c) => {
                      const q = deferredSearch.trim().toLowerCase();
                      const childDest = c.transferAccountId != null ? accountById.get(c.transferAccountId)?.name : "";
                      const childPayee = childDest ? `Transfer : ${childDest}` : c.payee;
                      const childCat = (c.categoryId != null ? categoryById.get(c.categoryId)?.name : "") ?? "";
                      return (
                        childPayee.toLowerCase().includes(q) ||
                        childCat.toLowerCase().includes(q) ||
                        (c.memo ?? "").toLowerCase().includes(q)
                      );
                    }) ?? false);
                  const isChildSelected = selectedId != null && (children?.some((c) => c.id === selectedId) ?? false);
                  const isChildInMultiSelect = Array.from(selectedIds).some((id) => children?.some((c) => c.id === id) ?? false);
                  const isParentSelected = selectedId === t.id || selectedIds.has(t.id);
                  const isExpanded =
                    expandedSplitIds.has(t.id) ||
                    isParentSelected ||
                    isChildSelected ||
                    isChildInMultiSelect ||
                    hasMatchingChild;

                  return (
                    <tr
                      key={t.id}
                      data-txn-id={t.id}
                      className={cx(
                        "group y-row",
                        isChildRow && "y-subrow bg-slate-50/50 text-[11px]",
                        isSelected && "y-row--selected is-sel",
                        globalIndex % 2 === 1 && !isSelected && "alt"
                      )}
                      onClick={() => {
                        setSelectedId(null);
                        onEdit(t.parentId ?? t.id);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <td
                        style={{ width: 34, minWidth: 34, textAlign: "center", padding: "4px 6px" }}
                        className="text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select transaction ${t.payee || t.id}`}
                          checked={isChecked}
                          onChange={() => {}}
                          onClick={(e) => toggleRowSelect(t.id, e)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer align-middle inline-block"
                          style={{ verticalAlign: "middle", margin: "0 auto", display: "inline-block" }}
                        />
                      </td>
                      {hasFlagColumn && (
                        <td className="text-center" onClick={(e) => e.stopPropagation()}>
                          <FlagCell
                            color={t.flagColor ?? null}
                            onChange={(color) => onFlag(t.id, color)}
                            disabled={isReconciled}
                          />
                        </td>
                      )}
                      <td className={cx("y-num", isChildRow && "text-[11px]")} style={isChildRow ? { color: "var(--y-ink-soft)" } : undefined}>
                        {t.date}
                      </td>
                      {!accountFilter && (
                        <td className={cx("truncate", isChildRow && "text-[11px]")} style={{ color: "var(--y-ink-soft)" }}>
                          {accountById.get(t.accountId)?.name ?? ""}
                        </td>
                      )}
                      <td className={cx("truncate", isChildRow && "text-[11px]")} style={{ color: isChildRow ? "var(--y-ink-soft)" : "var(--y-ink)" }}>
                        {isChildRow ? (
                          <span className="inline-flex items-center">
                            <span className="text-gray-400 mr-1.5 pl-2 select-none font-normal">↳</span>
                            <span>{displayPayee}</span>
                          </span>
                        ) : (
                          <>
                            {isSplit && (
                              <button
                                type="button"
                                onClick={(e) => {
                                   e.stopPropagation();
                                   toggleExpandSplit(t.id);
                                }}
                                className="inline-flex items-center justify-center w-3.5 h-3.5 mr-1 text-[9px] text-gray-500 hover:text-gray-900 rounded hover:bg-gray-200 transition-colors align-middle"
                                aria-label={isExpanded ? "Collapse split sub-transactions" : "Expand split sub-transactions"}
                                title={isExpanded ? "Collapse split sub-transactions" : "Expand split sub-transactions"}
                              >
                                {isExpanded ? "▼" : "▶"}
                              </button>
                            )}
                            <span>{displayPayee}</span>
                          </>
                        )}
                      </td>
                      <td
                        className={cx("truncate", isChildRow && "text-[11px]")}
                        style={{
                          color: displayCat.startsWith("Split") ? "var(--y-blue)" : "var(--y-ink-soft)",
                        }}
                      >
                        {displayCat}
                      </td>
                      <td className={cx("truncate italic", isChildRow && "text-[11px]")} style={{ color: "var(--y-ink-faint)" }}>
                        {t.memo}
                      </td>
                      <td className="num y-num">{outflow ? money(outflow) : ""}</td>
                      <td
                        className="num y-num"
                        style={{
                          color: inflow ? "var(--y-green-dk)" : undefined,
                          fontWeight: inflow ? 700 : 400,
                        }}
                      >
                        {inflow ? money(inflow) : ""}
                      </td>
                      <td className="text-center" onClick={(e) => e.stopPropagation()}>
                        <ClearedFlag
                          state={effStatus}
                          onCycle={() => onCycleStatus(t.id)}
                          disabled={isReconciled}
                        />
                      </td>
                      <td
                        className="num y-num"
                        style={
                          t.runningBalance == null
                            ? { color: "var(--y-ink-faint)" }
                            : {
                                color:
                                  t.runningBalance < 0 ? "var(--y-red)" : "var(--y-ink)",
                                fontWeight: t.runningBalance < 0 ? 700 : 400,
                              }
                        }
                      >
                        {t.runningBalance == null ? "—" : money(t.runningBalance)}
                      </td>
                    </tr>
                  );
                })}
                {bottomHeight > 0 && (
                  <tr style={{ height: bottomHeight }}>
                    <td colSpan={colCount} style={{ height: bottomHeight, padding: 0, border: 0 }} />
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Register Footer Bar: Action Buttons */}
      <div className="y-register-footer">
        <div className="flex items-center gap-2">
          <Button onClick={onAdd} variant="primary" size="sm">
            <Icon name="plus" size={11} color="#fff" />
            <span className="ml-1 font-bold">Add a new transaction</span>
          </Button>

          {onAddTransfer && (
            <Button onClick={onAddTransfer} variant="default" size="sm">
              <Icon name="swap" size={11} color="var(--y-ink)" />
              <span className="ml-1">Make a transfer</span>
            </Button>
          )}

          <Button
            onClick={toggleScheduledDrawer}
            variant="default"
            size="sm"
            className="flex items-center gap-1.5"
            title={showScheduledDrawer ? "Hide Scheduled Transactions drawer" : "Show Scheduled Transactions drawer"}
          >
            <Icon name="calendar" size={12} />
            <span>Scheduled Transactions</span>
            {dueScheduledCount > 0 ? (
              <span className="y-badge ml-1" title={`${dueScheduledCount} due`}>
                {dueScheduledCount}
              </span>
            ) : scheduledRows.length > 0 ? (
              <span className="text-[10px] opacity-75 font-bold">({scheduledRows.length})</span>
            ) : null}
            <span className="text-[9px] ml-0.5">{showScheduledDrawer ? "▼" : "▲"}</span>
          </Button>
        </div>

        {filterAccount && (
          <Button
            variant="default"
            size="sm"
            onClick={() => onReconcile(filterAccount.id)}
            title="Reconcile this account against your bank statement"
            aria-label="Reconcile"
            className="font-semibold"
          >
            <Icon name="reconcile" size={11} color="var(--y-ink)" />
            <span className="ml-1">Reconcile</span>
          </Button>
        )}
      </div>

      {/* Scheduled Transactions Drawer (Bottom Table) */}
      {showScheduledDrawer && (
        <div className="y-scheduled-drawer">
          {/* Drawer Header Bar / Bulk Actions Bar */}
          <div className="y-scheduled-header">
            {selectedRecurringIds.size > 0 ? (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="y-caps font-bold" style={{ color: "var(--y-ink)" }}>
                  {selectedRecurringIds.size} scheduled selected
                </span>
                <div className="y-tb-sep mx-1" style={{ height: 14 }} />
                {onBulkDeleteRecurring && (
                  <Button
                    variant="danger"
                    size="sm"
                    className="!py-0.5 !px-2 text-[11px]"
                    onClick={async () => {
                      const ids = Array.from(selectedRecurringIds);
                      setSelectedRecurringIds(new Set());
                      await onBulkDeleteRecurring(ids);
                    }}
                  >
                    Delete ({selectedRecurringIds.size})
                  </Button>
                )}
                <Button
                  variant="default"
                  size="sm"
                  className="ml-auto !py-0.5 !px-2 text-[11px]"
                  onClick={() => setSelectedRecurringIds(new Set())}
                >
                  Deselect All
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-bold text-[var(--y-ink)]">
                  Scheduled Transactions
                </span>
                <span className="text-[11px] text-gray-500 font-medium">
                  ({scheduledRows.length} scheduled{dueScheduledCount > 0 ? ` · ${dueScheduledCount} due` : ""})
                </span>
              </div>
            )}

            <Button
              variant="default"
              size="sm"
              onClick={toggleScheduledDrawer}
              className="text-[11px] !py-0.5 !px-1.5 text-gray-500 ml-2"
              title="Close drawer"
            >
              <span>✕</span>
            </Button>
          </div>

          {/* Drawer Scheduled Table */}
          <div className="flex-1 overflow-y-auto overflow-x-auto y-scroll bg-white" style={{ background: "#ffffff" }}>
            <table className="y-table y-scheduled-table w-full text-left bg-white" style={{ background: "#ffffff" }}>
              <thead className="y-thead--sticky">
                <tr>
                  <th style={{ width: 34, minWidth: 34, textAlign: "center", padding: "4px 6px" }}>
                    <input
                      type="checkbox"
                      aria-label="Select all scheduled transactions"
                      checked={scheduledRows.length > 0 && selectedRecurringIds.size === scheduledRows.length}
                      onChange={() => {
                        if (selectedRecurringIds.size === scheduledRows.length) {
                          setSelectedRecurringIds(new Set());
                        } else {
                          setSelectedRecurringIds(new Set(scheduledRows.map((r) => r.id)));
                        }
                      }}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer align-middle"
                    />
                  </th>
                  {hasScheduledFlag && <th style={{ width: 32 }} className="text-center">Flag</th>}
                  <th style={{ width: 85 }}>Date</th>
                  <th style={{ width: 110 }}>Frequency</th>
                  {!accountFilter && <th style={{ width: 120 }}>Account</th>}
                  <th>Payee</th>
                  <th style={{ width: 170 }}>Category</th>
                  <th style={{ width: 150 }}>Memo</th>
                  <th className="num" style={{ width: 90 }}>
                    Outflow
                  </th>
                  <th className="num" style={{ width: 90 }}>
                    Inflow
                  </th>
                </tr>
              </thead>
              <tbody>
                {scheduledRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={scheduledColCount}
                      className="text-center py-8 text-[12px]"
                      style={{ color: "var(--y-ink-faint)", background: "#ffffff" }}
                    >
                      No scheduled transactions for {filterAccount ? filterAccount.name : "these accounts"}.
                    </td>
                  </tr>
                ) : (
                  scheduledRows.map((r, idx) => {
                    const isScheduledSelected = selectedRecurringIds.has(r.id);
                    const flavour = recurringFlavour(r, r.subTransactions ?? []);
                    const sourceName = accountById.get(r.accountId)?.name ?? "";
                    const destName =
                      flavour === "transfer" && r.transferAccountId != null
                        ? accountById.get(r.transferAccountId)?.name ?? ""
                        : "";
                    const children = r.subTransactions ?? [];
                    const displayAmt =
                      flavour === "split"
                        ? children.reduce((s, c) => s + num(c.amount), 0)
                        : num(r.amount);

                    const isIncomingTransfer = accountFilter != null && r.transferAccountId === accountFilter;
                    const effAmt = isIncomingTransfer ? -displayAmt : displayAmt;
                    const outflow = effAmt < 0 ? -effAmt : 0;
                    const inflow = effAmt > 0 ? effAmt : 0;

                    const isOverdue = r.active && r.nextDate < today;
                    const isDueToday = r.active && r.nextDate === today;
                    const isFuture = r.active && r.nextDate > today;

                    const displayPayee =
                      flavour === "transfer"
                        ? isIncomingTransfer
                          ? `Transfer : ${sourceName}`
                          : `Transfer : ${destName}`
                        : r.payee;

                    const catName = r.categoryId ? categoryById.get(r.categoryId)?.name ?? "" : "";
                    const displayCat =
                      flavour === "split"
                        ? `Split (${children.length} Categories)`
                        : flavour === "transfer"
                          ? "Transfer"
                          : catName;

                    return (
                      <tr
                        key={r.id}
                        className={cx(
                          "y-row hover:bg-blue-50/60 cursor-pointer",
                          isScheduledSelected && "y-row--selected is-sel",
                          idx % 2 === 1 && !isScheduledSelected && "alt"
                        )}
                        onClick={() => {
                          if (onEditRecurring) onEditRecurring(r.id);
                        }}
                      >
                        <td
                          style={{ width: 34, minWidth: 34, textAlign: "center", padding: "4px 6px" }}
                          className="text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select scheduled transaction ${r.payee || r.id}`}
                            checked={isScheduledSelected}
                            onChange={() => {}}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedRecurringIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.id)) next.delete(r.id);
                                else next.add(r.id);
                                return next;
                              });
                            }}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer align-middle"
                          />
                        </td>
                        {hasScheduledFlag && (
                          <td className="text-center" onClick={(e) => e.stopPropagation()}>
                            <FlagCell
                              color={r.flagColor ?? null}
                              onChange={(color) => onFlagRecurring?.(r.id, color)}
                            />
                          </td>
                        )}
                        <td className="y-num font-medium">
                          <span
                            style={{
                              color: isOverdue ? "var(--y-red)" : isDueToday ? "var(--y-orange-dk)" : undefined,
                              fontWeight: isOverdue || isDueToday ? 700 : 400,
                            }}
                          >
                            {r.nextDate}
                          </span>
                        </td>
                        <td className="truncate text-[11px]" style={{ color: "var(--y-ink-soft)" }}>
                          {frequencyLabel(r.frequency)}
                        </td>
                        {!accountFilter && (
                          <td className="truncate text-[11px]" style={{ color: "var(--y-ink-soft)" }}>
                            {sourceName}
                          </td>
                        )}
                        <td className="truncate font-medium" style={{ color: "var(--y-ink)" }}>
                          {displayPayee}
                        </td>
                        <td
                          className="truncate text-[11px]"
                          style={{
                            color: displayCat.startsWith("Split") ? "var(--y-blue)" : "var(--y-ink-soft)",
                          }}
                        >
                          {displayCat}
                        </td>
                        <td className="truncate italic text-[11px]" style={{ color: "var(--y-ink-faint)" }}>
                          {r.memo || (children.length > 0 ? children.map((c) => c.memo).filter(Boolean).join("; ") : "")}
                        </td>
                        <td className="num y-num">{outflow ? money(outflow) : ""}</td>
                        <td
                          className="num y-num"
                          style={{
                            color: inflow ? "var(--y-green-dk)" : undefined,
                            fontWeight: inflow ? 700 : 400,
                          }}
                        >
                          {inflow ? money(inflow) : ""}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Drawer Footer: Schedule Actions */}
          <div className="y-scheduled-footer">
            {onAddRecurring && (
              <Button onClick={onAddRecurring} variant="primary" size="sm">
                <Icon name="plus" size={11} color="#fff" />
                <span className="ml-1 font-bold">Schedule a new transaction</span>
              </Button>
            )}

            {onAddRecurringTransfer && (
              <Button onClick={onAddRecurringTransfer} variant="default" size="sm">
                <Icon name="swap" size={11} color="var(--y-ink)" />
                <span className="ml-1 font-medium">Schedule a transfer</span>
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
