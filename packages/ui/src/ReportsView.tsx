"use client";

import { memo, useMemo, useState } from "react";
import type { BudgetData } from "@ynab/logic";
import { fmt, num, monthLabel, computeNetWorthReport, type NetWorthPoint } from "@ynab/logic";
import { Icon, Toolbar, ToolbarSep, MonthNav, Select, Panel, MathCell, Tabs } from "@ynab/theme";
import { NetWorthReport } from "./NetWorthReport.js";
import { SpendingReport, type SpendingItem } from "./SpendingReport.js";

type SubTab = "overview" | "networth" | "spending";

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "networth", label: "Net Worth" },
  { key: "spending", label: "Spending by Category" },
];

export const ReportsView = memo(function ReportsView({
  data,
  month,
  onPrev,
  onNext,
  onSetMonth,
  minYear,
  maxYear,
}: {
  data: BudgetData;
  month: string;
  onPrev?: () => void;
  onNext?: () => void;
  onSetMonth?: (m: string) => void;
  minYear?: number;
  maxYear?: number;
}) {
  const allMonths = useMemo(() => {
    const s = new Set<string>();
    for (const t of data.transactions) s.add(t.date.slice(0, 7));
    if (s.size === 0) return [month];
    return Array.from(s).sort();
  }, [data.transactions, month]);

  const defaultStart = allMonths[0] ?? month;
  const defaultEnd = allMonths[allMonths.length - 1] ?? month;

  const [startMonth, setStartMonth] = useState<string>(defaultStart);
  const [endMonth, setEndMonth] = useState<string>(defaultEnd);
  const [sub, setSub] = useState<SubTab>("overview");

  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;

  const splitParentIds = useMemo(() => {
    const set = new Set<number>();
    for (const t of data.transactions) {
      if (t.parentId != null) set.add(t.parentId);
    }
    return set;
  }, [data.transactions]);

  const catMap = useMemo(
    () => new Map(data.categories.map((c) => [c.id, c.name])),
    [data.categories]
  );

  const rangeTxns = useMemo(
    () =>
      data.transactions.filter((t) => {
        if (splitParentIds.has(t.id)) return false;
        const mk = t.date.slice(0, 7);
        return mk >= actualStart && mk <= actualEnd;
      }),
    [data.transactions, splitParentIds, actualStart, actualEnd]
  );

  const income = useMemo(
    () =>
      rangeTxns
        .filter((t) => t.categoryId == null && t.transferAccountId == null && num(t.amount) > 0)
        .reduce((s, t) => s + num(t.amount), 0),
    [rangeTxns]
  );
  const expense = useMemo(
    () =>
      rangeTxns
        .filter((t) => t.transferAccountId == null && num(t.amount) < 0)
        .reduce((s, t) => s + num(t.amount), 0),
    [rangeTxns]
  );

  const spending: SpendingItem[] = useMemo(() => {
    const byCat = new Map<number, number>();
    for (const t of rangeTxns) {
      if (t.categoryId == null || t.transferAccountId != null) continue;
      const a = num(t.amount);
      if (a < 0) byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + -a);
    }
    return [...byCat.entries()]
      .map(([id, v]) => ({ name: catMap.get(id) ?? "—", value: v }))
      .sort((a, b) => b.value - a.value);
  }, [rangeTxns, catMap]);

  const totalSpend = useMemo(() => spending.reduce((s, x) => s + x.value, 0), [spending]);

  const payees = useMemo(() => {
    const byPayee = new Map<string, number>();
    for (const t of rangeTxns) {
      if (t.transferAccountId != null) continue;
      const a = num(t.amount);
      if (a < 0 && t.payee) byPayee.set(t.payee, (byPayee.get(t.payee) ?? 0) + -a);
    }
    return [...byPayee.entries()]
      .map(([n, v]) => ({ n, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 6);
  }, [rangeTxns]);

  const netWorthData: NetWorthPoint[] = useMemo(() => {
    return computeNetWorthReport(data, actualStart, actualEnd);
  }, [data, actualStart, actualEnd]);

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="chart" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>Reports</span>
        </div>
        {(onPrev || onNext || onSetMonth) && (
          <>
            <ToolbarSep />
            <MonthNav
              month={month}
              onPrev={onPrev}
              onNext={onNext}
              onSetMonth={onSetMonth}
              minYear={minYear}
              maxYear={maxYear}
            />
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="y-caps">From</span>
          <Select
            value={startMonth}
            onChange={(v) => setStartMonth(v)}
            ariaLabel="From month"
          >
            {allMonths.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
          <span className="y-caps">To</span>
          <Select
            value={endMonth}
            onChange={(v) => setEndMonth(v)}
            ariaLabel="To month"
          >
            {allMonths.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
        </div>
      </Toolbar>

      <Tabs
        tabs={SUB_TABS.map((t) => t.label)}
        value={SUB_TABS.find((t) => t.key === sub)?.label ?? SUB_TABS[0]!.label}
        onChange={(label) => {
          const match = SUB_TABS.find((t) => t.label === label);
          if (match) setSub(match.key);
        }}
      />

      <div className="min-h-0 flex-1">
        {sub === "overview" && (
          <div className="h-full overflow-y-auto p-4 y-scroll">
            <div className="mb-3 flex flex-wrap gap-2">
              <MathCell
                label="Income"
                value={fmt(income)}
                tone="green"
                className="flex-1"
                style={{ minWidth: 140 }}
              />
              <MathCell
                label="Expenses"
                value={fmt(expense)}
                tone="red"
                className="flex-1"
                style={{ minWidth: 140 }}
              />
              <MathCell
                label="Net"
                value={fmt(income + expense)}
                tone={income + expense >= 0 ? "green" : "red"}
                className="flex-1"
                style={{ minWidth: 140 }}
              />
            </div>

            <Panel title="Top Payees" bodyClass="p-3">
              {payees.length === 0 ? (
                <div className="py-4 text-center y-hint">No data for this timeframe.</div>
              ) : (
                <div className="space-y-[6px]">
                  {payees.map((p) => (
                    <div
                      key={p.n}
                      className="flex items-center justify-between text-[12px]"
                    >
                      <span style={{ color: "var(--y-ink-soft)" }}>{p.n}</span>
                      <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
                        {fmt(p.v)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}

        {sub === "networth" && (
          <div className="h-full p-4">
            <NetWorthReport points={netWorthData} />
          </div>
        )}

        {sub === "spending" && (
          <div className="h-full p-4">
            <SpendingReport spending={spending} total={totalSpend} />
          </div>
        )}
      </div>
    </div>
  );
});

