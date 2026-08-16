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
}: {
  data: BudgetData;
  accountFilter: number | null;
  onAdd: () => void;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
  onReconcile: (accountId: number) => void;
  onCycleStatus: (id: number) => void;
}) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

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

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    if (!q) return rows;

    const matchingParentIds = new Set<number>();
    for (const r of rows) {
      if (r.parentId != null) continue;
      const catName = (r.categoryId != null ? categoryById.get(r.categoryId)?.name : "") ?? "";
      if (
        r.payee.toLowerCase().includes(q) ||
        catName.toLowerCase().includes(q) ||
        (r.memo ?? "").toLowerCase().includes(q)
      ) {
        matchingParentIds.add(r.id);
      }
    }

    return rows.filter((r) => {
      if (r.parentId != null) {
        if (matchingParentIds.has(r.parentId)) return true;
        const catName = (r.categoryId != null ? categoryById.get(r.categoryId)?.name : "") ?? "";
        return (
          r.payee.toLowerCase().includes(q) ||
          catName.toLowerCase().includes(q) ||
          (r.memo ?? "").toLowerCase().includes(q)
        );
      }
      return matchingParentIds.has(r.id);
    });
  }, [rows, deferredSearch, categoryById]);

  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    let count = 0;
    for (const r of filtered) {
      if (r.parentId != null) continue;
      count++;
      if (r.amount > 0) inflow += r.amount;
      else outflow += -r.amount;
    }
    return { inflow, outflow, net: inflow - outflow, count };
  }, [filtered]);

  const filterAccount = accountFilter != null ? accountById.get(accountFilter) : null;
  const colCount = accountFilter ? 8 : 9;

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

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="swap" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>
            {filterAccount ? filterAccount.name : "All Transactions"}
          </span>
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
        className="flex-1 min-h-0 overflow-auto y-scroll"
      >
        <table className="y-table">
          <thead className="y-thead y-thead--sticky">
            <tr>
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
                  const isChild = t.parentId != null;
                  const outflow = t.amount < 0 ? -t.amount : 0;
                  const inflow = t.amount > 0 ? t.amount : 0;
                  const catName =
                    t.categoryId != null ? categoryById.get(t.categoryId)?.name ?? "" : "";
                  const displayCat = catName || (t.transferAccountId ? "Transfer" : "");
                  return (
                    <tr
                      key={t.id}
                      className={`group y-row ${globalIndex % 2 === 1 ? "alt" : ""} ${
                        isChild ? "!bg-[var(--y-panel-alt)]" : ""
                      }`}
                      onClick={() => !isChild && onEdit(t.id)}
                      style={{ cursor: isChild ? "default" : "pointer" }}
                    >
                      <td className="y-num">{t.date}</td>
                      {!accountFilter && (
                        <td className="truncate" style={{ color: "var(--y-ink-soft)" }}>
                          {accountById.get(t.accountId)?.name ?? ""}
                        </td>
                      )}
                      <td className="truncate" style={{ color: "var(--y-ink)" }}>
                        {isChild && (
                          <span
                            className="inline-block mr-[5px] align-[-2px]"
                            style={{ color: "var(--y-ink-faint)" }}
                          >
                            ↳
                          </span>
                        )}
                        {t.payee}
                      </td>
                      <td
                        className="truncate"
                        style={{
                          color: displayCat.startsWith("Split") ? "var(--y-blue)" : "var(--y-ink-soft)",
                        }}
                      >
                        {displayCat || (
                          <span className="italic" style={{ color: "var(--y-ink-faint)" }}>
                            Transfer
                          </span>
                        )}
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
                        {isChild ? null : (
                          <ClearedFlag
                            state={t.status}
                            onCycle={() => onCycleStatus(t.id)}
                            disabled={t.status === "r"}
                          />
                        )}
                      </td>
                      <td
                        className="num y-num"
                        style={{
                          color: isChild
                            ? "var(--y-ink-faint)"
                            : t.runningBalance < 0
                              ? "var(--y-red)"
                              : "var(--y-ink)",
                          fontWeight: !isChild && t.runningBalance < 0 ? 700 : 400,
                        }}
                      >
                        {isChild ? "—" : money(t.runningBalance)}
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
