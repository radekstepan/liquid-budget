"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { monthKey, parseMonthKey, todayISO } from "@ynab/logic";

export type BudgetMonthScrollArgs = {
  showMulti: boolean;
  visibleMonths: string[];
  currentMonth: string;
  canShiftRight?: boolean;
  onShiftMonth: (delta: number) => void;
};

export type BudgetMonthScroll = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  stickyCatThRef: RefObject<HTMLTableCellElement | null>;
  currentMonthThRef: RefObject<HTMLTableCellElement | null>;
  todayMonth: string;
  isOnThisMonth: boolean;
  hasThisMonthInView: boolean;
  isHScrolled: boolean;
  canGoRight: boolean;
  handleNext: () => void;
  scrollTodayIntoView: () => void;
};

/** Horizontal month-grid scroll state for the budget view (ui-split
 * slice 8). Owns the scroller + sticky refs, today-viewport visibility
 * (scroll/resize listeners + ResizeObserver), the sticky-column shadow
 * flag, Next-arrow enablement vs. clamped reveal, and the smooth
 * scroll-into-view helpers. Attach the refs to the scroll container,
 * the sticky Category header, and the current-month header. */
export function useBudgetMonthScroll({
  showMulti,
  visibleMonths,
  currentMonth,
  canShiftRight,
  onShiftMonth,
}: BudgetMonthScrollArgs): BudgetMonthScroll {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const stickyCatThRef = useRef<HTMLTableCellElement | null>(null);
  const currentMonthThRef = useRef<HTMLTableCellElement | null>(null);

  const todayMonth = todayISO().slice(0, 7);
  const isOnThisMonth = currentMonth === todayMonth;

  const [isTodayInViewport, setIsTodayInViewport] = useState<boolean>(true);
  const [isHScrolled, setIsHScrolled] = useState<boolean>(false);

  useEffect(() => {
    const checkVisibility = () => {
      if (!showMulti) {
        setIsTodayInViewport(isOnThisMonth);
        return;
      }
      if (!visibleMonths.includes(todayMonth)) {
        setIsTodayInViewport(false);
        return;
      }
      const container = scrollContainerRef.current;
      const targetEl = currentMonthThRef.current;
      if (!container || !targetEl) {
        setIsTodayInViewport(visibleMonths.includes(todayMonth));
        return;
      }
      const containerRect = container.getBoundingClientRect();
      if (containerRect.width === 0 && containerRect.height === 0) {
        // Fallback in test/headless environments without layout geometry
        setIsTodayInViewport(true);
        return;
      }
      const stickyCatEl = stickyCatThRef.current;
      const stickyRect = stickyCatEl?.getBoundingClientRect();
      const viewportLeft = stickyRect ? stickyRect.right : containerRect.left;
      const viewportRight = containerRect.right;
      const targetRect = targetEl.getBoundingClientRect();

      // At least partially visible if the month header overlaps the visible viewport window
      const isVisible =
        targetRect.right > viewportLeft + 1 && targetRect.left < viewportRight - 1;
      setIsTodayInViewport(isVisible);
    };

    checkVisibility();

    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener("scroll", checkVisibility, { passive: true });
    window.addEventListener("resize", checkVisibility);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => checkVisibility());
      ro.observe(container);
    }

    return () => {
      container.removeEventListener("scroll", checkVisibility);
      window.removeEventListener("resize", checkVisibility);
      ro?.disconnect();
    };
  }, [showMulti, isOnThisMonth, visibleMonths, todayMonth]);

  // Track horizontal scroll so the sticky Category column can cast a
  // subtle shadow on its right edge only once content slides under it.
  // Also track whether more grid sits to the right of the viewport so the
  // Next-month arrow stays enabled until fully scrolled right.
  const [canScrollRight, setCanScrollRight] = useState<boolean>(false);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const update = () => {
      setIsHScrolled(container.scrollLeft > 1);
      setCanScrollRight(
        container.scrollWidth - container.scrollLeft - container.clientWidth > 1
      );
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [showMulti, visibleMonths]);

  // On init, ensure today's month column is actually visible inside the
  // horizontal scroller — not stuck behind the scrollbar/fold at scrollLeft 0.
  const didInitScrollRef = useRef(false);
  useEffect(() => {
    if (didInitScrollRef.current) return;
    if (!showMulti) return;
    if (!visibleMonths.includes(todayMonth)) return;
    const targetEl = currentMonthThRef.current;
    const container = scrollContainerRef.current;
    if (!targetEl || !container) return;
    didInitScrollRef.current = true;
    if (typeof targetEl.scrollIntoView === "function") {
      try {
        targetEl.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" as ScrollBehavior });
        return;
      } catch {
        // fall through to manual centering
      }
    }
    try {
      const targetLeft = (targetEl as HTMLElement).offsetLeft;
      const targetWidth = (targetEl as HTMLElement).offsetWidth;
      container.scrollLeft = Math.max(
        0,
        targetLeft - container.clientWidth / 2 + targetWidth / 2
      );
    } catch {
      // scroll is best-effort; layout stays usable without it
    }
  }, [showMulti, visibleMonths, todayMonth]);

  const hasThisMonthInView = showMulti ? isTodayInViewport : isOnThisMonth;

  const { year: ty, month0: tm0 } = parseMonthKey(todayMonth);
  const maxMonthTotal = ty * 12 + tm0 + 1;
  const maxAllowedMonth = monthKey(Math.floor(maxMonthTotal / 12), ((maxMonthTotal % 12) + 12) % 12);
  const rightmost = visibleMonths[visibleMonths.length - 1];
  const computedCanShiftRight =
    canShiftRight !== undefined
      ? canShiftRight
      : showMulti
      ? !rightmost || rightmost < maxAllowedMonth
      : currentMonth < maxAllowedMonth;

  // The Next arrow stays enabled while there is anything to the right —
  // newer months to shift into, or unscrolled grid already rendered.
  const canGoRight = computedCanShiftRight || canScrollRight;
  const handleNext = () => {
    if (computedCanShiftRight) {
      onShiftMonth(1);
      return;
    }
    // At the newest months but not yet scrolled fully right: reveal the
    // remaining grid instead of shifting (which is clamped).
    const container = scrollContainerRef.current;
    if (!container) return;
    const step = container.clientWidth > 0 ? container.clientWidth * 0.8 : 360;
    if (typeof container.scrollBy === "function") {
      try {
        container.scrollBy({ left: step, behavior: "smooth" });
        return;
      } catch {
        // fall through to direct assignment
      }
    }
    container.scrollLeft += step;
  };

  const scrollTodayIntoView = () => {
    if (!showMulti || !currentMonthThRef.current) return;
    if (typeof currentMonthThRef.current.scrollIntoView === "function") {
      currentMonthThRef.current.scrollIntoView({
        behavior: "smooth",
        inline: "center",
        block: "nearest",
      });
    }
  };

  return {
    scrollContainerRef,
    stickyCatThRef,
    currentMonthThRef,
    todayMonth,
    isOnThisMonth,
    hasThisMonthInView,
    isHScrolled,
    canGoRight,
    handleNext,
    scrollTodayIntoView,
  };
}
