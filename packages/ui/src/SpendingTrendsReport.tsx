"use client";

import { useId, useMemo, useState, useRef, useEffect, useCallback, memo, type ReactNode } from "react";
import type { BudgetData, Transaction, SpendingTrendsConstituent } from "@ynab/logic";
import {
  fmt,
  num,
  MONTHS,
  monthLabel,
  parseMonthKey,
  computeSpendingTrends,
  getSpendingTransactions,
  type SpendingTrendsResult,
} from "@ynab/logic";
import { Button, Panel, Icon } from "@ynab/theme";
import {
  AxisBreakMark,
  AxisBreakMask,
  ChartTip,
  colorAt,
  computeOutlierBreak,
  fmtShort,
  niceTicks,
  NO_BREAK,
  symlog,
  symlogTicks,
  TipLabel,
  TRUNC_CAP_H,
  TRUNC_RATIO,
  TruncHatchPattern,
  TruncMarker,
  useElementSize,
  useRafThrottledSet,
  type OutlierBreak,
} from "./chartUtils.js";
import { useLocalStorage } from "./useLocalStorage.js";

const GRID_LINE = "#e3e3df";
const AXIS_LINE = "#b6b6b1";

interface SegmentLayout {
  id: number;
  name: string;
  amount: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

interface MonthBarLayout {
  month: string;
  monthTotal: number;
  totalH: number;
  barTopY: number;
  truncated: boolean;
  cx: number;
  barX: number;
  barW: number;
  colW: number;
  colX: number;
  segments: SegmentLayout[];
}

interface ChartLayout {
  W: number;
  H: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  innerW: number;
  innerH: number;
  y: (v: number) => number;
  zeroY: number;
  ticks: { v: number; grid: boolean }[];
  colW: number;
  barW: number;
  cornerRadius: number;
  n: number;
  monthBars: MonthBarLayout[];
  avgY: number | null;
  avgInBreak: boolean;
  hasBreak: boolean;
  posBreak: OutlierBreak | null;
  negBreak: OutlierBreak | null;
  tickSet: Set<number>;
}

const StaticChart = memo(function StaticChart({
  chart,
  gid,
  selectedMonth,
  trends,
  colorMap,
  onDrillSegment,
  onToggleMonth,
}: {
  chart: ChartLayout;
  gid: string;
  selectedMonth: string | null;
  trends: SpendingTrendsResult;
  colorMap: Map<number, string>;
  onDrillSegment: (id: number) => void;
  onToggleMonth: (month: string) => void;
}) {
  return (
    <svg width={chart.W} height={chart.H} className="overflow-visible select-none">
      <defs>
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
        <TruncHatchPattern id={`${gid}-hatch`} />
        {chart.hasBreak && (
          <AxisBreakMask
            maskId={`${gid}-break`}
            x1={chart.padL}
            x2={chart.W - chart.padR}
            breaks={[
              ...(chart.posBreak ? [{ y: chart.y(chart.posBreak.breakTop) }] : []),
              ...(chart.negBreak ? [{ y: chart.y(-chart.negBreak.breakTop) }] : []),
            ]}
          />
        )}
      </defs>

      {chart.ticks.map((t, i) => {
        const ty = chart.y(t.v);
        const inBreak =
          t.grid &&
          chart.hasBreak &&
          ((chart.posBreak && Math.abs(ty - chart.y(chart.posBreak.breakTop)) < 7) ||
            (chart.negBreak && Math.abs(ty - chart.y(-chart.negBreak.breakTop)) < 7));
        return (
          <g key={i}>
            {t.grid && !inBreak && (
              <line
                x1={chart.padL}
                x2={chart.W - chart.padR}
                y1={ty}
                y2={ty}
                stroke={GRID_LINE}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
            <text
              x={chart.padL - 8}
              y={ty}
              fill="var(--y-ink-faint)"
              fontSize={10}
              textAnchor="end"
              dominantBaseline="middle"
              className="y-num"
            >
              {fmtShort(t.v)}
            </text>
          </g>
        );
      })}

      <line
        x1={chart.padL}
        x2={chart.W - chart.padR}
        y1={chart.zeroY}
        y2={chart.zeroY}
        stroke={AXIS_LINE}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />

      {chart.avgY != null &&
        !chart.avgInBreak &&
        chart.avgY >= chart.padT &&
        chart.avgY <= chart.H - chart.padB && (
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

      <g mask={chart.hasBreak ? `url(#${gid}-break)` : undefined}>
        {chart.monthBars.map((mBar, mIdx) => {
        const isMonthSelected = selectedMonth === mBar.month;
        const isNeg = mBar.monthTotal < 0;

        return (
          <g key={mBar.month}>
            {isMonthSelected && (
              <rect
                x={mBar.colX}
                y={chart.padT}
                width={mBar.colW}
                height={chart.innerH}
                fill="rgba(47, 127, 176, 0.08)"
                rx={2}
              />
            )}

            <g clipPath={`url(#${gid}-bar-${mIdx})`}>
              {mBar.segments.map((seg, sIdx) => {
              const segTruncated = mBar.truncated && sIdx === mBar.segments.length - 1;
              return (
                <g key={seg.id}>
                  <rect
                    x={seg.x}
                    y={seg.y}
                    width={seg.width}
                    height={Math.max(1, seg.height)}
                    fill={seg.color}
                    fillOpacity={0.88}
                    onClick={() => {
                      if (trends.drillLevel !== "category") {
                        onDrillSegment(seg.id);
                      } else {
                        onToggleMonth(mBar.month);
                      }
                    }}
                  />
                  {segTruncated && (
                    <>
                      {chart.barW >= 8 ? (
                        <TruncMarker
                          x={seg.x}
                          y={isNeg ? mBar.barTopY + mBar.totalH : mBar.barTopY}
                          width={seg.width}
                          fill={seg.color}
                          hatchId={`url(#${gid}-hatch)`}
                          dir={isNeg ? "down" : "up"}
                          rx={chart.cornerRadius}
                        />
                      ) : (
                        <rect
                          data-testid="trunc-cap"
                          x={seg.x}
                          y={isNeg ? mBar.barTopY + mBar.totalH - TRUNC_CAP_H : mBar.barTopY}
                          width={seg.width}
                          height={TRUNC_CAP_H}
                          rx={1}
                          fill={seg.color}
                        />
                      )}
                    </>
                  )}
                </g>
              );
              })}
            </g>

            <rect
              x={mBar.colX}
              y={chart.padT}
              width={mBar.colW}
              height={chart.innerH}
              fill="transparent"
              onClick={() => {
                if (trends.drillLevel === "category") {
                  onToggleMonth(mBar.month);
                } else if (mBar.segments.length === 1 && mBar.segments[0]) {
                  onDrillSegment(mBar.segments[0].id);
                }
              }}
            />

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
                    fontWeight={isMonthSelected ? 700 : 400}
                    fontSize={10}
                    textAnchor="middle"
                    className="y-num cursor-pointer"
                    style={{ cursor: "pointer" }}
                    onClick={() => onToggleMonth(mBar.month)}
                  >
                    {label}
                  </text>
                );
              })()}
          </g>
        );
        })}
      </g>

      {chart.hasBreak && (
        <>
          {chart.posBreak && (
            <AxisBreakMark
              x1={chart.padL}
              x2={chart.W - chart.padR}
              y={chart.y(chart.posBreak.breakTop)}
            />
          )}
          {chart.negBreak && (
            <AxisBreakMark
              x1={chart.padL}
              x2={chart.W - chart.padR}
              y={chart.y(-chart.negBreak.breakTop)}
            />
          )}
        </>
      )}

      {chart.avgY != null && chart.avgY >= chart.padT && chart.avgY <= chart.H - chart.padB && (
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
  );
});

const ConstituentTable = memo(function ConstituentTable({
  constituents,
  colorMap,
  onDrill,
  drillLevel = "all",
}: {
  constituents: SpendingTrendsConstituent[];
  colorMap: Map<number, string>;
  onDrill: (id: number) => void;
  drillLevel?: "all" | "group" | "category";
}) {
  const [hoverId, setHoverId] = useState<number | null>(null);

  return (
    <table className="y-table">
      <thead className="y-thead y-thead--sticky">
        <tr>
          <th>{drillLevel === "group" ? "Category" : "Master Category"}</th>
          <th className="num" style={{ width: 110 }}>Average/Mo</th>
          <th className="num" style={{ width: 110 }}>Total Spent</th>
          <th className="num" style={{ width: 80 }}>% Share</th>
          <th style={{ width: 28 }}></th>
        </tr>
      </thead>
      <tbody>
        {constituents.map((c, idx) => {
          const color = colorMap.get(c.id) ?? "#888";
          const isHovered = hoverId === c.id;

          return (
            <tr
              key={c.id}
              className={`y-row ${idx % 2 === 1 ? "alt" : ""} ${isHovered ? "is-sel" : ""} cursor-pointer group`}
              onMouseEnter={() => setHoverId(c.id)}
              onMouseLeave={() => setHoverId(null)}
              onClick={() => onDrill(c.id)}
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
  );
});

const CategoryTransactionsTable = memo(function CategoryTransactionsTable({
  categoryName,
  transactions,
  selectedMonth,
  onClearMonth,
  accountMap,
  onSelectTransaction,
}: {
  categoryName: string | null | undefined;
  transactions: Transaction[];
  selectedMonth: string | null;
  onClearMonth: () => void;
  accountMap: Map<number, string>;
  onSelectTransaction?: (transaction: Transaction) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="y-subbar flex items-center justify-between px-3 py-1.5 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="font-bold text-[var(--y-ink)]">
            {categoryName} Transactions
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
              onClick={onClearMonth}
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
                  Spending
                </th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t, idx) => {
                const spend = -num(t.amount);
                return (
                  <tr
                    key={t.id}
                    className={`y-row ${idx % 2 === 1 ? "alt" : ""} cursor-pointer hover:bg-[var(--y-row-sel)]`}
                    onClick={() => onSelectTransaction?.(t)}
                    title={`Click to view transaction in ${accountMap.get(t.accountId) ?? "Account"}`}
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
                    <td
                      className={`num font-semibold y-num whitespace-nowrap ${
                        spend < 0 ? "text-[var(--y-green-dk)]" : "text-[var(--y-ink)]"
                      }`}
                    >
                      {fmt(spend)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
});

export function SpendingTrendsReport({
  data,
  startMonth,
  endMonth,
  activeCategoryIds: initialActiveCategoryIds,
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
    x: number;
    y: number;
  } | null>(null);

  // Reset drilldown when resetKey changes (e.g. clicking "Reports" in sidebar)
  useEffect(() => {
    setDrillGroupId(null);
    setDrillCategoryId(null);
    setSelectedMonth(null);
    setHover(null);
  }, [resetKey]);

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
    const H = size.height;
    const padL = 58;
    const padR = 18;
    const padT = 16;
    const padB = 32;

    const innerW = Math.max(1, W - padL - padR);
    const innerH = Math.max(1, H - padT - padB);

    const hasNegData = trends.minMonthSpend < 0;
    const hasPosData = trends.maxMonthSpend > 0;

    const isLog = scaleMode === "log";
    const posBreak = isLog
      ? NO_BREAK
      : computeOutlierBreak(trends.months.map((m) => m.total).filter((v) => v > 0));
    const negBreak = isLog
      ? NO_BREAK
      : computeOutlierBreak(trends.months.map((m) => -m.total).filter((v) => v > 0));
    const hasBreak = posBreak.hasBreak || negBreak.hasBreak;

    const MIN_SIDE = 0.22;
    let ticks: { v: number; grid: boolean }[];
    let y: (v: number) => number;
    let zeroY: number;

    const posTopVal = Math.max(1, trends.maxMonthSpend);
    const negTopVal = Math.max(1, Math.abs(trends.minMonthSpend));

    let posShare = hasNegData ? posTopVal / (posTopVal + negTopVal) : 1;
    if (hasNegData) {
      if (posShare < MIN_SIDE) posShare = MIN_SIDE;
      if (posShare > 1 - MIN_SIDE) posShare = 1 - MIN_SIDE;
    }
    zeroY = padT + innerH * posShare;

    const posNorm = (v: number) => {
      if (v <= 0) return 0;
      if (posBreak.hasBreak) {
        if (v <= posBreak.breakTop) return (v / posBreak.breakTop) * posBreak.split;
        return (
          posBreak.split +
          ((v - posBreak.breakTop) / (posBreak.topVal - posBreak.breakTop)) *
            (1 - posBreak.split)
        );
      }
      return v / posTopVal;
    };

    const negNorm = (d: number) => {
      if (d <= 0) return 0;
      if (negBreak.hasBreak) {
        if (d <= negBreak.breakTop) return (d / negBreak.breakTop) * negBreak.split;
        return (
          negBreak.split +
          ((d - negBreak.breakTop) / (negBreak.topVal - negBreak.breakTop)) *
            (1 - negBreak.split)
        );
      }
      return d / negTopVal;
    };

    if (isLog) {
      if (hasNegData) {
        const minVal = trends.minMonthSpend;
        const maxVal = trends.maxMonthSpend;
        const rawTicks = symlogTicks(minVal, maxVal);
        ticks = rawTicks.map((v) => ({ v, grid: true }));

        const minLog = symlog(Math.abs(minVal));
        const maxLog = symlog(Math.max(1000, maxVal));
        const totalLog = minLog + maxLog;
        let logPosShare = totalLog > 0 ? maxLog / totalLog : 0.5;
        if (logPosShare < MIN_SIDE) logPosShare = MIN_SIDE;
        if (logPosShare > 1 - MIN_SIDE) logPosShare = 1 - MIN_SIDE;

        zeroY = padT + innerH * logPosShare;
        y = (v: number) => {
          if (v > 0) {
            const norm = maxLog > 0 ? symlog(v) / maxLog : 0;
            return zeroY - (zeroY - padT) * Math.min(1, Math.max(0, norm));
          } else if (v < 0) {
            const norm = minLog > 0 ? symlog(Math.abs(v)) / minLog : 0;
            return zeroY + (padT + innerH - zeroY) * Math.min(1, Math.max(0, norm));
          }
          return zeroY;
        };
      } else {
        const maxVal = Math.max(1000, trends.maxMonthSpend);
        const rawTicks = symlogTicks(0, maxVal);
        ticks = rawTicks.filter((t) => t >= 0).map((v) => ({ v, grid: true }));
        if (!ticks.some((t) => t.v === 0)) ticks.unshift({ v: 0, grid: true });

        const maxLog = symlog(maxVal);
        zeroY = padT + innerH;
        y = (v: number) => {
          if (v <= 0) return zeroY;
          const norm = maxLog > 0 ? symlog(v) / maxLog : 0;
          return padT + innerH * (1 - Math.min(1, Math.max(0, norm)));
        };
      }
    } else if (hasBreak) {
      ticks = [];
      y = (v: number) => {
        if (v > 0) return zeroY - posNorm(v) * (zeroY - padT);
        if (v < 0) return zeroY + negNorm(-v) * (padT + innerH - zeroY);
        return zeroY;
      };

      if (posBreak.hasBreak) {
        for (const t of posBreak.ticks) ticks.push({ v: t, grid: true });
        ticks.push({ v: posBreak.topVal, grid: false });
      } else if (hasPosData) {
        const rawPosTicks = niceTicks(0, posTopVal * 1.1, 3).filter((t) => t > 0);
        for (const t of rawPosTicks) ticks.push({ v: t, grid: true });
      }

      ticks.push({ v: 0, grid: true });

      if (negBreak.hasBreak) {
        for (const t of negBreak.ticks) ticks.push({ v: -t, grid: true });
        ticks.push({ v: -negBreak.topVal, grid: false });
      } else if (hasNegData) {
        const rawNegTicks = niceTicks(-negTopVal * 1.1, 0, 3).filter((t) => t < 0);
        for (const t of rawNegTicks) ticks.push({ v: t, grid: true });
      }

      ticks.sort((a, b) => b.v - a.v);
    } else {
      // Linear scale without outlier break
      if (hasNegData) {
        const posPt = Math.max(100, trends.maxMonthSpend * 1.1);
        const negPt = Math.max(100, Math.abs(trends.minMonthSpend) * 1.1);
        let linearPosShare = posPt / (posPt + negPt);
        if (linearPosShare < MIN_SIDE) linearPosShare = MIN_SIDE;
        if (linearPosShare > 1 - MIN_SIDE) linearPosShare = 1 - MIN_SIDE;

        const posTop = padT;
        const posBot = padT + innerH * linearPosShare;
        const negBot = padT + innerH;
        zeroY = posBot;

        const rawPosTicks = niceTicks(0, posPt, 3);
        const posTicks = rawPosTicks.filter((t) => t > 0 && t <= posPt * 1.05);
        const maxPosTick = posTicks[posTicks.length - 1] ?? posPt;

        const rawNegTicks = niceTicks(-negPt, 0, 3);
        const negTicks = rawNegTicks.filter((t) => t < 0 && t >= -negPt * 1.05);
        const minNegTick = negTicks[0] ?? -negPt;

        ticks = [
          ...posTicks.map((v) => ({ v, grid: true })),
          { v: 0, grid: true },
          ...negTicks.map((v) => ({ v, grid: true })),
        ].sort((a, b) => b.v - a.v);

        y = (v: number) => {
          if (v > 0) {
            const norm = Math.min(1, Math.max(0, v / maxPosTick));
            return zeroY - (zeroY - posTop) * norm;
          } else if (v < 0) {
            const norm = Math.min(1, Math.max(0, Math.abs(v) / Math.abs(minNegTick)));
            return zeroY + (negBot - zeroY) * norm;
          }
          return zeroY;
        };
      } else {
        const maxVal = Math.max(100, trends.maxMonthSpend * 1.1);
        const rawTicks = niceTicks(0, maxVal, 4);
        ticks = rawTicks
          .filter((t) => t >= 0 && t <= maxVal * 1.05)
          .map((v) => ({ v, grid: true }));
        if (!ticks.some((t) => t.v === 0)) ticks.unshift({ v: 0, grid: true });

        const maxTick = ticks[ticks.length - 1]?.v || maxVal;
        y = (v: number) => padT + innerH * (1 - Math.min(1, Math.max(0, v / maxTick)));
        zeroY = y(0);
      }
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

    // Bars scale against the largest month so the tallest bar always reaches
    // the visual cap; the axis keeps its own ticks computed from maxMonthSpend.
    const barScaleMax = Math.max(1, trends.maxMonthSpend);
    const barScaleNegMax = Math.max(1, Math.abs(trends.minMonthSpend));
    const maxBarH = (zeroY - padT) * TRUNC_RATIO;
    const maxBarHNeg = (padT + innerH - zeroY) * TRUNC_RATIO;

    const monthBars = trends.months.map((mPoint, i) => {
      const cx = padL + colW * (i + 0.5);
      const barX = cx - barW / 2;
      const isNeg = mPoint.total < 0;
      const isPos = mPoint.total > 0;

      const useBreakBars = hasBreak;
      const truncated =
        !useBreakBars &&
        ((isPos && mPoint.total >= barScaleMax * TRUNC_RATIO) ||
          (isNeg && Math.abs(mPoint.total) >= barScaleNegMax * TRUNC_RATIO));

      let totalH = 0;
      let barTopY = zeroY;

      if (isPos) {
        if (useBreakBars) {
          totalH = Math.max(0, zeroY - y(mPoint.total));
        } else if (isLog) {
          const maxLog = symlog(Math.max(1000, barScaleMax));
          totalH = Math.max(0, (zeroY - padT) * (maxLog > 0 ? symlog(mPoint.total) / maxLog : 0));
        } else {
          totalH = Math.max(0, maxBarH * (mPoint.total / barScaleMax));
        }
        barTopY = zeroY - totalH;
      } else if (isNeg) {
        if (useBreakBars) {
          totalH = Math.max(0, y(mPoint.total) - zeroY);
        } else if (isLog) {
          const minLog = symlog(Math.max(1000, barScaleNegMax));
          totalH = Math.max(0, (padT + innerH - zeroY) * (minLog > 0 ? symlog(Math.abs(mPoint.total)) / minLog : 0));
        } else {
          totalH = Math.max(0, maxBarHNeg * (Math.abs(mPoint.total) / barScaleNegMax));
        }
        barTopY = zeroY;
      }

      const denom =
        mPoint.segments.reduce((acc, s) => acc + Math.abs(s.amount), 0) ||
        Math.abs(mPoint.total) ||
        1;

      let currentOffset = zeroY;
      const renderedSegments = mPoint.segments.map((seg, sIdx) => {
        const segRatio = Math.abs(seg.amount) / denom;
        const segHeight = Math.max(0, totalH * segRatio);

        let segY = zeroY;
        if (isPos) {
          segY = currentOffset - segHeight;
          currentOffset = segY;
        } else if (isNeg) {
          segY = currentOffset;
          currentOffset = segY + segHeight;
        }

        const color = colorMap.get(seg.id) ?? colorAt(sIdx);

        return {
          id: seg.id,
          name: seg.name,
          amount: seg.amount,
          x: barX,
          y: segY,
          width: barW,
          height: segHeight,
          color,
        };
      });

      return {
        month: mPoint.month,
        monthTotal: mPoint.total,
        totalH,
        barTopY,
        truncated,
        cx,
        barX,
        barW,
        colW,
        colX: padL + colW * i,
        segments: renderedSegments,
      };
    });

    const avgY = trends.avgPerMonth !== 0 ? y(trends.avgPerMonth) : null;
    const avgInBreak =
      hasBreak &&
      avgY != null &&
      ((posBreak.hasBreak && Math.abs(avgY - y(posBreak.breakTop)) < 7) ||
        (negBreak.hasBreak && Math.abs(avgY - y(-negBreak.breakTop)) < 7));

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
      avgInBreak,
      hasBreak,
      posBreak: posBreak.hasBreak ? posBreak : null,
      negBreak: negBreak.hasBreak ? negBreak : null,
      tickSet,
    };
  }, [size, trends, colorMap, scaleMode]);

  // Breadcrumb navigation handlers
  const handleGoToAll = useCallback(() => {
    setDrillGroupId(null);
    setDrillCategoryId(null);
    setSelectedMonth(null);
    setHover(null);
  }, []);

  const handleGoToGroup = useCallback(() => {
    setDrillCategoryId(null);
    setSelectedMonth(null);
    setHover(null);
  }, []);

  const handleClearMonth = useCallback(() => {
    setSelectedMonth(null);
  }, []);

  const handleDrillSegment = useCallback((constituentId: number) => {
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
  }, [trends.drillLevel]);

  const pushHover = useRafThrottledSet(setHover);

  const handleMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!chart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const idx = Math.max(0, Math.min(chart.n - 1, Math.floor((relX - chart.padL) / chart.colW)));
    pushHover({ monthIdx: idx, x: e.clientX, y: e.clientY });
  }, [chart, pushHover]);

  const handleMouseLeave = useCallback(() => setHover(null), []);

  const handleToggleMonth = useCallback((month: string) => {
    setSelectedMonth(prev => prev === month ? null : month);
  }, []);

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
        {mPoint.segments.length > 0 && (
          <div className="mt-1 border-t border-[rgba(255,255,255,0.15)] pt-1 space-y-[2px]">
            {mPoint.segments.map((s, idx) => {
              const color = colorMap.get(s.id) ?? colorAt(idx);
              const denom = Math.abs(mPoint.total);
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
        <div className="flex-1 min-h-0 overflow-y-auto y-scroll bg-white">
          {trends.drillLevel === "category" ? (
            <CategoryTransactionsTable
              categoryName={trends.currentCategoryName}
              transactions={transactions}
              selectedMonth={selectedMonth}
              onClearMonth={handleClearMonth}
              accountMap={accountMap}
              onSelectTransaction={onSelectTransaction}
            />
          ) : (
            /* Constituents Breakdown Table */
            <div className="flex flex-col h-full">
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
                />
              )}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
