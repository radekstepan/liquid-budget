"use client";

import { useId, useMemo, useState, useRef, useEffect, type ReactNode } from "react";
import type { BudgetData, Transaction } from "@ynab/logic";
import {
  fmt,
  MONTHS,
  monthLabel,
  parseMonthKey,
  computeSpendingTrends,
  getSpendingTransactions,
  type SpendingTrendsResult,
} from "@ynab/logic";
import { Button, Panel, Icon } from "@ynab/theme";
import {
  ChartTip,
  colorAt,
  fmtShort,
  niceTicks,
  symlog,
  symlogTicks,
  TipLabel,
  useElementSize,
} from "./chartUtils.js";
import { useLocalStorage } from "./useLocalStorage.js";

const GRID_LINE = "#e3e3df";
const AXIS_LINE = "#b6b6b1";

export function SpendingTrendsReport({
  data,
  startMonth,
  endMonth,
  activeCategoryIds: initialActiveCategoryIds,
}: {
  data: BudgetData;
  startMonth: string;
  endMonth: string;
  activeCategoryIds?: Set<number>;
}) {
  const gid = useId();
  const { ref: chartContainerRef, size } = useElementSize<HTMLDivElement>();

  // Scale mode (linear vs logarithmic)
  const [scaleMode, setScaleMode] = useLocalStorage<"linear" | "log">("ynab:reports:trendsScaleMode", "linear");

  // Drilldown hierarchy state
  const [drillGroupId, setDrillGroupId] = useState<number | null>(null);
  const [drillCategoryId, setDrillCategoryId] = useState<number | null>(null);

  // Selected month filter for transaction table (when drilled into a category or viewing month)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  // Hover state for chart
  const [hover, setHover] = useState<{
    monthIdx: number;
    segmentId?: number;
    x: number;
    y: number;
  } | null>(null);

  // Hovered constituent from the legend table
  const [hoverConstituentId, setHoverConstituentId] = useState<number | null>(null);

  // Category filter state — persisted in localStorage
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  // Initial set of all non-CC categories selected
  const allCategoryIds = useMemo(() => {
    const ccGroupIds = new Set(data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id));
    return new Set(data.categories.filter((c) => !ccGroupIds.has(c.groupId)).map((c) => c.id));
  }, [data.categories, data.groups]);

  const [persistedIds, setPersistedIds] = useLocalStorage<number[] | null>("ynab:reports:trendsActiveCategories", null);
  const [activeCategoryIds, setActiveCategoryIds] = useState<Set<number>>(() => {
    if (persistedIds != null) return new Set(persistedIds);
    return allCategoryIds;
  });

  // Sync to localStorage when activeCategoryIds changes
  useEffect(() => {
    const arr = Array.from(activeCategoryIds);
    setPersistedIds(arr);
  }, [activeCategoryIds, setPersistedIds]);

  // On mount, apply persisted filter; on category changes, prune removed categories
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (persistedIds != null) {
        const valid = persistedIds.filter((id) => allCategoryIds.has(id));
        if (valid.length > 0) {
          setActiveCategoryIds(new Set(valid));
          return;
        }
      }
    }
    setActiveCategoryIds((prev) => {
      const next = new Set<number>();
      for (const id of allCategoryIds) {
        if (prev.has(id)) next.add(id);
      }
      return next.size > 0 ? next : new Set(allCategoryIds);
    });
  }, [allCategoryIds]);

  // Close filter dropdown on outside click
  useEffect(() => {
    if (!filterOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [filterOpen]);

  // Compute spending trends data based on current drill & filter
  const trends: SpendingTrendsResult = useMemo(() => {
    return computeSpendingTrends(data, startMonth, endMonth, {
      drillGroupId,
      drillCategoryId,
      activeCategoryIds,
    });
  }, [data, startMonth, endMonth, drillGroupId, drillCategoryId, activeCategoryIds]);

  // Color mapping: assign a stable color to each constituent
  const colorMap = useMemo(() => {
    const map = new Map<number, string>();
    trends.constituents.forEach((c, idx) => {
      map.set(c.id, colorAt(idx));
    });
    return map;
  }, [trends.constituents]);

  // Transactions list for single-category drilldown or month filter
  const transactions: Transaction[] = useMemo(() => {
    if (trends.drillLevel !== "category" && !selectedMonth) return [];
    return getSpendingTransactions(data, startMonth, endMonth, {
      groupId: drillGroupId,
      categoryId: drillCategoryId,
      month: selectedMonth,
      activeCategoryIds,
    });
  }, [data, startMonth, endMonth, drillGroupId, drillCategoryId, selectedMonth, activeCategoryIds, trends.drillLevel]);

  const accountMap = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);

  // Chart layout calculations with dynamic scaling based on data width
  const chart = useMemo(() => {
    if (size.width === 0 || size.height === 0 || trends.months.length === 0) return null;

    const W = size.width;
    const H = Math.max(180, size.height);
    const padL = 58;
    const padR = 18;
    const padT = 16;
    const padB = 32;

    const innerW = Math.max(1, W - padL - padR);
    const innerH = Math.max(1, H - padT - padB);

    let ticks: number[];
    let y: (v: number) => number;
    let zeroY: number;

    if (scaleMode === "log") {
      const maxVal = Math.max(1000, trends.maxMonthSpend);
      const rawTicks = symlogTicks(0, maxVal);
      ticks = rawTicks.filter((t) => t >= 0);
      if (!ticks.includes(0)) ticks.unshift(0);

      const maxLog = symlog(maxVal);
      zeroY = padT + innerH;
      y = (v: number) => {
        if (v <= 0) return zeroY;
        const norm = maxLog > 0 ? symlog(v) / maxLog : 0;
        return padT + innerH * (1 - Math.min(1, Math.max(0, norm)));
      };
    } else {
      const maxVal = Math.max(100, trends.maxMonthSpend * 1.1);
      const rawTicks = niceTicks(0, maxVal, 4);
      ticks = rawTicks.filter((t) => t >= 0 && t <= maxVal * 1.05);
      if (!ticks.includes(0)) ticks.unshift(0);

      const maxTick = ticks[ticks.length - 1] || maxVal;
      y = (v: number) => padT + innerH * (1 - Math.min(1, Math.max(0, v / maxTick)));
      zeroY = y(0);
    }

    const n = trends.months.length;
    const colW = innerW / n;

    // Dynamic bar width and gap calculation: ensures clear visual gap between adjacent bars
    // whether showing 3 months or 144 months (12 years)
    let barW: number;
    if (colW >= 32) {
      barW = Math.min(42, Math.round(colW * 0.55));
    } else if (colW >= 14) {
      barW = Math.max(8, Math.round(colW * 0.65));
    } else if (colW >= 6) {
      barW = Math.max(3, Math.round(colW - 2));
    } else {
      barW = Math.max(1, Math.round(colW - 1));
    }

    const cornerRadius = Math.min(3, Math.max(1, Math.floor(barW / 3)));

    const monthBars = trends.months.map((mPoint, i) => {
      const cx = padL + colW * (i + 0.5);
      const barX = cx - barW / 2;

      const totalH = Math.max(0, zeroY - y(mPoint.total));
      const barTopY = zeroY - totalH;

      let currentBottom = zeroY;
      const renderedSegments = mPoint.segments.map((seg, sIdx) => {
        const segRatio = mPoint.total > 0 ? seg.amount / mPoint.total : 0;
        const segHeight = Math.max(0, totalH * segRatio);
        const segY = currentBottom - segHeight;
        currentBottom = segY;

        const color = colorMap.get(seg.id) ?? colorAt(sIdx);
        const isHovered =
          (hover?.monthIdx === i && (hover.segmentId == null || hover.segmentId === seg.id)) ||
          hoverConstituentId === seg.id;
        const isDimmed =
          (hover != null && (hover.monthIdx !== i || (hover.segmentId != null && hover.segmentId !== seg.id))) ||
          (hoverConstituentId != null && hoverConstituentId !== seg.id);

        return {
          id: seg.id,
          name: seg.name,
          amount: seg.amount,
          x: barX,
          y: segY,
          width: barW,
          height: segHeight,
          color,
          isHovered,
          isDimmed,
        };
      });

      return {
        month: mPoint.month,
        monthTotal: mPoint.total,
        totalH,
        barTopY,
        cx,
        barX,
        barW,
        colW,
        colX: padL + colW * i,
        segments: renderedSegments,
      };
    });

    const avgY = trends.avgPerMonth > 0 ? y(trends.avgPerMonth) : null;

    // Smart X-axis label stride calculation to prevent overlap over multi-year spans
    const maxLabels = Math.max(2, Math.min(10, Math.floor(innerW / 65)));
    const stride = n <= maxLabels ? 1 : Math.ceil((n - 1) / (maxLabels - 1));
    const tickIndices: number[] = [];
    for (let i = 0; i < n; i += stride) {
      tickIndices.push(i);
    }
    const lastIdx = n - 1;
    if (tickIndices.length > 0 && tickIndices[tickIndices.length - 1] !== lastIdx) {
      if (lastIdx - tickIndices[tickIndices.length - 1]! < Math.round(stride * 0.7)) {
        tickIndices[tickIndices.length - 1] = lastIdx;
      } else {
        tickIndices.push(lastIdx);
      }
    }
    const tickSet = new Set(tickIndices);

    return {
      W,
      H,
      padL,
      padR,
      padT,
      padB,
      innerW,
      innerH,
      y,
      zeroY,
      ticks,
      colW,
      barW,
      cornerRadius,
      n,
      monthBars,
      avgY,
      tickSet,
    };
  }, [size, trends, colorMap, hover, hoverConstituentId, scaleMode]);

  // Breadcrumb navigation handlers
  const handleGoToAll = () => {
    setDrillGroupId(null);
    setDrillCategoryId(null);
    setSelectedMonth(null);
    setHover(null);
  };

  const handleGoToGroup = () => {
    setDrillCategoryId(null);
    setSelectedMonth(null);
    setHover(null);
  };

  const handleDrillSegment = (constituentId: number) => {
    if (trends.drillLevel === "all") {
      setDrillGroupId(constituentId);
      setDrillCategoryId(null);
      setSelectedMonth(null);
      setHover(null);
    } else if (trends.drillLevel === "group") {
      setDrillCategoryId(constituentId);
      setSelectedMonth(null);
      setHover(null);
    }
  };

  // Hover tip content
  const tipContent: ReactNode | null = (() => {
    if (!hover) return null;
    const mPoint = trends.months[hover.monthIdx];
    if (!mPoint) return null;

    const { month0, year } = parseMonthKey(mPoint.month);
    const title = `${MONTHS[month0]} ${year}`;

    return (
      <div className="space-y-[3px]" style={{ minWidth: 140 }}>
        <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
          {title}
        </div>
        <div className="mb-1 text-[12px] font-bold text-white">
          Total: {fmt(mPoint.total)}
        </div>
        {mPoint.segments.length > 0 && (
          <div className="mt-1 border-t border-[rgba(255,255,255,0.15)] pt-1 space-y-[2px]">
            {mPoint.segments.map((s, idx) => {
              const color = colorMap.get(s.id) ?? colorAt(idx);
              const pct = mPoint.total > 0 ? `${Math.round((s.amount / mPoint.total) * 100)}%` : "0%";
              const isTarget = hover.segmentId === s.id;
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-2 text-[11px]"
                  style={{ fontWeight: isTarget ? 700 : 400 }}
                >
                  <TipLabel color={color} label={s.name} value={fmt(s.amount)} pct={pct} />
                </div>
              );
            })}
          </div>
        )}
        {trends.drillLevel !== "category" && mPoint.segments.length > 0 && (
          <div className="mt-1 text-[10px] text-[rgba(242,245,247,0.55)]">
            Click bar to drill down
          </div>
        )}
      </div>
    );
  })();

  const empty = trends.total === 0;

  // Filter helpers
  const handleToggleCategory = (catId: number) => {
    setActiveCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) {
        next.delete(catId);
      } else {
        next.add(catId);
      }
      return next;
    });
  };

  const handleToggleGroup = (groupId: number) => {
    const groupCatIds = data.categories.filter((c) => c.groupId === groupId).map((c) => c.id);
    const allSelected = groupCatIds.every((id) => activeCategoryIds.has(id));

    setActiveCategoryIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of groupCatIds) next.delete(id);
      } else {
        for (const id of groupCatIds) next.add(id);
      }
      return next;
    });
  };

  const handleSelectAllCategories = () => {
    setActiveCategoryIds(new Set(allCategoryIds));
  };

  const handleDeselectAllCategories = () => {
    setActiveCategoryIds(new Set());
  };

  // Group-specific filter helpers (when drilled into a group)
  const currentGroupCats = useMemo(() => {
    if (drillGroupId == null) return [];
    return data.categories.filter((c) => c.groupId === drillGroupId);
  }, [data.categories, drillGroupId]);

  const handleSelectCurrentGroupCats = () => {
    setActiveCategoryIds((prev) => {
      const next = new Set(prev);
      for (const c of currentGroupCats) next.add(c.id);
      return next;
    });
  };

  const handleClearCurrentGroupCats = () => {
    setActiveCategoryIds((prev) => {
      const next = new Set(prev);
      for (const c of currentGroupCats) next.delete(c.id);
      return next;
    });
  };

  // Filter button label
  const filterButtonLabel = useMemo(() => {
    if (trends.drillLevel === "group" && drillGroupId != null) {
      const activeGroupCount = currentGroupCats.filter((c) => activeCategoryIds.has(c.id)).length;
      return activeGroupCount === currentGroupCats.length
        ? "Categories: All"
        : `Categories: ${activeGroupCount}/${currentGroupCats.length}`;
    }
    return activeCategoryIds.size === allCategoryIds.size
      ? "Categories: All"
      : `Categories: ${activeCategoryIds.size}/${allCategoryIds.size}`;
  }, [trends.drillLevel, drillGroupId, currentGroupCats, activeCategoryIds, allCategoryIds]);

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
            <Button
              size="sm"
              variant="default"
              className="ml-2 h-[22px] px-2 text-[10.5px]"
              onClick={() => {
                if (trends.drillLevel === "category") handleGoToGroup();
                else handleGoToAll();
              }}
              title="Navigate up one level"
            >
              ↑ Up
            </Button>
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
              <button
                type="button"
                className={
                  "y-btn y-btn--sm " +
                  (scaleMode === "linear" ? "y-btn--primary is-on" : "")
                }
                onClick={() => setScaleMode("linear")}
                title="Linear scale"
              >
                Linear
              </button>
              <button
                type="button"
                className={
                  "y-btn y-btn--sm " +
                  (scaleMode === "log" ? "y-btn--primary is-on" : "")
                }
                onClick={() => setScaleMode("log")}
                title="Logarithmic scale"
              >
                Log
              </button>
            </div>
          </div>

          {trends.drillLevel !== "category" && (
            <div className="relative" ref={filterRef}>
              <Button
                size="sm"
                variant="default"
                onClick={() => setFilterOpen((o) => !o)}
                className="flex items-center gap-1.5 text-[11px]"
                title="Filter included categories"
              >
                <span>{filterButtonLabel}</span>
                <Icon name="chevronDown" size={10} />
              </Button>

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
          className="relative min-h-[220px] flex-[1.4] w-full border-b border-[var(--y-line-soft)]"
          style={{ background: "linear-gradient(#ffffff, #f7f7f4)" }}
          onMouseLeave={() => setHover(null)}
        >
          {empty && (
            <div className="grid h-full place-items-center y-hint text-[12px]">
              No spending data for this timeframe and filter selection.
            </div>
          )}

          {chart && !empty && (
            <svg width={chart.W} height={chart.H} className="overflow-visible select-none">
              <defs>
                {/* Individual clip paths around each whole composite bar */}
                {chart.monthBars.map((mBar, mIdx) => (
                  <clipPath key={`clip-${mIdx}`} id={`${gid}-bar-${mIdx}`}>
                    <rect
                      x={mBar.barX}
                      y={mBar.barTopY}
                      width={mBar.barW}
                      height={mBar.totalH}
                      rx={chart.cornerRadius}
                    />
                  </clipPath>
                ))}
              </defs>

              {/* Horizontal Grid lines and Y-axis Ticks */}
              {chart.ticks.map((t, i) => (
                <g key={i}>
                  <line
                    x1={chart.padL}
                    x2={chart.W - chart.padR}
                    y1={chart.y(t)}
                    y2={chart.y(t)}
                    stroke={GRID_LINE}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  <text
                    x={chart.padL - 8}
                    y={chart.y(t)}
                    fill="var(--y-ink-faint)"
                    fontSize={10}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="y-num"
                  >
                    {fmtShort(t)}
                  </text>
                </g>
              ))}

              {/* Zero baseline */}
              <line
                x1={chart.padL}
                x2={chart.W - chart.padR}
                y1={chart.zeroY}
                y2={chart.zeroY}
                stroke={AXIS_LINE}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />

              {/* Average reference dashed line (behind bars) */}
              {chart.avgY != null && chart.avgY >= chart.padT && chart.avgY <= chart.zeroY && (
                <line
                  x1={chart.padL}
                  x2={chart.W - chart.padR}
                  y1={chart.avgY}
                  y2={chart.avgY}
                  stroke="#8a99a8"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}

              {/* Stacked Bars */}
              {chart.monthBars.map((mBar, mIdx) => {
                const isMonthHovered = hover?.monthIdx === mIdx;
                const isMonthSelected = selectedMonth === mBar.month;

                return (
                  <g key={mBar.month}>
                    {/* Hover column background highlight */}
                    {(isMonthHovered || isMonthSelected) && (
                      <rect
                        x={mBar.colX}
                        y={chart.padT}
                        width={mBar.colW}
                        height={chart.innerH}
                        fill="rgba(47, 127, 176, 0.08)"
                        rx={2}
                      />
                    )}

                    {/* Stack segments wrapped in whole-bar clipPath for unified smooth rounded corners */}
                    <g clipPath={`url(#${gid}-bar-${mIdx})`}>
                      {mBar.segments.map((seg) => (
                        <g key={seg.id}>
                          <rect
                            x={seg.x}
                            y={seg.y}
                            width={seg.width}
                            height={Math.max(1, seg.height)}
                            fill={seg.color}
                            fillOpacity={seg.isDimmed ? 0.3 : seg.isHovered ? 1 : 0.88}
                            style={{
                              cursor: trends.drillLevel !== "category" ? "pointer" : "default",
                              transition: "fill-opacity 100ms",
                            }}
                            onMouseMove={(e) => {
                              setHover({
                                monthIdx: mIdx,
                                segmentId: seg.id,
                                x: e.clientX,
                                y: e.clientY,
                              });
                            }}
                            onClick={() => {
                              if (trends.drillLevel !== "category") {
                                handleDrillSegment(seg.id);
                              } else {
                                setSelectedMonth(selectedMonth === mBar.month ? null : mBar.month);
                              }
                            }}
                          />
                          {seg.y <= chart.padT + 1 && (
                            <>
                              <line
                                x1={seg.x + 1}
                                x2={seg.x + seg.width - 1}
                                y1={chart.padT + 4}
                                y2={chart.padT + 4}
                                stroke="rgba(0,0,0,0.35)"
                                strokeWidth={2}
                                strokeDasharray="3 2"
                                vectorEffect="non-scaling-stroke"
                              />
                              <line
                                x1={seg.x + 1}
                                x2={seg.x + seg.width - 1}
                                y1={chart.padT + 8}
                                y2={chart.padT + 8}
                                stroke="rgba(0,0,0,0.35)"
                                strokeWidth={2}
                                strokeDasharray="3 2"
                                vectorEffect="non-scaling-stroke"
                              />
                              <rect
                                x={seg.x}
                                y={chart.padT}
                                width={seg.width}
                                height={3}
                                rx={1}
                                fill={seg.color}
                                fillOpacity={0.7}
                              />
                            </>
                          )}
                        </g>
                      ))}
                    </g>

                    {/* Transparent overlay for full column click & hover */}
                    <rect
                      x={mBar.colX}
                      y={chart.padT}
                      width={mBar.colW}
                      height={chart.innerH}
                      fill="transparent"
                      style={{ cursor: "pointer" }}
                      onMouseMove={(e) => {
                        if (!hover || hover.monthIdx !== mIdx) {
                          setHover({
                            monthIdx: mIdx,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }
                      }}
                      onClick={() => {
                        if (trends.drillLevel === "category") {
                          setSelectedMonth(selectedMonth === mBar.month ? null : mBar.month);
                        } else if (mBar.segments.length === 1 && mBar.segments[0]) {
                          handleDrillSegment(mBar.segments[0].id);
                        }
                      }}
                    />

                    {/* Month X-Axis Label with smart stride */}
                    {chart.tickSet.has(mIdx) &&
                      (() => {
                        const { month0, year } = parseMonthKey(mBar.month);
                        const monthName = MONTHS[month0] ?? "";
                        let label: string;
                        if (chart.n <= 12) {
                          label = `${monthName} ${year}`;
                        } else if (chart.n <= 48) {
                          label = `${monthName} '${String(year).slice(2)}`;
                        } else {
                          label = `${year}`;
                        }

                        return (
                          <text
                            x={mBar.cx}
                            y={chart.H - chart.padB + 18}
                            fill={isMonthSelected ? "var(--y-blue)" : "var(--y-ink-soft)"}
                            fontWeight={isMonthSelected || isMonthHovered ? 700 : 400}
                            fontSize={10}
                            textAnchor="middle"
                            className="y-num cursor-pointer"
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              setSelectedMonth(selectedMonth === mBar.month ? null : mBar.month);
                            }}
                          >
                            {label}
                          </text>
                        );
                      })()}
                  </g>
                );
              })}

              {/* Foreground: Average text label (on top of bars, always readable with white halo) */}
              {chart.avgY != null && chart.avgY >= chart.padT && chart.avgY <= chart.zeroY && (
                <g pointerEvents="none">
                  <text
                    x={chart.W - chart.padR - 4}
                    y={chart.avgY - 5}
                    fill="#2d3340"
                    stroke="#ffffff"
                    strokeWidth={3}
                    strokeLinejoin="round"
                    paintOrder="stroke fill"
                    fontSize={9.5}
                    fontWeight={700}
                    textAnchor="end"
                    className="y-num"
                  >
                    Avg: {fmtShort(trends.avgPerMonth)}
                  </text>
                </g>
              )}
            </svg>
          )}

          <ChartTip x={hover?.x ?? null} y={hover?.y ?? null} content={tipContent} />
        </div>

        {/* Lower Panel: Breakdown List OR Transaction Register (when in single category) */}
        <div className="flex-1 min-h-0 overflow-y-auto y-scroll bg-white">
          {trends.drillLevel === "category" ? (
            /* Subcategory Transaction Detail Table with standard y-table and y-row.alt styling */
            <div className="flex flex-col h-full">
              <div className="y-subbar flex items-center justify-between px-3 py-1.5 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-[var(--y-ink)]">
                    {trends.currentCategoryName} Transactions
                  </span>
                  <span className="y-caps text-[var(--y-ink-faint)]">
                    {transactions.length} {transactions.length === 1 ? "entry" : "entries"}
                  </span>
                </div>

                {selectedMonth ? (
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-medium text-[var(--y-blue)]">
                      Showing: {monthLabel(selectedMonth)}
                    </span>
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => setSelectedMonth(null)}
                      title="Show all months"
                    >
                      Show All Months
                    </Button>
                  </div>
                ) : (
                  <span className="text-[11px] text-[var(--y-ink-faint)]">
                    Click any month bar to filter
                  </span>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-auto y-scroll">
                {transactions.length === 0 ? (
                  <div className="py-8 text-center y-hint text-[11.5px]">
                    No transactions found for this timeframe.
                  </div>
                ) : (
                  <table className="y-table">
                    <thead className="y-thead y-thead--sticky">
                      <tr>
                        <th style={{ width: 85 }}>Date</th>
                        <th>Payee</th>
                        <th style={{ width: 140 }}>Account</th>
                        <th>Memo</th>
                        <th className="num" style={{ width: 100 }}>
                          Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((t, idx) => (
                        <tr
                          key={t.id}
                          className={`y-row ${idx % 2 === 1 ? "alt" : ""}`}
                        >
                          <td className="font-mono whitespace-nowrap text-[11px] text-[var(--y-ink-soft)]">
                            {t.date}
                          </td>
                          <td className="font-medium text-[var(--y-ink)] truncate max-w-[200px]">
                            {t.payee || "—"}
                          </td>
                          <td className="text-[var(--y-ink-soft)] truncate max-w-[150px]">
                            {accountMap.get(t.accountId) ?? "Account"}
                          </td>
                          <td className="text-[var(--y-ink-faint)] truncate max-w-[200px]">
                            {t.memo || ""}
                          </td>
                          <td className="num font-semibold text-[var(--y-ink)] y-num whitespace-nowrap">
                            {fmt(Math.abs(Number(t.amount)))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : (
            /* Constituents Breakdown Table with cohesive y-table styling */
            <div className="flex flex-col h-full">
              {trends.constituents.length === 0 ? (
                <div className="py-8 text-center y-hint text-[11.5px]">
                  No spending recorded in this category for the selected timeframe.
                </div>
              ) : (
                <table className="y-table">
                  <thead className="y-thead y-thead--sticky">
                    <tr>
                      <th>
                        {trends.drillLevel === "all" ? "Master Category" : "Subcategory"}
                      </th>
                      <th className="num" style={{ width: 110 }}>
                        Average/Mo
                      </th>
                      <th className="num" style={{ width: 110 }}>
                        Total Spent
                      </th>
                      <th className="num" style={{ width: 80 }}>
                        % Share
                      </th>
                      <th style={{ width: 28 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {trends.constituents.map((c, idx) => {
                      const color = colorMap.get(c.id) ?? "#888";
                      const isHovered = hoverConstituentId === c.id;

                      return (
                        <tr
                          key={c.id}
                          className={`y-row ${idx % 2 === 1 ? "alt" : ""} ${isHovered ? "is-sel" : ""} cursor-pointer group`}
                          onMouseEnter={() => setHoverConstituentId(c.id)}
                          onMouseLeave={() => setHoverConstituentId(null)}
                          onClick={() => handleDrillSegment(c.id)}
                          title={`Click to drill down into ${c.name}`}
                        >
                          <td>
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className="inline-block h-3 w-3 shrink-0 rounded-sm"
                                style={{
                                  background: color,
                                  boxShadow:
                                    "inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(0,0,0,0.1)",
                                }}
                              />
                              <span className="truncate font-medium text-[var(--y-ink)]">
                                {c.name}
                              </span>
                            </div>
                          </td>
                          <td className="num y-num font-medium text-[var(--y-ink-soft)]">
                            {fmt(c.avgPerMonth)}
                          </td>
                          <td className="num y-num font-semibold text-[var(--y-ink)]">
                            {fmt(c.total)}
                          </td>
                          <td className="num y-num text-[var(--y-ink-faint)]">
                            {c.pctOfTotal}%
                          </td>
                          <td className="text-center text-[var(--y-blue)] opacity-0 group-hover:opacity-100">
                            <Icon name="chevronRight" size={10} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
