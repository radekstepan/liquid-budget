"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetData, Transaction } from "@ynab/logic";
import {
  monthKey,
  parseMonthKey,
  todayISO,
  MONTHS_LONG,
  computeNetWorthReport,
  computeMonthlySurplus,
  computeIncomeBreakdown,
  computeSpendingGroupFlow,
  type NetWorthPoint,
  type SurplusMonthPoint,
} from "@ynab/logic";
import { Icon, Toolbar, Select, Tabs } from "@ynab/theme";
import { NetWorthReport } from "./NetWorthReport.js";
import { SurplusReport } from "./SurplusReport.js";
import { SpendingReport, type SpendingItem } from "./SpendingReport.js";
import { SpendingTrendsReport } from "./SpendingTrendsReport.js";
import { useLocalStorage } from "./useLocalStorage.js";

type SubTab = "trends" | "spending" | "networth" | "surplus";

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: "trends", label: "Spending Trends" },
  { key: "spending", label: "Spending by Category" },
  { key: "networth", label: "Net Worth" },
  { key: "surplus", label: "Cash Flow" },
];

export const ReportsView = memo(function ReportsView({
  data,
  month,
  minYear,
  maxYear,
  resetKey,
  onSelectTransaction,
}: {
  data: BudgetData;
  month: string;
  onPrev?: () => void;
  onNext?: () => void;
  onSetMonth?: (m: string) => void;
  minYear?: number;
  maxYear?: number;
  resetKey?: number;
  onSelectTransaction?: (transaction: Transaction) => void;
}) {
  const allMonths = useMemo(() => {
    const thisMonth = todayISO().slice(0, 7);
    const s = new Set<string>();
    for (const t of data.transactions) {
      const m = t.date.slice(0, 7);
      if (m <= thisMonth) {
        s.add(m);
      }
    }
    if (s.size === 0) return [month <= thisMonth ? month : thisMonth];
    return Array.from(s).sort();
  }, [data.transactions, month]);

  const defaultStart = allMonths[0] ?? month;
  const defaultEnd = allMonths[allMonths.length - 1] ?? month;

  const [userCustomizedRange, setUserCustomizedRange] = useState(false);
  const [startMonth, setStartMonth] = useState<string>(defaultStart);
  const [endMonth, setEndMonth] = useState<string>(defaultEnd);
  const [sub, setSub] = useLocalStorage<SubTab>(
    "ynab:reports:subTab",
    "trends",
    (v): v is SubTab => typeof v === "string" && SUB_TABS.some((t) => t.key === v)
  );

  // Sync automatic default ranges when data changes and user has not customized the range
  useEffect(() => {
    if (!userCustomizedRange) {
      setStartMonth(defaultStart);
      setEndMonth(defaultEnd);
    }
  }, [defaultStart, defaultEnd, userCustomizedRange]);

  // Reset customized range when resetKey changes (e.g. clicking Reports in sidebar)
  const prevResetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (resetKey !== undefined && resetKey !== prevResetKeyRef.current) {
      prevResetKeyRef.current = resetKey;
      setUserCustomizedRange(false);
      setStartMonth(defaultStart);
      setEndMonth(defaultEnd);
    }
  }, [resetKey, defaultStart, defaultEnd]);

  const { year: startYear, month0: startMonth0 } = parseMonthKey(startMonth);
  const { year: endYear, month0: endMonth0 } = parseMonthKey(endMonth);

  const years = useMemo(() => {
    const thisYear = Number(todayISO().slice(0, 4));
    let yMin = thisYear;
    let yMax = thisYear;
    let hasData = false;

    for (const t of data.transactions) {
      const y = Number(t.date.slice(0, 4));
      if (Number.isFinite(y) && y >= 1900 && y <= thisYear) {
        if (!hasData) {
          yMin = y;
          yMax = y;
          hasData = true;
        } else {
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        }
      }
    }

    if (minYear != null && minYear < yMin) yMin = minYear;
    if (maxYear != null && maxYear <= thisYear && maxYear > yMax) yMax = maxYear;

    const { year: sY } = parseMonthKey(startMonth);
    const { year: eY } = parseMonthKey(endMonth);
    if (sY < yMin) yMin = sY;
    if (sY > yMax && sY <= thisYear) yMax = sY;
    if (eY < yMin) yMin = eY;
    if (eY > yMax && eY <= thisYear) yMax = eY;

    // Newest year first so the current year is at the top of the dropdown.
    const list: number[] = [];
    for (let y = yMax; y >= yMin; y--) list.push(y);
    return list;
  }, [data.transactions, minYear, maxYear, startMonth, endMonth]);

  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;

  const categoryFlow = useMemo(
    () => computeSpendingGroupFlow(data, actualStart, actualEnd, "categories"),
    [data, actualStart, actualEnd]
  );

  const merchantFlow = useMemo(
    () => computeSpendingGroupFlow(data, actualStart, actualEnd, "merchants"),
    [data, actualStart, actualEnd]
  );

  const incomeItems: SpendingItem[] = useMemo(
    () => computeIncomeBreakdown(data, actualStart, actualEnd),
    [data, actualStart, actualEnd]
  );

  const netWorthData: NetWorthPoint[] = useMemo(() => {
    return computeNetWorthReport(data, actualStart, actualEnd);
  }, [data, actualStart, actualEnd]);

  const surplusData: SurplusMonthPoint[] = useMemo(() => {
    return computeMonthlySurplus(data, actualStart, actualEnd);
  }, [data, actualStart, actualEnd]);

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="chart" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>Reports</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="y-caps">From</span>
            <Select
              value={String(startMonth0)}
              onChange={(v) => {
                setUserCustomizedRange(true);
                setStartMonth(monthKey(startYear, Number(v)));
              }}
              ariaLabel="From month"
            >
              {MONTHS_LONG.map((m, i) => (
                <option key={m} value={String(i)}>
                  {m}
                </option>
              ))}
            </Select>
            <Select
              value={String(startYear)}
              onChange={(v) => {
                setUserCustomizedRange(true);
                setStartMonth(monthKey(Number(v), startMonth0));
              }}
              ariaLabel="From year"
            >
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="y-caps">To</span>
            <Select
              value={String(endMonth0)}
              onChange={(v) => {
                setUserCustomizedRange(true);
                setEndMonth(monthKey(endYear, Number(v)));
              }}
              ariaLabel="To month"
            >
              {MONTHS_LONG.map((m, i) => (
                <option key={m} value={String(i)}>
                  {m}
                </option>
              ))}
            </Select>
            <Select
              value={String(endYear)}
              onChange={(v) => {
                setUserCustomizedRange(true);
                setEndMonth(monthKey(Number(v), endMonth0));
              }}
              ariaLabel="To year"
            >
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </Select>
          </div>
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
        {sub === "trends" && (
          <div className="h-full p-4">
            <SpendingTrendsReport
              data={data}
              startMonth={actualStart}
              endMonth={actualEnd}
              resetKey={resetKey}
              onSelectTransaction={onSelectTransaction}
            />
          </div>
        )}

        {sub === "spending" && (
          <div className="h-full p-4">
            <SpendingReport
              categoryFlow={categoryFlow}
              merchantFlow={merchantFlow}
              income={incomeItems}
            />
          </div>
        )}

        {sub === "networth" && (
          <div className="h-full p-4">
            <NetWorthReport points={netWorthData} />
          </div>
        )}

        {sub === "surplus" && (
          <div className="h-full p-4">
            <SurplusReport points={surplusData} />
          </div>
        )}
      </div>
    </div>
  );
});

