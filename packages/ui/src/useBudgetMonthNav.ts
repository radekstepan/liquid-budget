"use client";

import { useCallback, useMemo, useState } from "react";
import type { BudgetData } from "@ynab/logic";
import { isValidISOMonth, monthKey, parseMonthKey, todayISO } from "@ynab/logic";
import type { View } from "./Sidebar.js";
import { useBudgetUrlSync } from "./useBudgetUrlSync.js";
import { useLocalStorage } from "./useLocalStorage.js";

export type BudgetMonthNavArgs = {
  data: BudgetData;
  view: View;
  setView: (v: View) => void;
  accountFilter: number | null;
  setAccountFilter: (id: number | null) => void;
  initialMonth?: string;
};

export type BudgetMonthNav = {
  month: string;
  monthCount: number;
  updateUrl: (newView: View, newAccount: number | null, newMonth: string) => void;
  visibleMonths: string[];
  canShiftRight: boolean;
  minYear: number;
  maxYear: number;
  shiftMonth: (delta: number) => void;
  handleSetMonth: (m: string) => void;
  handleSetMonthCount: (count: number) => void;
};

/** Month navigation state for the app shell (ui-split slice 11, BudgetApp
 * slice 1). Owns the anchor month + visible-month count, the visible-months
 * memo, shift/clamp derivations, the shift/set handlers with budget-view URL
 * sync, the year bounds scanned from data, and the URL-sync hook itself
 * (it needs `setMonth`, so it lives here to avoid a state cycle). */
export function useBudgetMonthNav({
  data,
  view,
  setView,
  accountFilter,
  setAccountFilter,
  initialMonth,
}: BudgetMonthNavArgs): BudgetMonthNav {
  const [month, setMonth] = useState(() =>
    initialMonth && isValidISOMonth(initialMonth) ? initialMonth : todayISO().slice(0, 7)
  );
  const [monthCount, setMonthCount] = useLocalStorage<number>(
    "ynab:budget:monthCount",
    3,
    (v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 12
  );

  const updateUrl = useBudgetUrlSync({ setView, setAccountFilter, setMonth });

  const isBudgetView = view === "budget";

  const today = todayISO().slice(0, 7);
  const { year: ty, month0: tm0 } = parseMonthKey(today);
  const todayMonthTotal = ty * 12 + tm0;
  const maxMonthTotal = todayMonthTotal + 1;
  const maxAllowedMonth = monthKey(Math.floor(maxMonthTotal / 12), ((maxMonthTotal % 12) + 12) % 12);

  const visibleMonths = useMemo(() => {
    if (!isBudgetView) return [month];
    const { year: y, month0 } = parseMonthKey(month);
    const anchorTotal = y * 12 + month0;
    const offset = Math.floor((monthCount - 1) / 2);
    const start = anchorTotal - offset;
    const keys: string[] = [];
    for (let i = 0; i < monthCount; i++) {
      const t = start + i;
      if (t > maxMonthTotal) break;
      const yy = Math.floor(t / 12);
      const mm = ((t % 12) + 12) % 12;
      keys.push(monthKey(yy, mm));
    }
    return keys.length > 0 ? keys : [month];
  }, [month, monthCount, isBudgetView, maxMonthTotal]);

  const canShiftRight = useMemo(() => {
    if (monthCount === 1) {
      return month < maxAllowedMonth;
    }
    const rightmost = visibleMonths[visibleMonths.length - 1];
    if (rightmost && rightmost >= maxAllowedMonth) {
      return false;
    }
    const { year: y, month0 } = parseMonthKey(month);
    const candidateTotal = y * 12 + month0 + 1;
    const offset = Math.floor((monthCount - 1) / 2);
    const candidateStart = candidateTotal - offset;
    if (candidateStart > todayMonthTotal) {
      return false;
    }
    return true;
  }, [month, monthCount, visibleMonths, maxAllowedMonth, todayMonthTotal]);

  const shiftMonth = useCallback(
    (delta: number) => {
      if (delta > 0 && !canShiftRight) return;
      const { year: y, month0 } = parseMonthKey(month);
      const total = y * 12 + month0 + delta;
      const nextMonth = monthKey(Math.floor(total / 12), ((total % 12) + 12) % 12);
      setMonth(nextMonth);
      if (view === "budget") {
        updateUrl(view, accountFilter, nextMonth);
      }
    },
    [month, view, accountFilter, updateUrl, canShiftRight]
  );

  const handleSetMonth = useCallback(
    (m: string) => {
      const clamped = m > maxAllowedMonth ? maxAllowedMonth : m;
      setMonth(clamped);
      if (view === "budget") {
        updateUrl(view, accountFilter, clamped);
      }
    },
    [view, accountFilter, updateUrl, maxAllowedMonth]
  );

  const handleSetMonthCount = useCallback(
    (count: number) => {
      setMonthCount(count);
      if (count > 1 && month > today) {
        setMonth(today);
        if (view === "budget") {
          updateUrl(view, accountFilter, today);
        }
      }
    },
    [setMonthCount, month, today, view, accountFilter, updateUrl]
  );

  const { minYear, maxYear } = useMemo(() => {
    const thisYear = Number(todayISO().slice(0, 4));
    const futureCap = thisYear + 5;
    let minY = thisYear;
    let maxY = futureCap;
    const consider = (dateStr: string | undefined | null) => {
      if (!dateStr || dateStr.length < 4) return;
      const y = parseInt(dateStr.slice(0, 4), 10);
      if (Number.isFinite(y)) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    };
    for (let i = 0; i < data.transactions.length; i++) consider(data.transactions[i]!.date);
    for (let i = 0; i < data.assignments.length; i++) consider(data.assignments[i]!.month);
    for (let i = 0; i < data.recurring.length; i++) consider(data.recurring[i]!.nextDate);
    return { minYear: minY, maxYear: maxY };
  }, [data.transactions, data.assignments, data.recurring]);

  return {
    month,
    monthCount,
    updateUrl,
    visibleMonths,
    canShiftRight,
    minYear,
    maxYear,
    shiftMonth,
    handleSetMonth,
    handleSetMonthCount,
  };
}
