"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetData, Recurring, RecurringSubTransaction, Transaction } from "@ynab/logic";
import {
  computeRunningBalances,
  fmt,
  frequencyLabel,
  num,
  recurringFlavour,
  todayISO,
} from "@ynab/logic";
import { Icon, ClearedFlag, Toolbar, ToolbarSep, TextField, Button, money, Pill, cx } from "@ynab/theme";

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

  const [selectedScheduledIds, setSelectedScheduledIds] = useState<Set<number>>(new Set());
  const [editMenuOpen, setEditMenuOpen] = useState(false);
  const editMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (editMenuRef.current && !editMenuRef.current.contains(e.target as Node)) {
        setEditMenuOpen(false);
      }
    };
    if (editMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [editMenuOpen]);

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
    const filtered: (Omit<Transaction, "amount"> & { amount: number })[] = [];
    const len = data.transactions.length;
    for (let i = 0; i < len; i++) {
      const t = data.transactions[i]!;
      if (
        accountFilter == null ||
        t.accountId === accountFilter ||
        (t.transferAccountId != null && t.transferAccountId === accountFilter)
      ) {
        filtered.push({ ...t, amount: num(t.amount) });
      }
    }
    filtered.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    return computeRunningBalances(filtered, accountBalances, accountFilter ?? undefined);
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
  const colCount = (accountFilter ? 8 : 9) + 1;

  // Scheduled transactions for the active account / view
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

  // Balance Math Bar (Cleared + Uncleared = Working Balance)
  const balanceMath = useMemo(() => {
    let working = 0;
    let uncleared = 0;

    if (accountFilter != null && filterAccount) {
      working = num(filterAccount.balance);
      const accTxns = rows;
      for (const t of accTxns) {
        if (t.status === "u") {
          const isIncoming = t.transferAccountId === accountFilter;
          const effAmt = isIncoming ? -t.amount : t.amount;
          uncleared += effAmt;
        }
      }
    } else {
      const activeBudgetAccs = data.accounts.filter((a) => !a.archived && a.onBudget);
      working = activeBudgetAccs.reduce((s, a) => s + num(a.balance), 0);
      for (const t of rows) {
        if (t.status === "u") {
          const srcAcc = accountById.get(t.accountId);
          if (srcAcc?.onBudget) {
            uncleared += t.amount;
          }
        }
      }
    }

    const cleared = working - uncleared;
    return { cleared, uncleared, working };
  }, [accountFilter, filterAccount, rows, data.accounts, accountById]);

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

  const toggleScheduledRowSelect = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedScheduledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllScheduledSelect = () => {
    setSelectedScheduledIds((prev) => {
      if (prev.size === scheduledRows.length) return new Set();
      return new Set(scheduledRows.map((r) => r.id));
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
    <div className="flex h-full flex-col overflow-hidden" onKeyDown={handleKeyDown} tabIndex={0}>
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
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={onAdd} variant="primary">
            <Icon name="plus" size={11} color="#fff" /> Add Transaction
          </Button>
        </div>
      </Toolbar>

      {/* Multi-Selection Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-800 text-[12px] flex-shrink-0">
          <span className="font-semibold text-blue-900 dark:text-blue-200">
            {selectedIds.size} selected
          </span>
          <div className="h-4 w-px bg-blue-300 dark:bg-blue-700 mx-1" />
          <Button
            variant="default"
            size="sm"
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
            className="ml-auto"
            onClick={() => setSelectedIds(new Set())}
          >
            Deselect All
          </Button>
        </div>
      )}

      {/* Register Summary Strip */}
      <div className="y-subbar flex items-center gap-3 px-3 py-1.5 text-[11px] flex-shrink-0">
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
      </div>

      {/* Main Register Table View */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-auto y-scroll"
        style={{ minHeight: 120 }}
      >
        <table className="y-table w-full text-left">
          <thead className="y-thead--sticky">
            <tr>
              <th style={{ width: 28 }} className="text-center">
                <input
                  type="checkbox"
                  aria-label="Select all transactions"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                />
              </th>
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
                      className={`group y-row ${isSelected ? "y-row--selected bg-[#eff6ff] dark:bg-[#1e293b]" : globalIndex % 2 === 1 ? "alt" : ""}`}
                      onClick={() => {
                        setSelectedId(t.id);
                        onEdit(t.parentId ?? t.id);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <td className="text-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select transaction ${t.payee || t.id}`}
                          checked={isChecked}
                          onChange={() => {}}
                          onClick={(e) => toggleRowSelect(t.id, e)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        />
                      </td>
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

      {/* YNAB4 Register Footer Bar: Action Buttons & Balance Math Strip */}
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
            variant={showScheduledDrawer ? "blue" : "default"}
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

        {/* Right Balance Box & Reconcile */}
        <div className="flex items-center gap-3">
          <div className="y-working-balance-box">
            <div className="y-working-balance-cell">
              <span className="y-working-balance-label">Cleared Balance</span>
              <span
                className="y-working-balance-val"
                style={{ color: balanceMath.cleared < 0 ? "var(--y-red)" : undefined }}
              >
                {fmt(balanceMath.cleared)}
              </span>
            </div>
            <span className="y-working-balance-op">+</span>
            <div className="y-working-balance-cell">
              <span className="y-working-balance-label">Uncleared Transactions</span>
              <span
                className="y-working-balance-val"
                style={{ color: balanceMath.uncleared < 0 ? "var(--y-red)" : undefined }}
              >
                {fmt(balanceMath.uncleared)}
              </span>
            </div>
            <span className="y-working-balance-op">=</span>
            <div className="y-working-balance-cell bg-slate-50 dark:bg-slate-900/50 rounded-r">
              <span className="y-working-balance-label font-bold">Working Balance</span>
              <span
                className="y-working-balance-val font-bold"
                style={{ color: balanceMath.working < 0 ? "var(--y-red)" : undefined }}
              >
                {fmt(balanceMath.working)}
              </span>
            </div>
          </div>

          {filterAccount && (
            <Button
              variant="default"
              size="sm"
              onClick={() => onReconcile(filterAccount.id)}
              title="Reconcile this account against your bank statement"
              className="font-semibold"
            >
              <Icon name="reconcile" size={11} color="var(--y-ink)" />
              <span className="ml-1">Reconcile Account</span>
            </Button>
          )}
        </div>
      </div>

      {/* YNAB4 Scheduled Transactions Drawer (Bottom Table) */}
      {showScheduledDrawer && (
        <div className="y-scheduled-drawer">
          {/* Top Divider / Collapse Toggle */}
          <div
            onClick={toggleScheduledDrawer}
            className="y-scheduled-divider-toggle"
            title="Click to collapse scheduled transactions"
          >
            <span>▼</span>
          </div>

          {/* Drawer Header Bar */}
          <div className="y-scheduled-header">
            {/* Edit Transactions Dropdown / Actions */}
            <div className="relative" ref={editMenuRef}>
              <Button
                variant="default"
                size="sm"
                onClick={() => setEditMenuOpen((o) => !o)}
                className="flex items-center gap-1 text-[11px]"
              >
                <span>Edit Transactions</span>
                <span className="text-[9px]">▼</span>
              </Button>

              {editMenuOpen && (
                <div className="y-menu absolute left-0 top-full mt-1 z-50 min-w-[180px] shadow-lg rounded bg-white border border-gray-300 py-1">
                  <button
                    className="y-menu-item"
                    disabled={selectedScheduledIds.size === 0}
                    onClick={() => {
                      setEditMenuOpen(false);
                      if (onPostRecurring) {
                        for (const id of selectedScheduledIds) {
                          onPostRecurring(id, today);
                        }
                      }
                      setSelectedScheduledIds(new Set());
                    }}
                  >
                    <Icon name="clock" size={12} />
                    <span>Enter into Register Now</span>
                  </button>

                  <button
                    className="y-menu-item"
                    disabled={selectedScheduledIds.size !== 1}
                    onClick={() => {
                      setEditMenuOpen(false);
                      const id = Array.from(selectedScheduledIds)[0];
                      if (id && onEditRecurring) onEditRecurring(id);
                    }}
                  >
                    <Icon name="edit" size={12} />
                    <span>Edit Scheduled Rule</span>
                  </button>

                  <button
                    className="y-menu-item text-red-600 hover:bg-red-50"
                    disabled={selectedScheduledIds.size === 0}
                    onClick={() => {
                      setEditMenuOpen(false);
                      if (onDeleteRecurring) {
                        for (const id of selectedScheduledIds) {
                          onDeleteRecurring(id);
                        }
                      }
                      setSelectedScheduledIds(new Set());
                    }}
                  >
                    <Icon name="trash" size={12} />
                    <span>Delete ({selectedScheduledIds.size})</span>
                  </button>
                </div>
              )}
            </div>

            {/* Centered Capsule Title */}
            <div className="absolute left-1/2 transform -translate-x-1/2">
              <span className="y-scheduled-pill">Scheduled Transactions</span>
            </div>

            {/* Summary Count on Right */}
            <div className="text-[11px] text-gray-500 font-medium">
              {scheduledRows.length} scheduled
              {dueScheduledCount > 0 && ` · ${dueScheduledCount} due`}
            </div>
          </div>

          {/* Drawer Scheduled Table */}
          <div className="flex-1 overflow-y-auto overflow-x-auto y-scroll bg-white">
            <table className="y-table y-scheduled-table w-full text-left">
              <thead>
                <tr>
                  <th style={{ width: 28 }} className="text-center">
                    <input
                      type="checkbox"
                      aria-label="Select all scheduled transactions"
                      checked={scheduledRows.length > 0 && selectedScheduledIds.size === scheduledRows.length}
                      onChange={toggleAllScheduledSelect}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                  </th>
                  <th style={{ width: 30 }} className="text-center">
                    Flag
                  </th>
                  <th style={{ width: 85 }}>Date ▲</th>
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
                    <td colSpan={colCount + 2} className="text-center py-6 y-hint text-[12px]">
                      No scheduled transactions for {filterAccount ? filterAccount.name : "these accounts"}.
                    </td>
                  </tr>
                ) : (
                  scheduledRows.map((r, idx) => {
                    const isSelected = selectedScheduledIds.has(r.id);
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
                          isSelected && "y-row--selected bg-[#eff6ff]",
                          idx % 2 === 1 && !isSelected && "alt"
                        )}
                        onClick={() => {
                          if (onEditRecurring) onEditRecurring(r.id);
                        }}
                      >
                        <td className="text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select scheduled ${r.payee || r.id}`}
                            checked={isSelected}
                            onChange={() => {}}
                            onClick={(e) => toggleScheduledRowSelect(r.id, e)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                          />
                        </td>
                        <td className="text-center" onClick={(e) => e.stopPropagation()}>
                          {isOverdue ? (
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full bg-red-600"
                              title="Overdue"
                            />
                          ) : isDueToday ? (
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500"
                              title="Due Today"
                            />
                          ) : !r.active ? (
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full bg-gray-400"
                              title="Paused"
                            />
                          ) : (
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full bg-green-500"
                              title="Active"
                            />
                          )}
                        </td>
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
                            variant="blue"
                            className="text-[10px] !py-0.5 !px-2 font-bold"
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
