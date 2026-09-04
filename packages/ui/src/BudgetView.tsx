"use client";

import { memo, useState, useRef, useEffect, useMemo, useCallback, Fragment } from "react";
import type { GroupRow, CatRow, BudgetResult, CategoryGroup } from "@ynab/logic";
import { evalAmount, fmt, MONTHS, parseMonthKey, monthKey, todayISO, dollarsToCents } from "@ynab/logic";
import {
  Icon,
  MonthNav,
  Button,
  Toolbar,
  ToolbarSep,
  cx,
} from "@ynab/theme";

/* ------------------------------------------------------------ helpers */

function formatMonthLong(monthKey: string): string {
  const { month0, year } = parseMonthKey(monthKey);
  return `${MONTHS[month0] ?? ""} ${year}`;
}

/**
 * The semantic color of a balance figure. Plain text color only — never a
 * pill, never a background tint, never an icon. The number is the data;
 * color is the meaning.
 */
function balanceColor(n: number): string {
  if (n > 0) return "var(--y-green-dk)";
  if (n < 0) return "var(--y-red)";
  return "var(--y-ink-faint)";
}

export function isInternalGroup(group: CategoryGroup | string): boolean {
  const name = typeof group === "string" ? group : group.name;
  return name === "__Internal__" || name.toLowerCase() === "__internal__";
}

export function isHiddenGroup(group: CategoryGroup | string): boolean {
  if (typeof group === "object" && group !== null) {
    if (group.isHidden !== undefined) return Boolean(group.isHidden);
    return group.name === "Hidden Categories" || group.name?.toLowerCase() === "hidden categories";
  }
  return group === "Hidden Categories" || group.toLowerCase() === "hidden categories";
}

const COL_A = "w-[120px]";
const COL_O = "w-[120px]";
const COL_V = "w-[120px]";

/* ------------------------------------------------------------ props */

export const BudgetView = memo(function BudgetView({
  budget,
  budgets,
  visibleMonths,
  monthCount,
  onSetMonthCount,
  currentMonth,
  collapsed,
  onToggleGroup,
  onAssign,
  onShiftMonth,
  onSetMonth,
  minYear,
  maxYear,
  onAddCategory,
  onAddGroup,
  onEditCategory,
  onDeleteCategory,
  onEditGroup,
  onDeleteGroup,
  onCollapseAll,
  onExpandAll,
  onReorderCategory,
  onReorderGroup,
  lastMonthAssignments,
  spentLastMonthByCategory,
  avgSpentByCategory,
  avgBudgetedByCategory,
  underfundedByCategory,
  selectedCategoryId,
  onSelectCategory,
  canShiftRight,
  quickBudgetByMonth,
  onQuickBudget,
  selectedCategory,
  onClearSelectedCategory,
}: {
  budget: BudgetResult;
  budgets: BudgetResult[];
  visibleMonths: string[];
  monthCount: number;
  onSetMonthCount?: (n: number) => void;
  currentMonth: string;
  collapsed: Record<number, boolean>;
  onToggleGroup: (id: number) => void;
  onAssign: (catId: number, amount: number, month: string) => void;
  onShiftMonth: (delta: number) => void;
  onSetMonth?: (key: string) => void;
  minYear?: number;
  maxYear?: number;
  onAddCategory: (groupId: number) => void;
  onAddGroup: () => void;
  onEditCategory: (catId: number) => void;
  onDeleteCategory: (catId: number) => void;
  onEditGroup: (groupId: number) => void;
  onDeleteGroup: (groupId: number) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onReorderCategory?: (id: number, sort: number) => void;
  onReorderGroup?: (id: number, sort: number) => void;
  lastMonthAssignments?: Map<number, number>;
  spentLastMonthByCategory?: Map<number, number>;
  avgSpentByCategory?: Map<number, number>;
  avgBudgetedByCategory?: Map<number, number>;
  underfundedByCategory?: Map<number, number>;
  selectedCategoryId?: number | null;
  onSelectCategory?: (id: number | null) => void;
  canShiftRight?: boolean;
  quickBudgetByMonth?: Record<string, { lastMonth: number; spentLastMonth: number; avgBudgeted: number }>;
  onQuickBudget?: (
    type: "lastMonth" | "spentLastMonth" | "avgBudgeted" | "clear",
    categoryId?: number,
    month?: string
  ) => void;
  selectedCategory?: { id: number; name: string } | null;
  onClearSelectedCategory?: () => void;
}) {
  const showMulti = monthCount > 1;

  const resolvedVisibleMonths =
    showMulti && visibleMonths && visibleMonths.length ? visibleMonths : [currentMonth];
  const resolvedBudgets = budgets && budgets.length ? budgets : [budget];
  const dragGroupId = useRef<number | null>(null);
  const [groupOverId, setGroupOverId] = useState<number | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const stickyCatThRef = useRef<HTMLTableCellElement | null>(null);
  const currentMonthThRef = useRef<HTMLTableCellElement | null>(null);

  const todayMonth = todayISO().slice(0, 7);
  const isOnThisMonth = currentMonth === todayMonth;

  const [isTodayInViewport, setIsTodayInViewport] = useState<boolean>(true);
  const [quickBudgetOpenMonth, setQuickBudgetOpenMonth] = useState<string | null>(null);
  const [isHScrolled, setIsHScrolled] = useState<boolean>(false);

  useEffect(() => {
    const checkVisibility = () => {
      if (!showMulti) {
        setIsTodayInViewport(isOnThisMonth);
        return;
      }
      if (!resolvedVisibleMonths.includes(todayMonth)) {
        setIsTodayInViewport(false);
        return;
      }
      const container = scrollContainerRef.current;
      const targetEl = currentMonthThRef.current;
      if (!container || !targetEl) {
        setIsTodayInViewport(resolvedVisibleMonths.includes(todayMonth));
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
  }, [showMulti, isOnThisMonth, resolvedVisibleMonths, todayMonth]);

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
  }, [showMulti, resolvedVisibleMonths]);

  // On init, ensure today's month column is actually visible inside the
  // horizontal scroller — not stuck behind the scrollbar/fold at scrollLeft 0.
  const didInitScrollRef = useRef(false);
  useEffect(() => {
    if (didInitScrollRef.current) return;
    if (!showMulti) return;
    if (!resolvedVisibleMonths.includes(todayMonth)) return;
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
  }, [showMulti, resolvedVisibleMonths, todayMonth]);

  const hasThisMonthInView = showMulti ? isTodayInViewport : isOnThisMonth;

  const { year: ty, month0: tm0 } = parseMonthKey(todayMonth);
  const maxMonthTotal = ty * 12 + tm0 + 1;
  const maxAllowedMonth = monthKey(Math.floor(maxMonthTotal / 12), ((maxMonthTotal % 12) + 12) % 12);
  const rightmost = resolvedVisibleMonths[resolvedVisibleMonths.length - 1];
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

  const handleGroupDrop = (targetId: number) => {
    const srcId = dragGroupId.current;
    if (srcId == null || srcId === targetId || !onReorderGroup) return;
    const structureGroups = budget.groups.filter(
      (g) => !g.group.isCreditCardPayments && !isInternalGroup(g.group) && !isHiddenGroup(g.group)
    );
    const srcIdx = structureGroups.findIndex((g) => g.group.id === srcId);
    const tgtIdx = structureGroups.findIndex((g) => g.group.id === targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;

    const reordered = [...structureGroups];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved!);
    reordered.forEach((g, i) => {
      if (g.group.sort !== i) onReorderGroup(g.group.id, i);
    });
    dragGroupId.current = null;
    setGroupOverId(null);
  };

  const visibleGroups = budget.groups.filter((g) => !isInternalGroup(g.group));
  const structureGroups = visibleGroups.filter(
    (g) => !g.group.isCreditCardPayments && !isHiddenGroup(g.group)
  );
  const creditGroup = visibleGroups.find(
    (g) => g.group.isCreditCardPayments && !isHiddenGroup(g.group)
  );
  const hiddenGroup = visibleGroups.find((g) => isHiddenGroup(g.group));

  const quickFill =
    lastMonthAssignments ||
    spentLastMonthByCategory ||
    avgSpentByCategory ||
    avgBudgetedByCategory ||
    underfundedByCategory
      ? {
          lastMonthAssignments,
          spentLastMonthByCategory,
          avgSpentByCategory,
          avgBudgetedByCategory,
          underfundedByCategory,
        }
      : undefined;

  // For each visible month, find the matching GroupRow by id.
  const groupsByMonth = useMemo(() => {
    return resolvedBudgets.map((b) => {
      const m = new Map<number, GroupRow>();
      for (const g of b.groups) m.set(g.group.id, g);
      return m;
    });
  }, [resolvedBudgets]);

  // Continuous zebra striping: subcategory rows alternate across the whole
  // list (not restarting at each group), so compute each group's starting
  // offset from the visible rows above it.
  const isGroupCollapsed = (id: number, fallback = false) =>
    collapsed[id] !== undefined ? Boolean(collapsed[id]) : fallback;
  const structureOffsets: number[] = [];
  {
    let offset = 0;
    for (const g of structureGroups) {
      structureOffsets.push(offset);
      if (!isGroupCollapsed(g.group.id)) offset += g.rows.length;
    }
  }
  const creditOffset = structureOffsets.length
    ? structureOffsets[structureOffsets.length - 1]! +
      (isGroupCollapsed(structureGroups[structureGroups.length - 1]!.group.id)
        ? 0
        : structureGroups[structureGroups.length - 1]!.rows.length)
    : 0;
  const hiddenOffset =
    creditOffset +
    (creditGroup && !isGroupCollapsed(creditGroup.group.id) ? creditGroup.rows.length : 0);
  const isHiddenCollapsed = hiddenGroup
    ? isGroupCollapsed(hiddenGroup.group.id, true)
    : true;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <MonthNav
          month={currentMonth}
          onPrev={() => onShiftMonth(-1)}
          onNext={canGoRight ? handleNext : undefined}
          onSetMonth={onSetMonth}
          minYear={minYear}
          maxYear={maxYear}
          nextDisabled={!canGoRight}
        />
        <Button
          size="sm"
          variant={!hasThisMonthInView ? "blue" : "default"}
          onClick={() => {
            onSetMonth?.(todayMonth);
            if (showMulti && currentMonthThRef.current) {
              if (typeof currentMonthThRef.current.scrollIntoView === "function") {
                currentMonthThRef.current.scrollIntoView({
                  behavior: "smooth",
                  inline: "center",
                  block: "nearest",
                });
              }
            }
          }}
          data-testid="today-btn"
          title={hasThisMonthInView ? "Current month is in view" : "Jump to current month"}
          className={hasThisMonthInView ? "text-[var(--y-ink-soft)]" : ""}
        >
          <Icon name="calendar" size={11} color={!hasThisMonthInView ? "#fff" : "var(--y-ink-soft)"} /> Today
        </Button>
        <ToolbarSep />
        <Button onClick={onAddGroup} size="sm">
          <Icon name="plus" size={11} /> Master Category
        </Button>
        {onSetMonthCount && (
          <MonthCountControl
            value={monthCount}
            onChange={onSetMonthCount}
          />
        )}
      </Toolbar>

      <div className={cx("min-h-0 flex-1 overflow-auto y-scroll", isHScrolled && "is-hscrolled")} ref={scrollContainerRef}>
        <table className={cx("y-table", showMulti && "y-table--multi", "y-budget-grid")}>
          <thead className="y-thead y-thead--sticky">
            {showMulti ? (
              <>
                <tr>
                  <th rowSpan={2} className="y-table-td--sticky-cat" ref={stickyCatThRef}>Category</th>
                  {resolvedVisibleMonths.map((m, idx) => {
                    const isThisMonth = m === todayMonth;
                    return (
                      <th
                        key={m}
                        ref={isThisMonth ? currentMonthThRef : undefined}
                        colSpan={3}
                        className={cx(
                          "y-table-th--month-label text-center y-month-head",
                          idx > 0 && "y-table-colgroup-divider",
                          isThisMonth && "y-table-th--month-current",
                          quickBudgetOpenMonth === m && "y-month-head--open"
                        )}
                      >
                        <span className="y-month-head-label">{formatMonthLong(m)}</span>
                        {onQuickBudget && (
                          <MonthQuickBudget
                            month={m}
                            values={quickBudgetByMonth?.[m]}
                            selectedCategory={selectedCategory}
                            onClearSelectedCategory={onClearSelectedCategory}
                            onQuickBudget={onQuickBudget}
                            open={quickBudgetOpenMonth === m}
                            onOpen={() => setQuickBudgetOpenMonth(m)}
                            onClose={() =>
                              setQuickBudgetOpenMonth((cur) => (cur === m ? null : cur))
                            }
                          />
                        )}
                      </th>
                    );
                  })}
                </tr>
                <tr className="y-thead-sub">
                  {resolvedVisibleMonths.map((m, idx) => {
                    const isThisMonth = m === todayMonth;
                    return (
                      <Fragment key={m}>
                        <th
                          className={cx(
                            "num text-right",
                            COL_A,
                            idx === 0 && "y-table-cell--month-first",
                            idx > 0 && "y-table-colgroup-divider",
                            isThisMonth && "y-thead-sub--current y-grid-col--current-first"
                          )}
                        >
                          Budgeted
                        </th>
                        <th className={cx("num text-right", COL_O, isThisMonth && "y-thead-sub--current")}>
                          Outflows
                        </th>
                        <th className={cx("num text-right", COL_V, isThisMonth && "y-thead-sub--current y-grid-col--current-last")}>
                          Balance
                        </th>
                      </Fragment>
                    );
                  })}
                </tr>
              </>
            ) : (
              <tr>
                <th className="y-table-td--sticky-cat">Category</th>
                <th className={cx("num", COL_A, isOnThisMonth && "y-thead-sub--current y-grid-col--current-first", "y-month-head y-month-head--single", quickBudgetOpenMonth === currentMonth && "y-month-head--open")}>
                  <span className="y-month-head-label">Budgeted</span>
                  {onQuickBudget && (
                    <MonthQuickBudget
                      month={currentMonth}
                      values={quickBudgetByMonth?.[currentMonth]}
                      selectedCategory={selectedCategory}
                      onClearSelectedCategory={onClearSelectedCategory}
                      onQuickBudget={onQuickBudget}
                      open={quickBudgetOpenMonth === currentMonth}
                      onOpen={() => setQuickBudgetOpenMonth(currentMonth)}
                      onClose={() =>
                        setQuickBudgetOpenMonth((cur) => (cur === currentMonth ? null : cur))
                      }
                    />
                  )}
                </th>
                <th className={cx("num", COL_O, isOnThisMonth && "y-thead-sub--current")}>Outflows</th>
                <th className={cx("num", COL_V, isOnThisMonth && "y-thead-sub--current y-grid-col--current-last")}>Balance</th>
              </tr>
            )}
          </thead>
          <tbody>
            {structureGroups.map((g, gi) => (
              <GroupBlock
                key={g.group.id}
                group={g}
                rowOffset={structureOffsets[gi] ?? 0}
                collapsed={!!collapsed[g.group.id]}
                onToggle={() => onToggleGroup(g.group.id)}
                onAssign={onAssign}
                currentMonth={currentMonth}
                visibleMonths={resolvedVisibleMonths}
                groupsByMonth={groupsByMonth}
                showMulti={showMulti}
                onAddCategory={() => onAddCategory(g.group.id)}
                onEditCategory={onEditCategory}
                onDeleteCategory={onDeleteCategory}
                onEditGroup={() => onEditGroup(g.group.id)}
                onDeleteGroup={onDeleteGroup}
                onReorderCategory={onReorderCategory}
                isDragOver={groupOverId === g.group.id}
                onDragStart={() => {
                  dragGroupId.current = g.group.id;
                }}
                onDragOver={() => setGroupOverId(g.group.id)}
                onDragLeave={() => setGroupOverId(null)}
                onDrop={() => handleGroupDrop(g.group.id)}
                quickFill={quickFill}
                selectedCategoryId={selectedCategoryId}
                onSelectCategory={onSelectCategory}
                todayMonth={todayMonth}
              />
            ))}
            {creditGroup && (
              <GroupBlock
                group={creditGroup}
                rowOffset={creditOffset}
                collapsed={!!collapsed[creditGroup.group.id]}
                onToggle={() => onToggleGroup(creditGroup.group.id)}
                onAssign={onAssign}
                currentMonth={currentMonth}
                visibleMonths={resolvedVisibleMonths}
                groupsByMonth={groupsByMonth}
                showMulti={showMulti}
                onAddCategory={() => onAddCategory(creditGroup.group.id)}
                onEditCategory={onEditCategory}
                onDeleteCategory={onDeleteCategory}
                onEditGroup={() => onEditGroup(creditGroup.group.id)}
                onDeleteGroup={onDeleteGroup}
                onReorderCategory={onReorderCategory}
                selectedCategoryId={selectedCategoryId}
                onSelectCategory={onSelectCategory}
                todayMonth={todayMonth}
              />
            )}
            {hiddenGroup && (
              <GroupBlock
                group={hiddenGroup}
                rowOffset={hiddenOffset}
                collapsed={isHiddenCollapsed}
                onToggle={() => onToggleGroup(hiddenGroup.group.id)}
                onAssign={onAssign}
                currentMonth={currentMonth}
                visibleMonths={resolvedVisibleMonths}
                groupsByMonth={groupsByMonth}
                showMulti={showMulti}
                onAddCategory={() => onAddCategory(hiddenGroup.group.id)}
                onEditCategory={onEditCategory}
                onDeleteCategory={onDeleteCategory}
                onEditGroup={() => onEditGroup(hiddenGroup.group.id)}
                onDeleteGroup={onDeleteGroup}
                onReorderCategory={onReorderCategory}
                selectedCategoryId={selectedCategoryId}
                onSelectCategory={onSelectCategory}
                todayMonth={todayMonth}
              />
            )}
            <tr className="y-table-filler" aria-hidden="true">
              <td colSpan={showMulti ? 1 + resolvedVisibleMonths.length * 3 : 4} />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------ month-count control */

function MonthCountControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const options = [1, 3, 6, 12];
  return (
    <div
      className="flex items-center overflow-hidden"
      role="group"
      aria-label="Months shown"
      style={{
        border: "1px solid var(--y-chrome-line)",
        borderRadius: 3,
        background: "linear-gradient(var(--y-chrome-top), var(--y-chrome-bot))",
      }}
    >
      {options.map((n, i) => {
        const active = n === value;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-pressed={active}
            aria-label={`${n} month${n === 1 ? "" : "s"}`}
            className={cx(
              "px-2 py-[3px] text-[11px] leading-none",
              i > 0 && "y-table-colgroup-divider"
            )}
            style={{
              border: 0,
              borderLeft: i > 0 ? "1px solid var(--y-chrome-line)" : "none",
              background: active ? "var(--y-master)" : "transparent",
              color: active ? "var(--y-ink)" : "var(--y-ink-soft)",
              fontWeight: active ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ quick budget per-month menu */

type QuickBudgetType = "lastMonth" | "spentLastMonth" | "avgBudgeted" | "clear";

function MonthQuickBudget({
  month,
  values,
  selectedCategory,
  onClearSelectedCategory,
  onQuickBudget,
  open,
  onOpen,
  onClose,
}: {
  month: string;
  values?: { lastMonth: number; spentLastMonth: number; avgBudgeted: number };
  selectedCategory?: { id: number; name: string } | null;
  onClearSelectedCategory?: () => void;
  onQuickBudget: (type: QuickBudgetType, categoryId?: number, month?: string) => void;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<"left" | "right">("right");

  // Pick the side with room: the 240px menu opens beside the month header,
  // flipping left when there is no room on the right. Room is measured
  // inside the nearest scrolling ancestor (the budget table's scroll
  // container, minus its scrollbar) — not the window — since that is what
  // actually clips the menu.
  const resolvePlace = useCallback(() => {
    const el = btnRef.current;
    if (!el || typeof window === "undefined") return;
    const rect = el.getBoundingClientRect();
    let clipLeft = 0;
    let clipRight = window.innerWidth;
    let node: HTMLElement | null = el.parentElement;
    while (node) {
      const style = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowX || "") || /(auto|scroll)/.test(style.overflow || "")) {
        const r = node.getBoundingClientRect();
        const scrollbar = Math.max(0, r.width - node.clientWidth);
        clipLeft = r.left;
        clipRight = r.right - scrollbar;
        break;
      }
      node = node.parentElement;
    }
    const need = 248; // 240px menu + 6px gap + margin
    const spaceRight = clipRight - rect.right;
    const spaceLeft = rect.left - clipLeft;
    setPlace(spaceRight >= need || spaceRight >= spaceLeft ? "right" : "left");
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", resolvePlace);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", resolvePlace);
    };
  }, [open, onClose, resolvePlace]);

  const label = formatMonthLong(month);
  const lastMonth = values?.lastMonth ?? 0;
  const spentLastMonth = values?.spentLastMonth ?? 0;
  const avgBudgeted = values?.avgBudgeted ?? 0;

  const choose = (type: QuickBudgetType) => {
    onQuickBudget(type, selectedCategory?.id, month);
    onClose();
  };

  return (
    <span ref={wrapRef} className={cx("y-month-qb", open && "is-open")}>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) onClose();
          else {
            resolvePlace();
            onOpen();
          }
        }}
        aria-label={`Quick budget options for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Quick Budget — ${label}`}
        data-testid={`quick-budget-trigger-${month}`}
        className="y-month-qb-btn"
      >
        <Icon name="dots" size={12} />
      </button>
      {open && (
        <span
          role="menu"
          aria-label={`Quick Budget for ${label}`}
          data-testid={`quick-budget-menu-${month}`}
          className={`y-dropdown y-month-qb-menu ${place === "left" ? "is-left" : "is-right"}`}
        >
          <span className="y-dropdown-group y-month-qb-scope">
            <span className="y-month-qb-scope-name">
              {selectedCategory ? selectedCategory.name : "Entire Budget"}
            </span>
            {selectedCategory && onClearSelectedCategory && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearSelectedCategory();
                }}
                className="y-month-qb-scope-clear"
                data-testid={`quick-budget-deselect-${month}`}
              >
                Entire Budget
              </button>
            )}
          </span>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose("lastMonth")}
            className="y-dropdown-item y-month-qb-item"
            title="Set budgeted amounts to last month's values"
            data-testid={`quick-budget-last-month-${month}`}
          >
            <span className="y-dropdown-item-label">Budgeted Last Month</span>
            <span className="y-num">{fmt(lastMonth)}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose("spentLastMonth")}
            className="y-dropdown-item y-month-qb-item"
            title="Set budgeted amounts to what was spent last month"
            data-testid={`quick-budget-spent-last-month-${month}`}
          >
            <span className="y-dropdown-item-label">Spent Last Month</span>
            <span className="y-num">{fmt(spentLastMonth)}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose("avgBudgeted")}
            className="y-dropdown-item y-month-qb-item"
            title="Set budgeted amounts to average budgeted over last 3 months"
            data-testid={`quick-budget-avg-budgeted-${month}`}
          >
            <span className="y-dropdown-item-label">Average Budgeted</span>
            <span className="y-num">{fmt(avgBudgeted)}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose("clear")}
            className="y-dropdown-item y-month-qb-item"
            title="Clear budgeted amounts to $0.00"
            data-testid={`quick-budget-clear-${month}`}
          >
            <span className="y-dropdown-item-label">Set to Zero</span>
            <span className="y-num">$0.00</span>
          </button>
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------ group block */

function GroupBlock({
  group,
  rowOffset,
  collapsed,
  onToggle,
  onAssign,
  currentMonth,
  visibleMonths,
  groupsByMonth,
  showMulti,
  onAddCategory,
  onEditCategory,
  onDeleteCategory,
  onEditGroup,
  onDeleteGroup,
  onReorderCategory,
  isDragOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  quickFill,
  selectedCategoryId,
  onSelectCategory,
  todayMonth,
}: {
  group: GroupRow;
  rowOffset?: number;
  collapsed: boolean;
  onToggle: () => void;
  onAssign: (catId: number, amount: number, month: string) => void;
  currentMonth: string;
  visibleMonths: string[];
  groupsByMonth: Map<number, GroupRow>[];
  showMulti: boolean;
  onAddCategory: () => void;
  onEditCategory: (catId: number) => void;
  onDeleteCategory: (catId: number) => void;
  onEditGroup: () => void;
  onDeleteGroup: (groupId: number) => void;
  onReorderCategory?: (id: number, sort: number) => void;
  isDragOver?: boolean;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
  quickFill?: CategoryMonthCellProps["quickFill"];
  selectedCategoryId?: number | null;
  onSelectCategory?: (id: number | null) => void;
  todayMonth?: string;
}) {
  const dragCatId = useRef<number | null>(null);
  const [catOverId, setCatOverId] = useState<number | null>(null);

  const gRow = group;
  const isSpecialGroup = group.group.isCreditCardPayments || isHiddenGroup(group.group);
  const isToday = (m: string) => m === (todayMonth ?? todayISO().slice(0, 7));

  return (
    <>
      <tr
        className={cx("y-master", isDragOver && !isSpecialGroup && "is-drop-target")}
        draggable={!isSpecialGroup && Boolean(onDrop)}
        onDragStart={(e) => {
          if (isSpecialGroup) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.effectAllowed = "move";
          onDragStart?.();
        }}
        onDragOver={(e) => {
          if (isSpecialGroup) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onDragOver?.();
        }}
        onDragLeave={onDragLeave}
        onDrop={(e) => {
          if (isSpecialGroup) return;
          e.preventDefault();
          onDrop?.();
        }}
      >
        <td className="y-table-td--sticky-cat">
          <div className="flex items-center gap-[7px]">
            <span className="flex items-center gap-[6px]">
              <span
                onClick={onToggle}
                className={cx("y-tri", !collapsed && "is-open", "cursor-pointer")}
                role="button"
                tabIndex={0}
                aria-label={`Toggle ${group.group.name} group`}
              />
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  if (isSpecialGroup) return;
                  onEditGroup();
                }}
                className={cx("cursor-text", !isSpecialGroup && "hover:underline")}
                style={{ color: "var(--y-ink)", fontSize: "12.5px" }}
                onKeyDown={(e) => {
                  if (isSpecialGroup) return;
                  if (e.key === "Enter" || e.key === " ") onEditGroup();
                }}
              >
                {group.group.name}
              </span>
            </span>
            <span className="y-group-actions">
              <button
                onClick={() => onAddCategory()}
                className="y-group-add-btn"
                aria-label="Add category"
                title="Add category"
              >
                <Icon name="plus" size={11} />
              </button>
            </span>
          </div>
        </td>
        {showMulti ? (
          visibleMonths.map((m, idx) => {
            const mg = groupsByMonth[idx]?.get(group.group.id);
            return (
              <MonthCells
                key={m}
                group={mg ?? gRow}
                isOtherMonth={m !== currentMonth}
                isFirstMonth={idx === 0}
                isRowForGroup
                isThisMonth={isToday(m)}
              />
            );
          })
        ) : (
          <>
            <td className={cx("num y-num text-right", COL_A, isToday(currentMonth) && "y-grid-col--current-first")}>{fmt(gRow.assigned)}</td>
            <td
              className={cx("num y-num text-right", COL_O)}
              style={{ color: gRow.outflow < 0 ? "var(--y-ink)" : "var(--y-ink-soft)" }}
            >
              {fmt(gRow.outflow)}
            </td>
            <td className={cx("num y-num text-right", COL_V, isToday(currentMonth) && "y-grid-col--current-last")} style={{ color: balanceColor(gRow.available) }}>
              {fmt(gRow.available)}
            </td>
          </>
        )}
      </tr>

      {!collapsed &&
        group.rows.map((r: CatRow, i: number) => {
          const isCatDropTarget = catOverId === r.category.id;
          const isSelected = selectedCategoryId === r.category.id;
          return (
            <tr
              key={r.category.id}
              data-cat-row
              className={cx(
                "y-row cursor-pointer",
                ((rowOffset ?? 0) + i) % 2 === 1 && "alt",
                isCatDropTarget && "is-drop-target",
                isSelected && "is-sel"
              )}
              onClick={() => onSelectCategory?.(isSelected ? null : r.category.id)}
              draggable={Boolean(onReorderCategory)}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = "move";
                dragCatId.current = r.category.id;
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                if (catOverId !== r.category.id) setCatOverId(r.category.id);
              }}
              onDragLeave={(e) => {
                e.stopPropagation();
                setCatOverId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const srcId = dragCatId.current;
                if (srcId == null || srcId === r.category.id || !onReorderCategory) return;
                const srcIdx = group.rows.findIndex((x) => x.category.id === srcId);
                const tgtIdx = group.rows.findIndex((x) => x.category.id === r.category.id);
                if (srcIdx === -1 || tgtIdx === -1) return;
                const reordered = [...group.rows];
                const [moved] = reordered.splice(srcIdx, 1);
                reordered.splice(tgtIdx, 0, moved!);
                reordered.forEach((row, i) => {
                  if (row.category.sort !== i) onReorderCategory(row.category.id, i);
                });
                dragCatId.current = null;
                setCatOverId(null);
              }}
            >
              <td className="y-table-td--sticky-cat pl-[24px]">
                <div className="flex items-center">
                  <span className="truncate">{r.category.name}</span>
                  <span className="y-cat-actions">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditCategory(r.category.id);
                      }}
                      className="y-cat-edit-btn"
                      aria-label={`Edit ${r.category.name}`}
                      title="Edit category"
                    >
                      <Icon name="edit" size={11} />
                    </button>
                  </span>
                </div>
              </td>
              {showMulti
                ? visibleMonths.map((m, idx) => {
                    const mg = groupsByMonth[idx]?.get(group.group.id);
                    const row = mg?.rows.find((x) => x.category.id === r.category.id);
                    return (
                      <MonthCells
                        key={m}
                        row={row ?? r}
                        isOtherMonth={m !== currentMonth}
                        isFirstMonth={idx === 0}
                        onAssign={(val) => onAssign(r.category.id, val, m)}
                        quickFill={quickFill}
                        categoryId={r.category.id}
                        isThisMonth={isToday(m)}
                      />
                    );
                  })
                : (
                  <>
                    <td className={cx("num", COL_A, isToday(currentMonth) && "y-grid-col--current-first")}>
                      <CategoryMonthCell
                        value={r.assigned}
                        onAssign={(val) => onAssign(r.category.id, val, currentMonth)}
                        quickFill={quickFill}
                        categoryId={r.category.id}
                        available={r.available}
                      />
                    </td>
                    <td
                      className={cx("num y-num", COL_O)}
                      style={{
                        color: r.outflow < 0 ? "var(--y-ink-soft)" : "var(--y-ink-faint)",
                      }}
                    >
                      {fmt(r.outflow)}
                    </td>
                    <td className={cx("num y-num", COL_V, isToday(currentMonth) && "y-grid-col--current-last")} style={{ color: balanceColor(r.available) }}>
                      {fmt(r.available)}
                      {r.available < 0 && r.category.overspendCarriesOver && (
                        <span
                          className="ml-1 text-red-600 font-bold"
                          title="Red Arrow to the Right: Overspending carries over to next month"
                          aria-label="Red arrow: carry over"
                        >
                          ➔
                        </span>
                      )}
                      {r.available < 0 && r.assigned > 0 && (
                        <button
                          type="button"
                          onClick={() => onAssign(r.category.id, 0, currentMonth)}
                          className="ml-1.5 text-[10px] underline cursor-pointer"
                          style={{ color: "var(--y-red)" }}
                          aria-label={`Unassign ${fmt(r.assigned)} from ${r.category.name}`}
                          title="Set assigned to 0"
                        >
                          Unassign {fmt(r.assigned)}
                        </button>
                      )}
                      {r.available < 0 && r.assigned === 0 && (
                        <span
                          className="ml-1.5 text-[10px]"
                          style={{ color: "var(--y-ink-faint)" }}
                          title={`This category has ${fmt(-r.outflow)} in outflows with $0 assigned. Assign more to cover it, or the overspending will be absorbed into next month's TBB.`}
                        >
                          overspent
                        </span>
                      )}
                    </td>
                  </>
                )}
            </tr>
          );
        })}
    </>
  );
}

/* ------------------------------------------------------------ month cells */

function MonthCells({
  group,
  row,
  isOtherMonth,
  isFirstMonth,
  isRowForGroup,
  onAssign,
  quickFill,
  categoryId,
  isThisMonth,
}: {
  group?: GroupRow;
  row?: CatRow;
  isOtherMonth: boolean;
  isFirstMonth: boolean;
  isRowForGroup?: boolean;
  onAssign?: (val: number) => void;
  quickFill?: CategoryMonthCellProps["quickFill"];
  categoryId?: number;
  isThisMonth?: boolean;
}) {
  const divCls = isFirstMonth ? "" : "y-table-colgroup-divider";
  const readOnlyCls = isOtherMonth ? "y-table-cell--readonly" : "";
  const firstCls = isThisMonth ? "y-grid-col--current-first" : "";
  const lastCls = isThisMonth ? "y-grid-col--current-last" : "";

  if (isRowForGroup && group) {
    return (
      <>
        <td className={cx("num y-num text-right", COL_A, divCls, readOnlyCls, firstCls)}>
          {fmt(group.assigned)}
        </td>
        <td
          className={cx("num y-num text-right", COL_O, readOnlyCls)}
          style={{
            color: !isOtherMonth && group.outflow < 0 ? "var(--y-ink)" : "var(--y-ink-soft)",
          }}
        >
          {fmt(group.outflow)}
        </td>
        <td className={cx("num y-num text-right", COL_V, lastCls)} style={{ color: balanceColor(group.available) }}>
          {fmt(group.available)}
        </td>
      </>
    );
  }

  if (!row) return <td colSpan={3} className={divCls} />;

  return (
    <>
      <td className={cx("num", COL_A, divCls, firstCls)}>
        {onAssign ? (
          <CategoryMonthCell
            value={row.assigned}
            onAssign={onAssign}
            quickFill={quickFill}
            categoryId={categoryId}
            available={row.available}
          />
        ) : (
          <span className={cx("y-num", readOnlyCls)}>{fmt(row.assigned)}</span>
        )}
      </td>
      <td
        className={cx("num y-num", COL_O, readOnlyCls)}
        style={{
          color: row.outflow < 0 ? "var(--y-ink-soft)" : "var(--y-ink-faint)",
        }}
      >
        {fmt(row.outflow)}
      </td>
      <td className={cx("num y-num", COL_V, lastCls)} style={{ color: balanceColor(row.available) }}>
        {fmt(row.available)}
        {row.available < 0 && row.category.overspendCarriesOver && (
          <span
            className="ml-1 text-red-600 font-bold"
            title="Red Arrow to the Right: Overspending carries over to next month"
            aria-label="Red arrow: carry over"
          >
            ➔
          </span>
        )}
      </td>
    </>
  );
}

/* ------------------------------------------------------------ inline amount cell */

type CategoryMonthCellProps = {
  value: number;
  onAssign: (v: number) => void;
  quickFill?: {
    lastMonthAssignments?: Map<number, number>;
    spentLastMonthByCategory?: Map<number, number>;
    avgSpentByCategory?: Map<number, number>;
    avgBudgetedByCategory?: Map<number, number>;
    underfundedByCategory?: Map<number, number>;
  };
  categoryId?: number;
  available?: number;
};

function CategoryMonthCell({
  value,
  onAssign,
  quickFill,
  categoryId,
}: CategoryMonthCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const v = evalAmount(draft);
    if (v != null) onAssign(dollarsToCents(v));
    setEditing(false);
  };

  const lastMonthVal =
    categoryId != null ? quickFill?.lastMonthAssignments?.get(categoryId) : undefined;

  if (editing) {
    return (
      <input
        ref={inputRef}
        size={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
        title={(() => {
          const n = evalAmount(draft);
          if (n == null || !Number.isFinite(n)) return undefined;
          if (!/[+\-*/]/.test(draft.replace(/^[+-]/, ""))) return undefined;
          return `= ${fmt(dollarsToCents(n))}`;
        })()}
        className="y-inline-amt"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setDraft((value / 100).toFixed(2));
        setEditing(true);
      }}
      className="y-inline-amt cursor-text"
      style={{ color: "var(--y-ink)" }}
      title={lastMonthVal != null ? `Last month: ${fmt(lastMonthVal)}` : undefined}
    >
      {fmt(value)}
    </button>
  );
}
