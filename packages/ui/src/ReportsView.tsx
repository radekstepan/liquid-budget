"use client";

import { useMemo, useState } from "react";
import type { BudgetData, Transaction } from "@ynab/logic";
import { fmt, num, monthLabel } from "@ynab/logic";
import { Icon, Toolbar, Select, Panel, MathCell, Tabs } from "@ynab/theme";
import { NetWorthReport, type NetWorthPoint } from "./NetWorthReport.js";
import { SpendingReport, type SpendingItem } from "./SpendingReport.js";
import { ExpenseBreakdownReport } from "./ExpenseBreakdownReport.js";

type SubTab = "overview" | "networth" | "spending" | "breakdown";

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "networth", label: "Net Worth" },
  { key: "spending", label: "Spending by Category" },
  { key: "breakdown", label: "Expense Breakdown" },
];

function getMonthsBetween(start: string, end: string) {
  const partsS = start.split("-");
  const partsE = end.split("-");
  let y = Number(partsS[0]);
  let m = Number(partsS[1]);
  const ey = Number(partsE[0]);
  const em = Number(partsE[1]);
  const out: string[] = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${m.toString().padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function ReportsView({
  data,
  month,
}: {
  data: BudgetData;
  month: string;
  onPrev: () => void;
  onNext: () => void;
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

  const catMap = useMemo(
    () => new Map(data.categories.map((c) => [c.id, c.name])),
    [data.categories]
  );

  const rangeTxns = useMemo(
    () =>
      data.transactions.filter((t) => {
        const mk = t.date.slice(0, 7);
        return mk >= actualStart && mk <= actualEnd;
      }),
    [data.transactions, actualStart, actualEnd]
  );

  const income = useMemo(
    () =>
      rangeTxns
        .filter((t) => t.categoryId == null && num(t.amount) > 0)
        .reduce((s, t) => s + num(t.amount), 0),
    [rangeTxns]
  );
  const expense = useMemo(
    () => rangeTxns.filter((t) => num(t.amount) < 0).reduce((s, t) => s + num(t.amount), 0),
    [rangeTxns]
  );

  const spending: SpendingItem[] = useMemo(() => {
    const byCat = new Map<number, number>();
    for (const t of rangeTxns) {
      if (t.categoryId == null) continue;
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
      const a = num(t.amount);
      if (a < 0) byPayee.set(t.payee, (byPayee.get(t.payee) ?? 0) + -a);
    }
    return [...byPayee.entries()]
      .map(([n, v]) => ({ n, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 6);
  }, [rangeTxns]);

  const netWorthData: NetWorthPoint[] = useMemo(() => {
    const months = getMonthsBetween(actualStart, actualEnd);
    const accBalances = new Map<number, number>();

    for (const t of data.transactions) {
      if (t.date.slice(0, 7) < actualStart) {
        accBalances.set(t.accountId, (accBalances.get(t.accountId) ?? 0) + num(t.amount));
      }
    }

    const txnsByMonth = new Map<string, Transaction[]>();
    for (const t of data.transactions) {
      const mk = t.date.slice(0, 7);
      if (!txnsByMonth.has(mk)) txnsByMonth.set(mk, []);
      txnsByMonth.get(mk)!.push(t);
    }

    const points: NetWorthPoint[] = [];
    for (const m of months) {
      const txns = txnsByMonth.get(m) || [];
      for (const t of txns) {
        accBalances.set(t.accountId, (accBalances.get(t.accountId) ?? 0) + num(t.amount));
      }

      let assets = 0;
      let debts = 0;
      for (const [, bal] of accBalances.entries()) {
        if (bal > 0) assets += bal;
        else debts += bal;
      }
      points.push({ month: m, assets, debts, net: assets + debts });
    }
    return points;
  }, [data.transactions, actualStart, actualEnd]);

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="chart" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>Reports</span>
        </div>
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

        {sub === "breakdown" && (
          <div className="h-full p-4">
            <ExpenseBreakdownReport spending={spending} total={totalSpend} />
          </div>
        )}
      </div>
    </div>
  );
}
