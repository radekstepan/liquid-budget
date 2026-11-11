"use client";

import { memo } from "react";
import { MONTHS, parseMonthKey, type SpendingTrendsResult } from "@ynab/logic";
import {
  AxisBreakMark,
  AxisBreakMask,
  fmtShort,
  TruncHatchPattern,
  TruncMarker,
  TRUNC_CAP_H,
  type OutlierBreak,
} from "./chartUtils.js";

export const GRID_LINE = "#e3e3df";
export const AXIS_LINE = "#b6b6b1";

export interface SegmentLayout {
  id: number;
  name: string;
  amount: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  neg: boolean;
  truncated: boolean;
}

export interface MonthBarLayout {
  month: string;
  monthTotal: number;
  totalH: number;
  barTopY: number;
  cx: number;
  barX: number;
  barW: number;
  colW: number;
  colX: number;
  segments: SegmentLayout[];
}

export interface ChartLayout {
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

/** Pure SVG bar chart for spending trends (ui-split slice 6). No hooks:
 * layout is computed by `useSpendingTrendsLayout` (`chart` prop); all
 * interaction flows back through `onDrillSegment`/`onToggleMonth`. */
export const StaticChart = memo(function StaticChart({
  chart,
  gid,
  selectedMonth,
  trends,
  hoveredConstituentId,
  onDrillSegment,
  onToggleMonth,
}: {
  chart: ChartLayout;
  gid: string;
  selectedMonth: string | null;
  trends: SpendingTrendsResult;
  colorMap: Map<number, string>;
  hoveredConstituentId?: number | null;
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
              {mBar.segments.map((seg) => {
              const segTruncated = seg.truncated;
              const isDimmed = hoveredConstituentId != null && seg.id !== hoveredConstituentId;
              const isHighlight = hoveredConstituentId != null && seg.id === hoveredConstituentId;
              return (
                <g
                  key={seg.id}
                  style={{
                    opacity: isDimmed ? 0.2 : 1,
                    transition: "opacity 120ms ease",
                  }}
                >
                  <rect
                    x={seg.x}
                    y={seg.y}
                    width={seg.width}
                    height={Math.max(1, seg.height)}
                    fill={seg.color}
                    fillOpacity={isHighlight ? 1 : 0.88}
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
                          y={seg.neg ? seg.y + seg.height : seg.y}
                          width={seg.width}
                          fill={seg.color}
                          hatchId={`url(#${gid}-hatch)`}
                          dir={seg.neg ? "down" : "up"}
                          rx={chart.cornerRadius}
                        />
                      ) : (
                        <rect
                          data-testid="trunc-cap"
                          x={seg.x}
                          y={seg.neg ? seg.y + seg.height - TRUNC_CAP_H : seg.y}
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
