"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetData, Transaction } from "@ynab/logic";
import {
  num,
  monthKey,
  parseMonthKey,
  todayISO,
  MONTHS_LONG,
  computeNetWorthReport,
  type NetWorthPoint,
} from "@ynab/logic";
import { Icon, Toolbar, Select, Tabs } from "@ynab/theme";
import { NetWorthReport } from "./NetWorthReport.js";
import { SpendingReport, type SpendingItem } from "./SpendingReport.js";
import { SpendingTrendsReport } from "./SpendingTrendsReport.js";
import { useLocalStorage } from "./useLocalStorage.js";

type SubTab = "trends" | "spending" | "networth";

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: "trends", label: "Spending Trends" },
  { key: "spending", label: "Spending by Category" },
  { key: "networth", label: "Net Worth" },
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

    const list: number[] = [];
    for (let y = yMin; y <= yMax; y++) list.push(y);
    return list;
  }, [data.transactions, minYear, maxYear, startMonth, endMonth]);

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

  const spending: SpendingItem[] = useMemo(() => {
    const byCat = new Map<number, number>();
    for (const t of rangeTxns) {
      if (t.categoryId == null) continue;
      const a = num(t.amount);
      byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) - a);
    }
    return [...byCat.entries()]
      .filter(([_, v]) => v > 0)
      .map(([id, v]) => ({ name: catMap.get(id) ?? "—", value: v }))
      .sort((a, b) => b.value - a.value);
  }, [rangeTxns, catMap]);

  const totalSpend = useMemo(() => spending.reduce((s, x) => s + x.value, 0), [spending]);

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
            <SpendingReport spending={spending} total={totalSpend} />
          </div>
        )}

        {sub === "networth" && (
          <div className="h-full p-4">
            <NetWorthReport points={netWorthData} />
          </div>
        )}
      </div>
    </div>
  );
});

