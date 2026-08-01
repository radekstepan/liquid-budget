"use client";

import { useMemo, useState } from "react";
import type { BudgetData, Transaction } from "@ynab/logic";
import { fmt, num } from "@ynab/logic";
import { Icon, ClearedFlag, Toolbar, money } from "@ynab/theme";

type Txn = Omit<Transaction, "amount"> & { amount: number };

export function TransactionsView({
  data,
  accountFilter,
  setAccountFilter,
  onAdd,
  onEdit,
  onDelete,
}: {
  data: BudgetData;
  accountFilter: number | null;
  setAccountFilter: (id: number | null) => void;
  onAdd: () => void;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const [search, setSearch] = useState("");

  const accountById = useMemo(
    () => new Map(data.accounts.map((a) => [a.id, a] as const)),
    [data.accounts]
  );
  const categoryById = useMemo(
    () => new Map(data.categories.map((c) => [c.id, c] as const)),
    [data.categories]
  );

  const rows = useMemo<Txn[]>(() => {
    return data.transactions
      .filter((t) => {
        if (accountFilter == null) return true;
        if (t.accountId === accountFilter) return true;
        if (t.transferAccountId != null && t.transferAccountId === accountFilter) return true;
        return false;
      })
      .map((t) => ({ ...t, amount: num(t.amount) }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [data.transactions, accountFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    const childIds = new Set(rows.filter((r) => r.parentId != null).map((r) => r.parentId!));
    return rows.filter(
      (r) =>
        r.payee.toLowerCase().includes(q) ||
        (categoryById.get(r.categoryId ?? -1)?.name ?? "").toLowerCase().includes(q) ||
        (r.memo ?? "").toLowerCase().includes(q) ||
        (r.parentId != null && childIds.has(r.id))
    );
  }, [rows, search, categoryById]);

  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    for (const r of filtered) {
      if (r.parentId != null) continue;
      if (r.amount > 0) inflow += r.amount;
      else outflow += -r.amount;
    }
    return { inflow, outflow, net: inflow - outflow, count: filtered.filter((r) => r.parentId == null).length };
  }, [filtered]);

  const filterAccount = accountFilter != null ? accountById.get(accountFilter) : null;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="swap" size={14} color="#3f4649" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>
            {filterAccount ? filterAccount.name : "All Transactions"}
          </span>
          {filterAccount && (
            <span className="y-pill y-pill--blue" style={{ minWidth: 0, padding: "1px 7px 2px" }}>
              {fmt(num(filterAccount.balance))}
              <button
                type="button"
                onClick={() => setAccountFilter(null)}
                className="ml-1"
                aria-label="Clear account filter"
              >
                <Icon name="x" size={9} color="#fff" />
              </button>
            </span>
          )}
        </div>
        <div className="y-tb-sep" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search register"
          className="y-input y-search"
          style={{ width: 168 }}
        />
        <button onClick={onAdd} className="y-btn y-btn--primary ml-auto">
          <Icon name="plus" size={11} color="#fff" /> Add Transaction
        </button>
      </Toolbar>

      <div
        className="flex items-center gap-3 px-3 py-1.5 text-[11px]"
        style={{ borderBottom: "1px solid #bdbdb8", background: "var(--y-panel-alt)" }}
      >
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

      <div className="flex-1 min-h-0 overflow-auto y-scroll">
        <table className="y-table">
          <thead className="y-thead">
            <tr>
              <th style={{ width: 22 }} />
              <th style={{ width: 92 }}>Date</th>
              <th style={{ width: 130 }}>Account</th>
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
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-center py-6 y-hint">
                  No transactions match your filter.
                </td>
              </tr>
            ) : (
              filtered.map((t, i) => {
                const isChild = t.parentId != null;
                const outflow = t.amount < 0 ? -t.amount : 0;
                const inflow = t.amount > 0 ? t.amount : 0;
                const catName =
                  t.categoryId != null ? categoryById.get(t.categoryId)?.name ?? "" : "";
                const displayCat = catName || (t.transferAccountId ? "Transfer" : "");
                return (
                  <tr
                    key={t.id}
                    className={`group y-row ${i % 2 === 1 ? "alt" : ""} ${
                      isChild ? "!bg-[var(--y-panel-alt)]" : ""
                    }`}
                    onClick={() => !isChild && onEdit(t.id)}
                    style={{ cursor: isChild ? "default" : "pointer" }}
                  >
                    <td className="text-center" />
                    <td className="y-num">{t.date}</td>
                    <td className="truncate" style={{ color: "var(--y-ink-soft)" }}>
                      {accountById.get(t.accountId)?.name ?? ""}
                    </td>
                    <td className="truncate" style={{ color: "var(--y-ink)" }}>
                      {isChild && (
                        <span
                          className="inline-block mr-[5px] align-[-2px]"
                          style={{ color: "var(--y-ink-faint)" }}
                        >
                          ↳
                        </span>
                      )}
                      {!isChild && t.parentId == null && t.transferAccountId == null && null}
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
                      {isChild ? null : <ClearedFlag state={t.cleared ? "c" : "u"} />}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
