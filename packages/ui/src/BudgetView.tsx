"use client";

import { memo, useState, useMemo, Fragment } from "react";
import type { GroupRow, BudgetResult } from "@ynab/logic";
import {
  Icon,
  MonthNav,
  Button,
  Toolbar,
  ToolbarSep,
  Tooltip,
  cx,
} from "@ynab/theme";

import {
  formatMonthLong,
  isInternalGroup,
  isHiddenGroup,
  COL_A,
  COL_O,
  COL_V,
} from "./budgetViewHelpers.js";
import { MonthCountControl } from "./MonthCountControl.js";
import { MonthQuickBudget } from "./MonthQuickBudget.js";
import { GroupBlock } from "./GroupBlock.js";
import { useBudgetMonthScroll } from "./useBudgetMonthScroll.js";
import { useBudgetGroupReorder } from "./useBudgetGroupReorder.js";

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

  const [quickBudgetOpenMonth, setQuickBudgetOpenMonth] = useState<string | null>(null);
  const {
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
  } = useBudgetMonthScroll({
    showMulti,
    visibleMonths: resolvedVisibleMonths,
    currentMonth,
    canShiftRight,
    onShiftMonth,
  });

  const { groupDragProps } = useBudgetGroupReorder({
    groups: budget.groups,
    onReorderGroup,
  });

  const visibleGroups = budget.groups.filter((g) => !isInternalGroup(g.group));
  const totalCategories = visibleGroups.reduce((n, g) => n + g.rows.length, 0);
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
        <Tooltip tip={hasThisMonthInView ? "Current month is in view" : "Jump to current month"} side="bottom">
          <Button
            size="sm"
            variant={!hasThisMonthInView ? "blue" : "default"}
            onClick={() => {
              onSetMonth?.(todayMonth);
              scrollTodayIntoView();
            }}
            data-testid="today-btn"
            className={hasThisMonthInView ? "text-[var(--y-ink-soft)]" : ""}
          >
            <Icon name="calendar" size={11} color={!hasThisMonthInView ? "#fff" : "var(--y-ink-soft)"} /> Today
          </Button>
        </Tooltip>
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
        {totalCategories === 0 ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center"
            data-testid="budget-empty-state"
          >
            <div className="text-[14px] font-semibold" style={{ color: "var(--y-ink)" }}>
              No budget categories yet
            </div>
            <p className="max-w-[380px] text-[12px] leading-relaxed" style={{ color: "var(--y-ink-soft)" }}>
              Every dollar needs a job. Create a master category (like “Monthly Bills”),
              add categories inside it, then assign money to {formatMonthLong(currentMonth)}.
            </p>
            <Button size="sm" variant="primary" onClick={onAddGroup}>
              <Icon name="plus" size={11} /> Create your first category group
            </Button>
          </div>
        ) : (
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
                {...groupDragProps(g.group.id)}
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
        )}
      </div>
    </div>
  );
});
