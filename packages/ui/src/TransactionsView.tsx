"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetData, Transaction } from "@ynab/logic";
import { computeRunningBalances, num } from "@ynab/logic";
import { Icon, ClearedFlag, Toolbar, ToolbarSep, TextField, Button, money } from "@ynab/theme";

type Txn = Omit<Transaction, "amount"> & { amount: number; runningBalance: number };

const ROW_HEIGHT = 27;
const OVERSCAN = 15;

export function TransactionsView({
  data,
  accountFilter,
  onAdd,
  onEdit,
  onDelete,
  onReconcile,
  onCycleStatus,
  onBulkDelete,
  onBulkUpdate,
}: {
  data: BudgetData;
  accountFilter: number | null;
  onAdd: () => void;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
  onReconcile: (accountId: number) => void;
  onCycleStatus: (id: number) => void;
  onBulkDelete?: (ids: number[]) => Promise<void> | void;
  onBulkUpdate?: (ids: number[], patch: { status?: "u" | "c" | "r"; categoryId?: number | null }) => Promise<void> | void;
}) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

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
    const filtered = data.transactions.filter((t) => {
      if (accountFilter == null) return true;
      if (t.accountId === accountFilter) return true;
      if (t.transferAccountId != null && t.transferAccountId === accountFilter) return true;
      return false;
    });
    const sorted = filtered
      .map((t) => ({ ...t, amount: num(t.amount) }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return computeRunningBalances(sorted, accountBalances, accountFilter ?? undefined);
  }, [data.transactions, accountFilter, accountBalances]);

  const splitParentIds = useMemo(() => {
    const set = new Set<number>();
    for (const t of data.transactions) {
      if (t.parentId != null) set.add(t.parentId);
    }
    return set;
  }, [data.transactions]);

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    const isRowVisible = (r: Txn) => {
      // Top-level transactions are always shown.
      if (r.parentId == null) return true;
      // If we are viewing an account that is the DESTINATION of a transfer sub-transaction,
      // show it in this account register as an incoming transfer!
      if (accountFilter != null && r.transferAccountId === accountFilter) return true;
      // Otherwise, child rows on their parent's account are hidden in the register.
      return false;
    };
    const visibleRows = rows.filter(isRowVisible);
    if (!q) return visibleRows;

    const childrenByParent = new Map<number, Transaction[]>();
    for (const t of data.transactions) {
      if (t.parentId != null) {
        let list = childrenByParent.get(t.parentId);
        if (!list) {
          list = [];
          childrenByParent.set(t.parentId, list);
        }
        list.push(t);
      }
    }

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
  }, [rows, deferredSearch, data.transactions, categoryById, accountFilter, accountById]);

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

  // Virtualization window calculations
  const totalCount = filtered.length;
  // If containerHeight is 0 (e.g. during test runs or initial mount), render all rows or reasonable batch
  const isMeasured = containerHeight > 0;
  const startIndex = isMeasured
    ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    : 0;
  const endIndex = isMeasured
    ? Math.min(totalCount, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN)
    : totalCount;

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
    <div className="flex h-full flex-col">
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
        {filterAccount && (
          <Button
            variant="default"
            size="sm"
            onClick={() => onReconcile(filterAccount.id)}
            title="Reconcile this account against your bank statement"
          >
            <Icon name="reconcile" size={11} color="var(--y-ink)" />
            <span className="ml-1">Reconcile</span>
          </Button>
        )}
        <ToolbarSep />
        <TextField
          search
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search register"
          style={{ width: 168 }}
        />
        <Button onClick={onAdd} variant="primary" className="ml-auto">
          <Icon name="plus" size={11} color="#fff" /> Add Transaction
        </Button>
      </Toolbar>

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-800 text-[12px]">
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

      <div className="y-subbar flex items-center gap-3 px-3 py-1.5 text-[11px]">
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

      <div
        ref={containerRef}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        className="flex-1 min-h-0 overflow-auto y-scroll focus:outline-none"
      >
        <table className="y-table">
          <thead className="y-thead y-thead--sticky">
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
              <th style={{ width: 92 }}>Date</th>
              {!accountFilter && <th style={{ width: 130 }}>Account</th>}
              <th>Payee</th>
              <th style={{ width: 210 }}>Category</th>
              <th>Memo</th>
              <th className="num" style={{ width: 92 }}>
                Outflow
              </th>
              <th className="num" style={{ width: 92 }}>
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
                          color: t.runningBalance < 0
                            ? "var(--y-red)"
                            : "var(--y-ink)",
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
    </div>
  );
}
