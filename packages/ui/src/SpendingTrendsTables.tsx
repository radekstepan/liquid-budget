"use client";

import { memo, useState } from "react";
import type { Transaction, SpendingTrendsConstituent } from "@ynab/logic";
import { fmt, num, monthLabel } from "@ynab/logic";
import { Button, Tooltip } from "@ynab/theme";

/** Drill-down table of per-group/per-category constituents with hover
 * highlighting (ui-split slice 5). Hover state is local, with optional
 * controlled `hoveredId`/`onHoverId` passthrough from the chart. */
export const ConstituentTable = memo(function ConstituentTable({
  constituents,
  colorMap,
  onDrill,
  drillLevel = "all",
  overallTotal = 0,
  hoveredId = null,
  onHoverId,
}: {
  constituents: SpendingTrendsConstituent[];
  colorMap: Map<number, string>;
  onDrill: (id: number) => void;
  drillLevel?: "all" | "group" | "category";
  overallTotal?: number;
  hoveredId?: number | null;
  onHoverId?: (id: number | null) => void;
}) {
  const [localHoverId, setLocalHoverId] = useState<number | null>(null);
  const activeHoverId = hoveredId !== undefined ? hoveredId : localHoverId;

  return (
    <table className="y-table w-full min-w-full" style={{ minWidth: 450 }}>
      <thead className="y-thead y-thead--sticky">
        <tr>
          <th>{drillLevel === "group" ? "Category" : "Master Category"}</th>
          <th className="num" style={{ width: 110, minWidth: 110 }}>Average/Mo</th>
          <th className="num" style={{ width: 110, minWidth: 110 }}>Total Spent</th>
          <th className="num" style={{ width: 80, minWidth: 80 }}>% Share</th>
        </tr>
      </thead>
      <tbody>
        {constituents.map((c, idx) => {
          const color = colorMap.get(c.id) ?? "#888";
          const isHovered = activeHoverId === c.id;

          return (
            <tr
              key={c.id}
              className={`y-row ${idx % 2 === 1 ? "alt" : ""} ${isHovered ? "is-sel" : ""} cursor-pointer group`}
              onMouseEnter={() => {
                setLocalHoverId(c.id);
                onHoverId?.(c.id);
              }}
              onMouseLeave={() => {
                setLocalHoverId(null);
                onHoverId?.(null);
              }}
              onClick={() => {
                setLocalHoverId(null);
                onHoverId?.(null);
                onDrill(c.id);
              }}
              aria-label={`Click to drill down into ${c.name}`}
            >
              <td>
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="inline-block h-3 w-3 shrink-0 rounded-sm"
                    style={{
                      background: color,
                      boxShadow:
                        "inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(0,0,0,0.1)",
                    }}
                  />
                  <Tooltip tip={`Click to drill down into ${c.name}`}>
                    <span className="truncate font-medium text-[var(--y-ink)]">
                      {c.name}
                    </span>
                  </Tooltip>
                </div>
              </td>
              <td className="num y-num font-medium text-[var(--y-ink-soft)] whitespace-nowrap">
                {fmt(c.avgPerMonth)}
              </td>
              <td className="num y-num font-semibold text-[var(--y-ink)] whitespace-nowrap">
                {fmt(c.total)}
              </td>
              <td className="num y-num text-[var(--y-ink-faint)] whitespace-nowrap">
                {overallTotal > 0 ? `${c.pctOfTotal}%` : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
});

/** Transaction register for the drilled-down category, with an optional
 * single-month filter bar (ui-split slice 5). */
export const CategoryTransactionsTable = memo(function CategoryTransactionsTable({
  categoryName,
  transactions,
  selectedMonth,
  onClearMonth,
  accountMap,
  onSelectTransaction,
}: {
  categoryName: string | null | undefined;
  transactions: Transaction[];
  selectedMonth: string | null;
  onClearMonth: () => void;
  accountMap: Map<number, string>;
  onSelectTransaction?: (transaction: Transaction) => void;
}) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="y-subbar flex items-center justify-between px-3 py-1.5 text-[11px] shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-bold text-[var(--y-ink)]">
            {categoryName} Transactions
          </span>
          <span className="y-caps text-[var(--y-ink-faint)]">
            {transactions.length} {transactions.length === 1 ? "entry" : "entries"}
          </span>
        </div>

        {selectedMonth ? (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="font-medium text-[var(--y-blue)]">
              Showing: {monthLabel(selectedMonth)}
            </span>
            <Tooltip tip="Show all months">
              <Button size="sm" variant="default" onClick={onClearMonth}>
                Show All Months
              </Button>
            </Tooltip>
          </div>
        ) : (
          <span className="text-[11px] text-[var(--y-ink-faint)]">
            Click any month bar to filter
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto y-scroll">
        {transactions.length === 0 ? (
          <div className="py-8 text-center y-hint text-[11.5px]">
            No transactions found for this timeframe.
          </div>
        ) : (
          <table className="y-table w-full min-w-full" style={{ minWidth: 560 }}>
            <thead className="y-thead y-thead--sticky">
              <tr>
                <th style={{ width: 85, minWidth: 85 }}>Date</th>
                <th style={{ minWidth: 120 }}>Payee</th>
                <th style={{ width: 140, minWidth: 120 }}>Account</th>
                <th style={{ minWidth: 120 }}>Memo</th>
                <th className="num" style={{ width: 100, minWidth: 90 }}>
                  Spending
                </th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t, idx) => {
                const spend = -num(t.amount);
                return (
                  <tr
                    key={t.id}
                    className={`y-row ${idx % 2 === 1 ? "alt" : ""} cursor-pointer hover:bg-[var(--y-row-sel)]`}
                    onClick={() => onSelectTransaction?.(t)}
                    aria-label={`Click to view transaction in ${accountMap.get(t.accountId) ?? "Account"}`}
                  >
                    <td className="font-mono whitespace-nowrap text-[11px] text-[var(--y-ink-soft)]">
                      {t.date}
                    </td>
                    <td className="font-medium text-[var(--y-ink)]">
                      <Tooltip tip={`Click to view transaction in ${accountMap.get(t.accountId) ?? "Account"}`}>
                        <div className="truncate">{t.payee || "—"}</div>
                      </Tooltip>
                    </td>
                    <td className="text-[var(--y-ink-soft)]">
                      <div className="truncate">{accountMap.get(t.accountId) ?? "Account"}</div>
                    </td>
                    <td className="text-[var(--y-ink-faint)]">
                      <div className="truncate">{t.memo || ""}</div>
                    </td>
                    <td
                      className={`num font-semibold y-num whitespace-nowrap ${
                        spend < 0 ? "text-[var(--y-green-dk)]" : "text-[var(--y-ink)]"
                      }`}
                    >
                      {fmt(spend)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
});
