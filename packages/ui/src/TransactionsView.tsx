"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetData, Transaction, TransactionFlagColor } from "@ynab/logic";
import {
  computeRunningBalances,
  frequencyLabel,
  num,
  recurringFlavour,
  todayISO,
} from "@ynab/logic";
import { Icon, ClearedFlag, FlagCell, Toolbar, ToolbarSep, TextField, Button, money, cx } from "@ynab/theme";

type Txn = Omit<Transaction, "amount"> & { amount: number; runningBalance: number };

const ROW_HEIGHT = 27;
const OVERSCAN = 15;

export const TransactionsView = memo(function TransactionsView({
  data,
  accountFilter,
  onAdd,
  onAddTransfer,
  onEdit,
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
}: {
  data: BudgetData;
  accountFilter: number | null;
  onAdd: () => void;
  onAddTransfer?: () => void;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
  onReconcile: (accountId: number) => void;
  onCycleStatus: (id: number) => void;
  onFlag: (id: number, color: TransactionFlagColor | null) => void;
  onBulkDelete?: (ids: number[]) => Promise<void> | void;
  onBulkUpdate?: (ids: number[], patch: { status?: "u" | "c" | "r"; categoryId?: number | null }) => Promise<void> | void;
  onAddRecurring?: () => void;
  onAddRecurringTransfer?: () => void;
  onEditRecurring?: (id: number) => void;
  onDeleteRecurring?: (id: number) => void;
  onPostRecurring?: (id: number, date?: string) => void;
}) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Scheduled drawer state
  const [showScheduledDrawer, setShowScheduledDrawer] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("ynab_show_scheduled_drawer");
      if (saved !== null) return saved === "true";
    }
    return true;
  });

  const toggleScheduledDrawer = () => {
    setShowScheduledDrawer((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("ynab_show_scheduled_drawer", String(next));
      } catch {}
      return next;
    });
  };

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
    const map = new Map<number, Transaction[]>();
    for (let i = 0; i < data.transactions.length; i++) {
      const t = data.transactions[i]!;
      if (t.parentId != null) {
        let list = map.get(t.parentId);
        if (!list) {
          list = [];
          map.set(t.parentId, list);
        }
        list.push(t);
      }
    }
    return map;
  }, [data.transactions]);

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    const isRowVisible = (r: Txn) => {
      if (r.parentId == null) return true;
      if (accountFilter != null && r.transferAccountId === accountFilter) return true;
      return false;
    };
    const visibleRows = rows.filter(isRowVisible);
    if (!q) return visibleRows;

    return visibleRows.filter((r) => {
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

  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    let count = 0;
    for (const r of filtered) {
      count++;
      const isIncoming = accountFilter != null && r.transferAccountId === accountFilter;
      const effAmt = isIncoming ? -r.amount : r.amount;
      if (effAmt > 0) inflow += effAmt;
      else outflow += -effAmt;
    }
    return { inflow, outflow, net: inflow - outflow, count };
  }, [filtered, accountFilter]);

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

  const allVisibleSelected =
    visibleRows.length > 0 && visibleRows.every((r) => selectedIds.has(r.id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const allSelected = visibleRows.length > 0 && visibleRows.every((r) => prev.has(r.id));
      if (allSelected) {
        return new Set();
      } else {
        const next = new Set(prev);
        for (const r of visibleRows) next.add(r.id);
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
        if (row) onEdit(row.parentId ?? row.id);
      } else if ((e.key === "c" || e.key === "C" || e.key === " ") && selectedId != null) {
        e.preventDefault();
        const row = filtered.find((r) => r.id === selectedId);
        if (row && row.status !== "r") onCycleStatus(row.id);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId != null) {
        e.preventDefault();
        onDelete(selectedId);
      }
    },
    [filtered, selectedId, onEdit, onCycleStatus, onDelete]
  );

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
              onClick={async () => {
                const ids = Array.from(selectedIds);
                setSelectedIds(new Set());
                if (onBulkUpdate) await onBulkUpdate(ids, { status: "c" });
                else for (const id of ids) onCycleStatus(id);
              }}
            >
              Mark Cleared
            </Button>
            <Button
              variant="default"
              size="sm"
              className="!py-0.5 !px-2 text-[11px]"
              onClick={async () => {
                const ids = Array.from(selectedIds);
                setSelectedIds(new Set());
                if (onBulkUpdate) await onBulkUpdate(ids, { status: "u" });
                else for (const id of ids) onCycleStatus(id);
              }}
            >
              Mark Uncleared
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
              <th style={{ width: 28, textAlign: "center", padding: "4px 0" }} className="text-center">
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
                <th style={{ width: 32 }} className="text-center" title="Flag">
                  F
                </th>
              )}
              <th style={{ width: 85 }}>Date</th>
              {!accountFilter && <th style={{ width: 120 }}>Account</th>}
              <th>Payee</th>
              <th style={{ width: 180 }}>Category</th>
              <th style={{ width: 160 }}>Memo</th>
              <th className="num" style={{ width: 95 }}>
                Outflow
              </th>
              <th className="num" style={{ width: 95 }}>
                Inflow
              </th>
              <th style={{ width: 32 }} className="text-center">
                C
              </th>
              <th className="num" style={{ width: 108 }}>
                Balance
              </th>
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
                  const outflow = effAmt < 0 ? -effAmt : 0;
                  const inflow = effAmt > 0 ? effAmt : 0;
                  const isSplit = splitParentIds.has(t.id);
                  const catName =
                    t.categoryId != null ? categoryById.get(t.categoryId)?.name ?? "" : "";
                  const displayCat = isSplit
                    ? "Split (Multiple Categories)"
                    : catName || (t.transferAccountId ? "Transfer" : "");
                  const displayPayee = isIncoming
                    ? `Transfer : ${accountById.get(t.accountId)?.name ?? "Unknown"}`
                    : t.payee;
                  return (
                    <tr
                      key={t.id}
                      className={cx("group y-row", isSelected && "y-row--selected is-sel", globalIndex % 2 === 1 && !isSelected && "alt")}
                      onClick={() => {
                        setSelectedId(t.id);
                        onEdit(t.parentId ?? t.id);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <td style={{ width: 28, textAlign: "center", padding: "4px 0" }} className="text-center" onClick={(e) => e.stopPropagation()}>
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
                            disabled={t.status === "r"}
                          />
                        </td>
                      )}
                      <td className="y-num">{t.date}</td>
                      {!accountFilter && (
                        <td className="truncate" style={{ color: "var(--y-ink-soft)" }}>
                          {accountById.get(t.accountId)?.name ?? ""}
                        </td>
                      )}
                      <td className="truncate" style={{ color: "var(--y-ink)" }}>
                        {displayPayee}
                      </td>
                      <td
                        className="truncate"
                        style={{
                          color: displayCat.startsWith("Split") ? "var(--y-blue)" : "var(--y-ink-soft)",
                        }}
                      >
                        {displayCat}
                      </td>
                      <td className="truncate italic" style={{ color: "var(--y-ink-faint)" }}>
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
                          state={t.status}
                          onCycle={() => onCycleStatus(t.id)}
                          disabled={t.status === "r"}
                        />
                      </td>
                      <td
                        className="num y-num"
                        style={{
                          color: t.runningBalance < 0 ? "var(--y-red)" : "var(--y-ink)",
                          fontWeight: t.runningBalance < 0 ? 700 : 400,
                        }}
                      >
                        {money(t.runningBalance)}
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
          {/* Drawer Header Bar */}
          <div className="y-scheduled-header">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-bold text-[var(--y-ink)]">
                Scheduled Transactions
              </span>
              <span className="text-[11px] text-gray-500 font-medium">
                ({scheduledRows.length} scheduled{dueScheduledCount > 0 ? ` · ${dueScheduledCount} due` : ""})
              </span>
            </div>

            <Button
              variant="default"
              size="sm"
              onClick={toggleScheduledDrawer}
              className="text-[11px] !py-0.5 !px-1.5 text-gray-500"
              title="Close drawer"
            >
              <span>✕</span>
            </Button>
          </div>

          {/* Drawer Scheduled Table */}
          <div className="flex-1 overflow-y-auto overflow-x-auto y-scroll bg-white" style={{ background: "#ffffff" }}>
            <table className="y-table y-scheduled-table w-full text-left bg-white" style={{ background: "#ffffff" }}>
              <thead>
                <tr>
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
                  <th style={{ width: 85 }} className="text-center">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {scheduledRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={accountFilter ? 8 : 9}
                      className="text-center py-8 text-[12px]"
                      style={{ color: "var(--y-ink-faint)", background: "#ffffff" }}
                    >
                      No scheduled transactions for {filterAccount ? filterAccount.name : "these accounts"}.
                    </td>
                  </tr>
                ) : (
                  scheduledRows.map((r, idx) => {
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
                          idx % 2 === 1 && "alt"
                        )}
                        onClick={() => {
                          if (onEditRecurring) onEditRecurring(r.id);
                        }}
                      >
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
                          {children.length > 0 ? children.map((c) => c.memo).filter(Boolean).join("; ") : ""}
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
                          <Button
                            size="sm"
                            variant="default"
                            className="text-[11px] !py-0.5 !px-2 font-medium"
                            title={isFuture ? `Enter early into register as of today (${today})` : "Enter into register"}
                            onClick={() => {
                              if (onPostRecurring) {
                                if (isFuture) {
                                  onPostRecurring(r.id, today);
                                } else {
                                  onPostRecurring(r.id);
                                }
                              }
                            }}
                          >
                            Enter Now
                          </Button>
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
