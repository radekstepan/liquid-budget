"use client";

import { useId, useCallback, type ReactNode } from "react";
import type { BudgetData, Transaction } from "@ynab/logic";
import { fmt, MONTHS, parseMonthKey } from "@ynab/logic";
import { Button, Panel, Icon, Tooltip } from "@ynab/theme";
import {
  ChartTip,
  colorAt,
  TipLabel,
  useRafThrottledSet,
} from "./chartUtils.js";
import { useLocalStorage } from "./useLocalStorage.js";
import { ConstituentTable, CategoryTransactionsTable } from "./SpendingTrendsTables.js";
import { StaticChart } from "./StaticChart.js";
import { useSpendingTrendsData } from "./useSpendingTrendsData.js";
import { useSpendingTrendsLayout } from "./useSpendingTrendsLayout.js";

export function SpendingTrendsReport({
  data,
  startMonth,
  endMonth,
  resetKey,
  onSelectTransaction,
}: {
  data: BudgetData;
  startMonth: string;
  endMonth: string;
  activeCategoryIds?: Set<number>;
  resetKey?: number;
  onSelectTransaction?: (transaction: Transaction) => void;
}) {
  const gid = useId();

  // Scale mode (linear vs logarithmic)
  const [scaleMode, setScaleMode] = useLocalStorage<"linear" | "log">(
    "ynab:reports:trendsScaleMode",
    "linear",
    (v): v is "linear" | "log" => v === "linear" || v === "log"
  );

  const {
    drillGroupId,
    selectedMonth,
    hover,
    setHover,
    hoveredConstituentId,
    setHoveredConstituentId,
    filterOpen,
    setFilterOpen,
    filterRef,
    activeCategoryIds,
    trends,
    colorMap,
    transactions,
    accountMap,
    currentGroupCats,
    filterButtonLabel,
    handleGoToAll,
    handleGoToGroup,
    handleClearMonth,
    handleDrillSegment,
    handleToggleMonth,
    handleToggleCategory,
    handleToggleGroup,
    handleSelectAllCategories,
    handleDeselectAllCategories,
    handleSelectCurrentGroupCats,
    handleClearCurrentGroupCats,
  } = useSpendingTrendsData({ data, startMonth, endMonth, resetKey });

  const { chartContainerRef, chart } = useSpendingTrendsLayout({
    trends,
    colorMap,
    scaleMode,
  });

  const pushHover = useRafThrottledSet(setHover);

  const handleMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!chart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const idx = Math.max(0, Math.min(chart.n - 1, Math.floor((relX - chart.padL) / chart.colW)));
    pushHover({ monthIdx: idx, x: e.clientX, y: e.clientY });
  }, [chart, pushHover]);

  const handleMouseLeave = useCallback(() => setHover(null), []);

  // Hover tip content
  const tipContent: ReactNode | null = (() => {
    if (!hover) return null;
    const mPoint = trends.months[hover.monthIdx];
    if (!mPoint) return null;

    const { month0, year } = parseMonthKey(mPoint.month);
    const title = `${MONTHS[month0]} ${year}`;
    const isWithdrawal = mPoint.total < 0;
    const totalLabel = isWithdrawal ? "Net withdrawal:" : "Total:";

    return (
      <div className="space-y-[3px]" style={{ minWidth: 140 }}>
        <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
          {title}
        </div>
        <div className="mb-1 text-[12px] font-bold text-white">
          {totalLabel} {fmt(mPoint.total)}
        </div>
        {mPoint.segments.length > 1 && (
          <div className="mt-1 border-t border-[rgba(255,255,255,0.15)] pt-1 space-y-[2px]">
            {mPoint.segments.map((s, idx) => {
              const color = colorMap.get(s.id) ?? colorAt(idx);
              const denom =
                mPoint.segments.reduce((acc, seg) => acc + Math.abs(seg.amount), 0) ||
                Math.abs(mPoint.total);
              const pct = denom > 0 ? `${Math.round((Math.abs(s.amount) / denom) * 100)}%` : "0%";
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <TipLabel color={color} label={s.name} value={fmt(s.amount)} pct={pct} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  })();

  const empty = !trends.months.some((m) => m.total !== 0);

  return (
    <Panel
      title="Spending Trends"
      className="flex h-full min-h-0 flex-col"
      bodyClass="flex min-h-0 flex-1 flex-col p-0"
    >
      {/* Top Controls & Navigation Bar */}
      <div
        className="flex flex-wrap items-center gap-3 border-b border-[var(--y-line-soft)] px-3 py-2 text-[11px]"
        style={{ background: "linear-gradient(#fbfbf9,#f1f1ee)" }}
      >
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-1.5 font-medium">
          <button
            type="button"
            className={
              "rounded px-1.5 py-0.5 transition-colors " +
              (trends.drillLevel === "all"
                ? "font-bold text-[var(--y-ink)] bg-[var(--y-bg-soft)]"
                : "text-[var(--y-blue)] hover:underline cursor-pointer")
            }
            onClick={handleGoToAll}
          >
            All Categories
          </button>

          {trends.currentGroupName && (
            <>
              <Icon name="chevronRight" size={10} color="var(--y-ink-faint)" />
              <button
                type="button"
                className={
                  "rounded px-1.5 py-0.5 transition-colors " +
                  (trends.drillLevel === "group"
                    ? "font-bold text-[var(--y-ink)] bg-[var(--y-bg-soft)]"
                    : "text-[var(--y-blue)] hover:underline cursor-pointer")
                }
                onClick={handleGoToGroup}
              >
                {trends.currentGroupName}
              </button>
            </>
          )}

          {trends.currentCategoryName && (
            <>
              <Icon name="chevronRight" size={10} color="var(--y-ink-faint)" />
              <span className="font-bold text-[var(--y-ink)] px-1.5 py-0.5 bg-[var(--y-bg-soft)] rounded">
                {trends.currentCategoryName}
              </span>
            </>
          )}

          {trends.drillLevel !== "all" && (
            <Tooltip tip="Navigate up one level">
              <Button
                size="sm"
                variant="default"
                className="ml-2 h-[22px] px-2 text-[10.5px]"
                onClick={() => {
                  if (trends.drillLevel === "category") handleGoToGroup();
                  else handleGoToAll();
                }}
              >
                ↑ Up
              </Button>
            </Tooltip>
          )}
        </div>

        {/* Math / Stats summary */}
        <div className="hidden sm:flex items-center gap-3 text-[11px] ml-4">
          <span style={{ color: "var(--y-ink-soft)" }}>
            Total: <span className="y-num font-semibold text-[var(--y-ink)]">{fmt(trends.total)}</span>
          </span>
          <span style={{ color: "var(--y-ink-faint)" }}>·</span>
          <span style={{ color: "var(--y-ink-soft)" }}>
            Avg: <span className="y-num font-semibold text-[var(--y-ink)]">{fmt(trends.avgPerMonth)}/mo</span>
          </span>
        </div>

        {/* Right side: Scale Toggle (Linear / Log) + Category Filter */}
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span
              className="y-caps text-[10px]"
              style={{ color: "var(--y-ink-faint)" }}
            >
              Scale
            </span>
            <div className="y-seg">
              <Tooltip tip="Linear scale">
                <button
                  type="button"
                  className={
                    "y-btn y-btn--sm " +
                    (scaleMode === "linear" ? "y-btn--primary is-on" : "")
                  }
                  onClick={() => setScaleMode("linear")}
                >
                  Linear
                </button>
              </Tooltip>
              <Tooltip tip="Logarithmic scale">
                <button
                  type="button"
                  className={
                    "y-btn y-btn--sm " +
                    (scaleMode === "log" ? "y-btn--primary is-on" : "")
                  }
                  onClick={() => setScaleMode("log")}
                >
                  Log
                </button>
              </Tooltip>
            </div>
          </div>

          {trends.drillLevel !== "category" && (
            <div className="relative" ref={filterRef}>
              <Tooltip tip="Filter included categories">
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => setFilterOpen((o) => !o)}
                  className="flex items-center gap-1.5 text-[11px]"
                  aria-label="Filter included categories"
                >
                  <span>{filterButtonLabel}</span>
                  <Icon name="chevronDown" size={10} />
                </Button>
              </Tooltip>

            {/* Category Filter Popover Menu */}
            {filterOpen && (
              <div
                className="absolute right-0 top-[calc(100%+4px)] z-50 w-[260px] rounded-[4px] border border-[var(--y-line)] bg-white p-2 shadow-lg"
                style={{ maxHeight: "380px", display: "flex", flexDirection: "column" }}
              >
                <div className="flex items-center justify-between border-b border-[var(--y-line-soft)] pb-1.5 mb-1.5">
                  <span className="text-[11px] font-bold text-[var(--y-ink)]">
                    {trends.drillLevel === "group"
                      ? `Filter: ${trends.currentGroupName}`
                      : "Filter Categories"}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="text-[10px] text-[var(--y-blue)] hover:underline cursor-pointer"
                      onClick={
                        trends.drillLevel === "group"
                          ? handleSelectCurrentGroupCats
                          : handleSelectAllCategories
                      }
                    >
                      Select All
                    </button>
                    <span className="text-[10px] text-[var(--y-ink-faint)]">·</span>
                    <button
                      type="button"
                      className="text-[10px] text-[var(--y-blue)] hover:underline cursor-pointer"
                      onClick={
                        trends.drillLevel === "group"
                          ? handleClearCurrentGroupCats
                          : handleDeselectAllCategories
                      }
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto y-scroll space-y-2 pr-1">
                  {trends.drillLevel === "group" && drillGroupId != null ? (
                    /* Show only subcategories belonging to current master category */
                    <div className="space-y-1">
                      {currentGroupCats.map((c) => (
                        <label
                          key={c.id}
                          className="flex items-center gap-1.5 text-[11px] text-[var(--y-ink-soft)] cursor-pointer hover:text-[var(--y-ink)] select-none px-1 py-0.5 rounded hover:bg-[var(--y-row-sel)]"
                        >
                          <input
                            type="checkbox"
                            checked={activeCategoryIds.has(c.id)}
                            onChange={() => handleToggleCategory(c.id)}
                            className="cursor-pointer rounded"
                          />
                          <span className="truncate">{c.name}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    /* Show all master categories and subcategories */
                    data.groups
                      .filter((g) => !g.isCreditCardPayments)
                      .map((g) => {
                        const groupCats = data.categories.filter((c) => c.groupId === g.id);
                        if (groupCats.length === 0) return null;
                        const allChecked = groupCats.every((c) => activeCategoryIds.has(c.id));
                        const someChecked = groupCats.some((c) => activeCategoryIds.has(c.id));

                        return (
                          <div key={g.id} className="space-y-1">
                            <div className="flex items-center gap-1.5 font-semibold text-[11px] text-[var(--y-ink)]">
                              <input
                                type="checkbox"
                                checked={allChecked}
                                ref={(el) => {
                                  if (el) el.indeterminate = someChecked && !allChecked;
                                }}
                                onChange={() => handleToggleGroup(g.id)}
                                className="cursor-pointer rounded"
                              />
                              <span
                                className="cursor-pointer select-none truncate"
                                onClick={() => handleToggleGroup(g.id)}
                              >
                                {g.name}
                              </span>
                            </div>
                            <div className="pl-4 space-y-0.5">
                              {groupCats.map((c) => (
                                <label
                                  key={c.id}
                                  className="flex items-center gap-1.5 text-[10.5px] text-[var(--y-ink-soft)] cursor-pointer hover:text-[var(--y-ink)] select-none"
                                >
                                  <input
                                    type="checkbox"
                                    checked={activeCategoryIds.has(c.id)}
                                    onChange={() => handleToggleCategory(c.id)}
                                    className="cursor-pointer rounded"
                                  />
                                  <span className="truncate">{c.name}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      {/* Main Body: Split between Chart (top) and Breakdown Table / Transaction Register (bottom) */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* SVG Chart Area */}
        <div
          ref={chartContainerRef}
          className="relative min-h-[220px] flex-[1.4] w-full overflow-hidden border-b border-[var(--y-line-soft)]"
          style={{ background: "linear-gradient(#ffffff, #f7f7f4)" }}
          onMouseMove={handleMove}
          onMouseLeave={handleMouseLeave}
        >
          {empty && (
            <div className="grid h-full place-items-center y-hint text-[12px]">
              No spending data for this timeframe and filter selection.
            </div>
          )}

          {chart && !empty && (
            <StaticChart
              chart={chart}
              gid={gid}
              selectedMonth={selectedMonth}
              trends={trends}
              colorMap={colorMap}
              hoveredConstituentId={hoveredConstituentId}
              onDrillSegment={handleDrillSegment}
              onToggleMonth={handleToggleMonth}
            />
          )}

          {/* Hover dashed vertical line overlay */}
          {hover && chart && (
            <svg
              width={chart.W}
              height={chart.H}
              className="absolute inset-0 overflow-visible pointer-events-none"
              style={{ top: 0, left: 0 }}
            >
              <line
                x1={chart.padL + chart.colW * (hover.monthIdx + 0.5)}
                x2={chart.padL + chart.colW * (hover.monthIdx + 0.5)}
                y1={chart.padT}
                y2={chart.H - chart.padB}
                stroke="var(--y-blue)"
                strokeOpacity={0.4}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                strokeDasharray="3 3"
              />
            </svg>
          )}

          <ChartTip x={hover?.x ?? null} y={hover?.y ?? null} content={tipContent} />
        </div>

        {/* Lower Panel: Breakdown List OR Transaction Register (when in single category) */}
        {trends.drillLevel === "category" ? (
          <div className="flex-1 min-h-0 flex flex-col bg-white">
            <CategoryTransactionsTable
              categoryName={trends.currentCategoryName}
              transactions={transactions}
              selectedMonth={selectedMonth}
              onClearMonth={handleClearMonth}
              accountMap={accountMap}
              onSelectTransaction={onSelectTransaction}
            />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto y-scroll bg-white">
            {trends.constituents.length === 0 ? (
              <div className="py-8 text-center y-hint text-[11.5px]">
                No spending recorded in this category for the selected timeframe.
              </div>
            ) : (
              <ConstituentTable
                constituents={trends.constituents}
                colorMap={colorMap}
                onDrill={handleDrillSegment}
                drillLevel={trends.drillLevel}
                overallTotal={trends.total}
                hoveredId={hoveredConstituentId}
                onHoverId={setHoveredConstituentId}
              />
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
