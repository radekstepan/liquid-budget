"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetData, BulkUpdateTransactionPatch, MergeableTransaction, MergeOverrides, Query, Transaction, TransactionFlagColor } from "@ynab/logic";
import {
  applyQuery,
  buildSearchCtx,
  computeRunningBalances,
  filterId,
  filterLabel,
  frequencyLabel,
  num,
  pickMergePrimary,
  recurringFlavour,
} from "@ynab/logic";
import { Icon, ClearedFlag, FlagCell, Toolbar, ToolbarSep, Button, Tooltip, money, cx, type SearchListOption } from "@ynab/theme";
import { useLocalStorage } from "./useLocalStorage.js";
import { useTodayISO } from "./useTodayISO.js";
import { MergePreviewModal } from "./MergePreviewModal.js";

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
      <Tooltip tip={title ?? `Sort by ${label}`} side="bottom">
        <button
          type="button"
          className="y-sort-btn"
          onClick={() => onSort(sortKey)}
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
      </Tooltip>
    </th>
  );
}

const ROW_HEIGHT = 27;
const OVERSCAN = 15;

export const SCHEDULED_HEIGHT_STORAGE_KEY = "ynab:transactions:scheduledHeight";
const MIN_SCHEDULED_HEIGHT = 120;
const MAX_SCHEDULED_HEIGHT = 720;

export function isScheduledHeights(v: unknown): v is Record<string, number> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every(
      (x) =>
        typeof x === "number" &&
        Number.isFinite(x) &&
        x >= MIN_SCHEDULED_HEIGHT &&
        x <= MAX_SCHEDULED_HEIGHT
    )
  );
}

const clampScheduledHeight = (h: number) =>
  Math.min(MAX_SCHEDULED_HEIGHT, Math.max(MIN_SCHEDULED_HEIGHT, Math.round(h)));

function RegisterEmptyState({
  hasTransactions,
  hasSearch,
  hasExternalFilter,
  accountName,
  onAdd,
  onClearSearch,
  onClearFilter,
}: {
  hasTransactions: boolean;
  hasSearch: boolean;
  hasExternalFilter: boolean;
  accountName?: string;
  onAdd: () => void;
  onClearSearch: () => void;
  onClearFilter: () => void;
}) {
  const title = !hasTransactions
    ? "No transactions yet"
    : hasSearch
      ? "No transactions match your search"
      : hasExternalFilter
        ? "No transactions match this filter"
        : accountName
          ? `No transactions in ${accountName} yet`
          : "No transactions here yet";
  const hint = !hasTransactions
    ? "Record your first transaction below — every budget starts with one entry."
    : hasSearch || hasExternalFilter
      ? "Try widening the search, or clear it to see everything again."
      : "Add one to get this account moving.";
  return (
    <div
      className="mx-auto flex max-w-[420px] flex-col items-center gap-2"
      data-testid="register-empty-state"
    >
      <div className="text-[13px] font-semibold" style={{ color: "var(--y-ink)" }}>
        {title}
      </div>
      <p className="y-hint text-[12px] leading-relaxed">{hint}</p>
      <div className="mt-1 flex items-center justify-center gap-2">
        {(hasSearch || hasExternalFilter) && (
          <Button
            size="sm"
            onClick={hasSearch ? onClearSearch : onClearFilter}
          >
            Clear {hasSearch ? "search" : "filter"}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={onAdd}>
          Add transaction
        </Button>
      </div>
    </div>
  );
}

export const TransactionsView = memo(function TransactionsView({
  data,
  accountFilter,
  focusTransaction,
  externalFilter,
  onGoToTransfer,
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
  onMergeTransactions,
  payees,
  onAddRecurring,
  onAddRecurringTransfer,
  onEditRecurring,
  onDeleteRecurring,
  onPostRecurring,
  onFlagRecurring,
  onBulkPostRecurring,
  onBulkUpdateRecurring,
  onBulkDeleteRecurring,
  onEditFilter,
  onClearFilter,
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
  onGoToTransfer?: (accountId: number, transactionId: number) => void;
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
  onMergeTransactions?: (ids: number[], overrides?: MergeOverrides) => Promise<void> | void;
  /** Existing payee names for the searchable payee field in the merge preview. */
  payees?: SearchListOption[];
  onAddRecurring?: () => void;
  onAddRecurringTransfer?: () => void;
  onEditRecurring?: (id: number) => void;
  onDeleteRecurring?: (id: number) => void;
  onPostRecurring?: (id: number, date?: string) => void;
  onFlagRecurring?: (id: number, color: TransactionFlagColor | null) => void;
  onBulkPostRecurring?: (ids: number[], date?: string) => Promise<void> | void;
  onBulkUpdateRecurring?: (ids: number[], patch: { flagColor?: TransactionFlagColor | null; active?: boolean }) => Promise<void> | void;
  onBulkDeleteRecurring?: (ids: number[]) => Promise<void> | void;
  /** Open the search modal pre-filled with `query` so the filter can be edited. */
  onEditFilter?: (query: Query) => void;
  /** Notify the owner that the applied filter was cleared so stale external
      filters can't re-apply on remount (e.g. after navigating away and back). */
  onClearFilter?: () => void;
}) {
  // Structured search applied from the global search modal (chips + text).
  // This is the single source of truth for register narrowing, rendered as
  // chips in the toolbar; the modal is the only place it gets edited.
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
    [data.transactions, onMergeTransactions]
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [mergePreviewIds, setMergePreviewIds] = useState<number[] | null>(null);
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
            <Tooltip tip="This account is closed. Reopen it to add new transactions.">
              <span
                className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded border"
                style={{
                  backgroundColor: "var(--y-gray-100, #f1f5f9)",
                  borderColor: "var(--y-gray-300, #cbd5e1)",
                  color: "var(--y-ink-soft, #64748b)",
                }}
              >
                Closed
              </span>
            </Tooltip>
          )}
          {filterAccount?.notes ? (
            <Tooltip tip={filterAccount.notes}>
              <span
                className="text-[11px] truncate max-w-[320px]"
                style={{ color: "var(--y-ink-soft, #64748b)" }}
              >
                {filterAccount.notes}
              </span>
            </Tooltip>
          ) : null}
        </div>
        <ToolbarSep />
        {appliedQuery != null &&
        (appliedQuery.filters.length > 0 || appliedQuery.text.trim().length > 0) ? (
          <div
            data-testid="register-filter-bar"
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
          >
            {appliedQuery.filters.map((f, i) => {
              const { key, value } = filterLabel(f);
              return (
                <span key={`${filterId(f)}:${i}`} className="y-chip shrink-0">
                  <Tooltip tip={`Edit ${key} filter`} className="flex h-full">
                    <button
                      type="button"
                      onClick={() => appliedQuery && onEditFilter?.(appliedQuery)}
                      className="y-chip-edit"
                      aria-label={`Edit ${key} filter`}
                    >
                      <span className="y-chip-key">{key}</span>
                      <span className="y-chip-val">{value}</span>
                    </button>
                  </Tooltip>
                  <Tooltip tip={`Remove ${key} filter`} className="flex h-full">
                    <button
                      type="button"
                      onClick={() => removeAppliedFilterChip(i)}
                      className="y-chip-x"
                      aria-label={`Remove ${key} filter`}
                    >
                      <Icon name="x" size={10} />
                    </button>
                  </Tooltip>
                </span>
              );
            })}
            {appliedQuery.text.trim().length > 0 && (
              <span className="y-chip shrink-0">
                <Tooltip tip="Edit search text filter" className="flex h-full">
                  <button
                    type="button"
                    onClick={() => appliedQuery && onEditFilter?.(appliedQuery)}
                    className="y-chip-edit"
                    aria-label="Edit search text filter"
                  >
                    <span className="y-chip-key">Search</span>
                    <span className="y-chip-val">“{appliedQuery.text.trim()}”</span>
                  </button>
                </Tooltip>
                <Tooltip tip="Remove search text filter" className="flex h-full">
                  <button
                    type="button"
                    onClick={removeAppliedTextChip}
                    className="y-chip-x"
                    aria-label="Remove search text filter"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </Tooltip>
              </span>
            )}
            <button
              type="button"
              className="y-btn y-btn--sm shrink-0"
              onClick={clearAppliedQuery}
            >
              Clear
            </button>
          </div>
        ) : (
          <Tooltip tip="Filter transactions (⌘K)">
            <button
              type="button"
              className="y-btn y-btn--sm"
              aria-label="Filter transactions"
              onClick={() => onEditFilter?.({ filters: [], text: "" })}
            >
              <span className="inline-flex items-center gap-1.5">
                <Icon name="search" size={12} />
                Filter
              </span>
            </button>
          </Tooltip>
        )}
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
            {selectedIds.size === 2 && onMergeTransactions && (
              <Tooltip tip="Merge the two selected transactions into one (imported data wins)">
                <Button
                  variant="default"
                  size="sm"
                  className="!py-0.5 !px-2 text-[11px]"
                  onClick={() => setMergePreviewIds(Array.from(selectedIds))}
                >
                  Merge (2)
                </Button>
              </Tooltip>
            )}
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
                <td colSpan={colCount} className="text-center" style={{ padding: "28px 12px" }}>
                  <RegisterEmptyState
                    hasTransactions={data.transactions.length > 0}
                    hasSearch={appliedQuery != null}
                    hasExternalFilter={externalFilter != null}
                    accountName={accountFilter != null ? accountById.get(accountFilter)?.name : undefined}
                    onAdd={onAdd}
                    onClearSearch={clearAppliedQuery}
                    onClearFilter={() => onClearFilter?.()}
                  />
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
                  const isIncoming = accountFilter != null && t.transferAccountId === accountFilter;
                  const isChildRow = t.parentId != null && !isIncoming;
                  // Sub-rows are display-only: no checkbox, no highlight, even
                  // if a stale id lingers in selection state.
                  const isSelected = !isChildRow && (t.id === selectedId || selectedIds.has(t.id));
                  const isChecked = !isChildRow && selectedIds.has(t.id);
                  const effAmt = isIncoming ? -t.amount : t.amount;
                  const effStatus = isIncoming ? (t.transferStatus ?? t.status) : t.status;
                  const isReconciled = effStatus === "r";
                  // Unreviewed imports/posts show "N" (New) in the C column
                  // until approved, alongside the bold row. Reconciled rows
                  // are never unreviewed, but keep R authoritative anyway.
                  const showNew = !isChildRow && t.needsReview === true && !isReconciled;
                  const outflow = effAmt < 0 ? -effAmt : 0;
                  const inflow = effAmt > 0 ? effAmt : 0;
                  const isSplit = splitParentIds.has(t.id);
                  const isTransfer = t.transferAccountId != null && !isSplit;
                  const otherAccountId = isTransfer
                    ? accountFilter != null && t.transferAccountId === accountFilter
                      ? t.accountId
                      : t.transferAccountId
                    : null;
                  const otherAccount = otherAccountId != null ? accountById.get(otherAccountId) : null;
                  const otherAccountName = otherAccount?.name ?? "Account";
                  const catName =
                    t.categoryId != null ? categoryById.get(t.categoryId)?.name ?? "" : "";
                  const displayPayee = isIncoming
                    ? `Transfer : ${accountById.get(t.accountId)?.name ?? "Unknown"}`
                    : isChildRow && t.transferAccountId != null
                      ? `Transfer : ${accountById.get(t.transferAccountId)?.name ?? "Unknown"}`
                      : t.payee;

                  const children = childrenByParent.get(t.id);
                  const hasMatchingChild =
                    queryIdSet != null &&
                    (children?.some((c) => queryIdSet.has(c.id)) ?? false);
                  const isParentSelected = selectedId === t.id || selectedIds.has(t.id);
                  const isExpanded =
                    expandedSplitIds.has(t.id) ||
                    isParentSelected ||
                    hasMatchingChild;

                  return (
                    <tr
                      key={t.id}
                      data-txn-id={t.id}
                      className={cx(
                        "group y-row",
                        isChildRow && "y-subrow bg-slate-50/50 text-[11px]",
                        // Freshly imported rows render bold until reviewed,
                        // matching YNAB4's unapproved-import look.
                        !isChildRow && t.needsReview && "font-bold",
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
                        onClick={(e) => {
                          if (!isChildRow) toggleRowSelect(t.id, e);
                          else e.stopPropagation();
                        }}
                      >
                        {!isChildRow && (
                          <input
                            type="checkbox"
                            aria-label={`Select transaction ${t.payee || t.id}`}
                            checked={isChecked}
                            onChange={() => {}}
                            onClick={(e) => toggleRowSelect(t.id, e)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer align-middle inline-block"
                            style={{ verticalAlign: "middle", margin: "0 auto", display: "inline-block" }}
                          />
                        )}
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
                              <Tooltip
                                tip={isExpanded ? "Collapse split sub-transactions" : "Expand split sub-transactions"}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                     e.stopPropagation();
                                     toggleExpandSplit(t.id);
                                  }}
                                  className="inline-flex items-center justify-center w-3.5 h-3.5 mr-1 text-[9px] text-gray-500 hover:text-gray-900 rounded hover:bg-gray-200 transition-colors cursor-pointer align-middle"
                                  aria-label={isExpanded ? "Collapse split sub-transactions" : "Expand split sub-transactions"}
                                >
                                  {isExpanded ? "▼" : "▶"}
                                </button>
                              </Tooltip>
                            )}
                            <span>{displayPayee}</span>
                          </>
                        )}
                      </td>
                      <td
                        className={cx("truncate", isChildRow && "text-[11px]")}
                        style={{
                          color: isSplit || isTransfer ? "var(--y-blue)" : "var(--y-ink-soft)",
                        }}
                      >
                        {isSplit ? (
                          "Split (Multiple Categories)"
                        ) : isTransfer && otherAccountId != null ? (
                          <Tooltip tip={`Go to transfer in ${otherAccountName}`}>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onGoToTransfer?.(otherAccountId, t.id);
                              }}
                              className="inline-flex items-center gap-1 px-1 py-0.5 rounded hover:bg-blue-50/80 transition-colors cursor-pointer align-middle"
                              style={{ color: "var(--y-blue)" }}
                              aria-label={`Go to transfer in ${otherAccountName}`}
                            >
                              <Icon name="swap" size={11} color="currentColor" />
                              {catName ? <span className="truncate">{catName}</span> : null}
                            </button>
                          </Tooltip>
                        ) : (
                          catName
                        )}
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
                          state={showNew ? "n" : effStatus}
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
          <Tooltip
            tip={filterAccount?.archived ? "Reopen this account to add transactions." : undefined}
            side="bottom"
          >
            <Button onClick={onAdd} variant="primary" size="sm" disabled={filterAccount?.archived}>
              <Icon name="plus" size={11} color="#fff" />
              <span className="ml-1 font-bold">Add a new transaction</span>
            </Button>
          </Tooltip>

          {onAddTransfer && (
            <Tooltip
              tip={filterAccount?.archived ? "Reopen this account to add transactions." : undefined}
              side="bottom"
            >
              <Button onClick={onAddTransfer} variant="default" size="sm" disabled={filterAccount?.archived}>
                <Icon name="swap" size={11} color="var(--y-ink)" />
                <span className="ml-1">Make a transfer</span>
              </Button>
            </Tooltip>
          )}

          <Tooltip tip={showScheduledDrawer ? "Hide Scheduled Transactions drawer" : "Show Scheduled Transactions drawer"} side="bottom">
            <Button
              onClick={toggleScheduledDrawer}
              variant="default"
              size="sm"
              className="flex items-center gap-1.5"
              aria-label={showScheduledDrawer ? "Hide Scheduled Transactions drawer" : "Show Scheduled Transactions drawer"}
            >
              <Icon name="calendar" size={12} />
              <span>Scheduled Transactions</span>
              {dueScheduledCount > 0 ? (
                <Tooltip tip={`${dueScheduledCount} due`}>
                  <span className="y-badge ml-1">
                    {dueScheduledCount}
                  </span>
                </Tooltip>
              ) : scheduledRows.length > 0 ? (
              <span className="text-[10px] opacity-75 font-bold">({scheduledRows.length})</span>
            ) : null}
            <span className="text-[9px] ml-0.5">{showScheduledDrawer ? "▼" : "▲"}</span>
            </Button>
          </Tooltip>
        </div>

        {filterAccount && (
          <Tooltip tip="Reconcile this account against your bank statement" side="bottom">
            <Button
              variant="default"
              size="sm"
              onClick={() => onReconcile(filterAccount.id)}
              aria-label="Reconcile"
              className="font-semibold"
            >
              <Icon name="reconcile" size={11} color="var(--y-ink)" />
            <span className="ml-1">Reconcile</span>
            </Button>
          </Tooltip>
        )}
      </div>

      {/* Scheduled Transactions Drawer (Bottom Table) */}
      {showScheduledDrawer && (
        <div
          ref={drawerRef}
          className="y-scheduled-drawer"
          style={
            scheduledHeight != null
              ? {
                  height: scheduledHeight,
                  minHeight: MIN_SCHEDULED_HEIGHT,
                  maxHeight: "75%",
                }
              : undefined
          }
        >
          {/* Horizontal Drag Resize Handle on the Top Edge */}
          <div
            onMouseDown={startScheduledResizing}
            onDoubleClick={resetScheduledHeight}
            className="y-scheduled-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize scheduled transactions"
          />
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

            <Tooltip tip="Close drawer">
              <Button
                variant="default"
                size="sm"
                onClick={toggleScheduledDrawer}
                className="text-[11px] !py-0.5 !px-1.5 text-gray-500 ml-2"
                aria-label="Close drawer"
              >
                <span>✕</span>
              </Button>
            </Tooltip>
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
                      className="text-center text-[12px]"
                      style={{ color: "var(--y-ink-faint)", background: "#ffffff", padding: "24px 12px" }}
                    >
                      <div className="mx-auto flex max-w-[420px] flex-col items-center gap-1.5">
                        <div className="font-semibold" style={{ color: "var(--y-ink-soft)" }}>
                          Nothing scheduled for {filterAccount ? filterAccount.name : "these accounts"}
                        </div>
                        <p className="y-hint leading-relaxed">
                          Put bills and paychecks on autopilot — they post themselves on the right date.
                        </p>
                        {onAddRecurring && (
                          <Button size="sm" onClick={onAddRecurring} className="mt-1">
                            Schedule one
                          </Button>
                        )}
                      </div>
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

                    const isDue = r.active && r.nextDate <= today;
                    return (
                      <tr
                        key={r.id}
                        className={cx(
                          "y-row hover:bg-blue-50/60 cursor-pointer",
                          // Due scheduled rows render bold like unreviewed
                          // imports: both mean "new" and share one count.
                          isDue && "font-bold",
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
                          onClick={(e) => toggleRecurringRowSelect(r.id, e)}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select scheduled transaction ${r.payee || r.id}`}
                            checked={isScheduledSelected}
                            onChange={() => {}}
                            onClick={(e) => toggleRecurringRowSelect(r.id, e)}
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
                            color:
                              displayCat.startsWith("Split") || flavour === "transfer"
                                ? "var(--y-blue)"
                                : "var(--y-ink-soft)",
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

      {mergePreviewIds != null &&
        mergePreviewIds.length === 2 &&
        mergePreviewIds.every((id) => data.transactions.some((t) => t.id === id)) &&
        onMergeTransactions && (
          <MergePreviewModal
            accounts={data.accounts}
            categories={data.categories}
            groups={data.groups}
            payees={payees}
            transactions={data.transactions}
            ids={mergePreviewIds}
            onClose={() => setMergePreviewIds(null)}
            onConfirm={confirmMergePreview}
          />
        )}
    </div>
  );
});
