"use client";

import { useEffect, useState } from "react";
import { todayISO } from "@ynab/logic";

/**
 * Milliseconds from `from` until the next local midnight, plus a small
 * buffer so the timer fires just after the date actually rolls over.
 */
export function msUntilNextMidnight(from: Date = new Date()): number {
  const midnight = new Date(from);
  midnight.setHours(24, 0, 0, 0);
  return Math.max(1000, midnight.getTime() - from.getTime() + 500);
}

/**
 * Live YYYY-MM-DD string that ticks over at local midnight.
 *
 * `todayISO()` is a snapshot — memos like
 * `useMemo(() => countDueRecurring(rows, todayISO()), [rows])` freeze the
 * date for the lifetime of the mount, so an app left open overnight keeps
 * yesterday's due-badge counts. This hook holds the date in state, arms a
 * one-shot timeout for the next midnight, and also re-checks on
 * `visibilitychange` / `focus` to cover laptop sleep and background-tab
 * timer throttling where the timeout may fire late or be clamped.
 */
export function useTodayISO(): string {
  const [today, setToday] = useState(() => todayISO());

  useEffect(() => {
    const check = () => {
      const now = todayISO();
      setToday((prev) => (prev === now ? prev : now));
    };

    const delay = msUntilNextMidnight(new Date());
    const timer = setTimeout(check, delay);

    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        check();
      }
    };
    const onFocus = () => check();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [today]);

  return today;
}
