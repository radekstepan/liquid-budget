"use client";

import { useId, useMemo, useState, useCallback, memo } from "react";
import type { ReactNode } from "react";
import { computeTrendline, fmt, MONTHS, monthLabel, parseMonthKey, type SurplusMonthPoint } from "@ynab/logic";
import { Button, Panel, Tooltip } from "@ynab/theme";
import {
  AxisBreakMark,
  AxisBreakMask,
  ChartTip,
  computeOutlierBreak,
  fmtShort,
  niceTicks,
  NO_BREAK,
  symlog,
  symlogTicks,
  TipLabel,
  TruncHatchPattern,
  useElementSize,
  useRafThrottledSet,
  type OutlierBreak,
} from "./chartUtils.js";
import { useLocalStorage } from "./useLocalStorage.js";

export type { SurplusMonthPoint };

const AXIS_LINE = "#b6b6b1";
const GRID = "#dcdcd8";

const SURPLUS_COLOR = "#3d8b4f";
const LOSS_COLOR = "#c0483a";
const AVG_COLOR = "#8a99a8";
// Warm ochre from the shared chart palette: distinct from the green/red bars
// and the grey average line.
const TREND_COLOR = "#c07d1c";

interface SurplusChartLayout {
  W: number;
  H: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  innerW: number;
  innerH: number;
  y: (v: number) => number;
  hasBreak: boolean;
  posBreak: OutlierBreak | null;
  negBreak: OutlierBreak | null;
  zeroY: number;
  ticks: { v: number; grid: boolean }[];
  barW: number;
  n: number;
  xAt: (i: number) => number;
  colW: number;
  avg: number;
  avgY: number;
  /** Least-squares fitted value per month index, or null when < 2 months. */
  trend: number[] | null;
}

// Static SVG content: grid, bars, labels. Excluded from hover re-renders.
const SurplusStaticChart = memo(function SurplusStaticChart({
  chart,
  points,
  gid,
  showTrend,
}: {
  chart: SurplusChartLayout;
  points: SurplusMonthPoint[];
  gid: string;
  showTrend: boolean;
}) {
  const trendEnd = chart.trend != null && chart.trend.length >= 2
    ? chart.trend[chart.trend.length - 1]
    : undefined;
  return (
    <svg width={chart.W} height={chart.H}>
      <defs>
        <linearGradient id={`${gid}-surplus-grad`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={SURPLUS_COLOR} stopOpacity={0.85} />
          <stop offset="100%" stopColor={SURPLUS_COLOR} stopOpacity={0.45} />
        </linearGradient>
        <linearGradient id={`${gid}-loss-grad`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={LOSS_COLOR} stopOpacity={0.45} />
          <stop offset="100%" stopColor={LOSS_COLOR} stopOpacity={0.85} />
        </linearGradient>
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
                stroke={GRID}
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

      {/* Bars — masked to cut a transparent break band through outliers */}
      <g mask={chart.hasBreak ? `url(#${gid}-break)` : undefined}>
        {points.map((p, i) => {
          const x = chart.xAt(i);
          const barX = x - chart.barW / 2;
          if (p.surplus > 0) {
            const barTop = chart.y(p.surplus);
            return (
              <rect
                key={p.month}
                x={barX}
                y={barTop}
                width={chart.barW}
                height={Math.max(1, chart.zeroY - barTop)}
                rx={1.5}
                fill={`url(#${gid}-surplus-grad)`}
                stroke={SURPLUS_COLOR}
                strokeOpacity={0.2}
                vectorEffect="non-scaling-stroke"
              />
            );
          }
          if (p.surplus < 0) {
            const barBottom = chart.y(p.surplus);
            return (
              <rect
                key={p.month}
                x={barX}
                y={chart.zeroY}
                width={chart.barW}
                height={Math.max(1, barBottom - chart.zeroY)}
                rx={1.5}
                fill={`url(#${gid}-loss-grad)`}
                stroke={LOSS_COLOR}
                strokeOpacity={0.2}
                vectorEffect="non-scaling-stroke"
              />
            );
          }
          return null;
        })}
        {/* Trendline lives inside the same mask so an axis break cuts it
            exactly where it cuts the bars. One segment per month keeps it
            correct under the log scale and break-zone mappings too. */}
        {showTrend && chart.trend && chart.trend.length >= 2 && (
          <>
            <polyline
              data-testid="trendline"
              points={chart.trend.map((v, i) => `${chart.xAt(i)},${chart.y(v)}`).join(" ")}
              fill="none"
              stroke={TREND_COLOR}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {/* Month dots on the trendline, like the Net Worth line dots. */}
            {chart.trend.map((v, i) => (
              <circle
                key={`trend-pt-${i}`}
                data-testid="trendline-dot"
                cx={chart.xAt(i)}
                cy={chart.y(v)}
                r={2.5}
                fill={TREND_COLOR}
              />
            ))}
          </>
        )}
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

      {chart.avgY >= chart.padT && chart.avgY <= chart.H - chart.padB && (
        <>
          <line
            x1={chart.padL}
            x2={chart.W - chart.padR}
            y1={chart.avgY}
            y2={chart.avgY}
            stroke={AVG_COLOR}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
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
            Avg: {fmtShort(chart.avg)}
          </text>
        </>
      )}

      {showTrend && trendEnd !== undefined && (
        <text
          x={chart.W - chart.padR - 4}
          y={chart.y(trendEnd) - 6}
          fill={TREND_COLOR}
          stroke="#ffffff"
          strokeWidth={3}
          strokeLinejoin="round"
          paintOrder="stroke fill"
          fontSize={9.5}
          fontWeight={700}
          textAnchor="end"
          className="y-num"
        >
          Trend
        </text>
      )}

      {points.map((p, i) => {
        const maxTicks = Math.max(2, Math.min(12, Math.floor(chart.innerW / 65)));
        if (chart.n > maxTicks) {
          const stride = Math.ceil((chart.n - 1) / (maxTicks - 1));
          const isLast = i === chart.n - 1;
          if (i % stride !== 0 && !isLast) return null;
        }
        const { month0, year } = parseMonthKey(p.month);
        const label = `${MONTHS[month0] ?? ""} ${year}`;
        return (
          <text
            key={`lbl-${p.month}`}
            x={chart.xAt(i)}
            y={chart.H - chart.padB + 18}
            fill="var(--y-ink-soft)"
            fontSize={10}
            textAnchor="middle"
            className="y-num"
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
});

export function SurplusReport({ points }: { points: SurplusMonthPoint[] }) {
  const gid = useId();
  const { ref, size } = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [scaleMode, setScaleMode] = useLocalStorage<"linear" | "log">(
    "ynab:reports:scaleMode",
    "linear",
    (v): v is "linear" | "log" => v === "linear" || v === "log"
  );
  // Persisted like the sibling report toggles; off by default.
  const [showTrend, setShowTrend] = useLocalStorage<boolean>(
    "ynab:reports:cashFlowTrendline",
    false,
    (v): v is boolean => typeof v === "boolean"
  );

  const chart = useMemo(() => {
    if (size.width === 0 || size.height === 0 || points.length === 0) return null;
    const W = size.width;
    const H = size.height;
    const padL = 64;
    const padR = 18;
    const padT = 16;
    const padB = 34;
    const innerW = Math.max(1, W - padL - padR);
    const innerH = Math.max(1, H - padT - padB);

    const isLog = scaleMode === "log";
    // Same extreme-capping as Spending Trends / Net Worth: Tukey-fence
    // outliers get a compressed axis zone with a zigzag break mark.
    const posBreak = isLog ? NO_BREAK : computeOutlierBreak(points.map((p) => p.surplus));
    const negBreak = isLog ? NO_BREAK : computeOutlierBreak(points.map((p) => -p.surplus));
    const hasBreak = posBreak.hasBreak || negBreak.hasBreak;

    let maxVal = 1;
    let minVal = 0;
    for (const p of points) {
      if (p.surplus > maxVal) maxVal = p.surplus;
      if (p.surplus < minVal) minVal = p.surplus;
    }

    const posTopVal = Math.max(1, maxVal);
    const negTopVal = Math.max(1, -minVal);
    const fracZero =
      Math.max(1, maxVal) / (Math.max(1, maxVal) + Math.max(1, -minVal));
    let zeroY = padT + innerH * (1 - fracZero);

    const posNorm = (v: number) => {
      if (v <= 0) return 0;
      if (posBreak.hasBreak) {
        if (v <= posBreak.breakTop) return (v / posBreak.breakTop) * posBreak.split;
        return posBreak.split + ((v - posBreak.breakTop) / (posBreak.topVal - posBreak.breakTop)) * (1 - posBreak.split);
      }
      return v / posTopVal;
    };
    const negNorm = (d: number) => {
      if (d <= 0) return 0;
      if (negBreak.hasBreak) {
        if (d <= negBreak.breakTop) return (d / negBreak.breakTop) * negBreak.split;
        return negBreak.split + ((d - negBreak.breakTop) / (negBreak.topVal - negBreak.breakTop)) * (1 - negBreak.split);
      }
      return d / negTopVal;
    };

    let y: (v: number) => number;
    let ticks: { v: number; grid: boolean }[];

    if (isLog) {
      const rawTicks = symlogTicks(minVal, maxVal);
      const filtered = rawTicks.filter((t) => t >= minVal && t <= maxVal);
      if (!filtered.includes(0) && minVal <= 0 && maxVal >= 0) {
        filtered.push(0);
        filtered.sort((a, b) => a - b);
      }
      ticks = filtered.map((v) => ({ v, grid: true }));
      const sMin = symlog(minVal);
      const sMax = symlog(maxVal);
      const sRange = sMax - sMin || 1;
      y = (v) => padT + innerH * (1 - (symlog(v) - sMin) / sRange);
      zeroY = y(0);
    } else if (hasBreak) {
      ticks = [];
      y = (v: number) => {
        if (v > 0) return zeroY - posNorm(v) * (zeroY - padT);
        if (v < 0) return zeroY + negNorm(-v) * (H - padB - zeroY);
        return zeroY;
      };
      if (posBreak.hasBreak) {
        for (const t of posBreak.ticks) ticks.push({ v: t, grid: true });
        ticks.push({ v: posBreak.topVal, grid: false });
      } else {
        for (const t of niceTicks(0, posTopVal, 4)) {
          if (t > 0) ticks.push({ v: t, grid: true });
        }
      }
      if (negBreak.hasBreak) {
        for (const t of negBreak.ticks) ticks.push({ v: -t, grid: true });
        ticks.push({ v: -negBreak.topVal, grid: false });
      } else {
        for (const t of niceTicks(0, negTopVal, 4)) {
          if (t > 0) ticks.push({ v: -t, grid: true });
        }
      }
      ticks.push({ v: 0, grid: true });
      ticks.sort((a, b) => a.v - b.v);
    } else {
      const rawTicks = niceTicks(minVal, maxVal);
      if (!rawTicks.includes(0) && minVal <= 0 && maxVal >= 0) {
        rawTicks.push(0);
        rawTicks.sort((a, b) => a - b);
      }
      ticks = rawTicks.map((v) => ({ v, grid: true }));
      y = (v) => {
        const range = maxVal - minVal || 1;
        return padT + innerH * (1 - (v - minVal) / range);
      };
      zeroY = y(0);
    }

    const n = points.length;
    const colW = innerW / Math.max(1, n);
    const xAt = (i: number) => padL + colW * (i + 0.5);
    const barW = Math.max(4, Math.min(48, colW * 0.55));

    const avg = Math.round(points.reduce((s, p) => s + p.surplus, 0) / Math.max(1, n));
    const avgY = y(avg);

    const trend = computeTrendline(points.map((p) => p.surplus))?.fitted ?? null;

    return {
      W, H, padL, padR, padT, padB, innerW, innerH, y, hasBreak,
      posBreak: posBreak.hasBreak ? posBreak : null,
      negBreak: negBreak.hasBreak ? negBreak : null,
      zeroY, ticks, barW, n, xAt, colW, avg, avgY, trend,
    };
  }, [size, points, scaleMode]);

  const empty = points.length === 0;

  const tipContent: ReactNode | null = (() => {
    if (hover == null) return null;
    const p = points[hover.idx];
    if (!p) return null;
    // Trend value for the hovered month only: silent when the toggle is off
    // or the fit is not computable (chart.trend is null with < 2 months).
    const trendVal = showTrend ? chart?.trend?.[hover.idx] : undefined;
    return (
      <div className="space-y-[3px]">
        <div className="text-[11px] font-bold mb-1" style={{ color: "#f2f5f7" }}>
          {monthLabel(p.month)}
        </div>
        <TipLabel dot={false} color={SURPLUS_COLOR} label="Income" value={fmt(p.income)} />
        <TipLabel dot={false} color={LOSS_COLOR} label="Outflow" value={fmt(p.outflow)} />
        <div
          data-testid="tip-divider"
          aria-hidden="true"
          style={{ borderTop: "1px solid rgba(255,255,255,0.16)", margin: "6px 0 3px" }}
        />
        <TipLabel
          color={p.surplus >= 0 ? SURPLUS_COLOR : LOSS_COLOR}
          label={p.surplus >= 0 ? "Surplus" : "Loss"}
          value={fmt(p.surplus)}
        />
        {trendVal !== undefined && (
          <TipLabel color={TREND_COLOR} label="Trend" value={fmt(trendVal)} />
        )}
      </div>
    );
  })();

  const pushHover = useRafThrottledSet(setHover);

  const handleMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!chart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const idx = Math.max(0, Math.min(chart.n - 1, Math.floor((relX - chart.padL) / chart.colW)));
    pushHover({ idx, x: e.clientX, y: e.clientY });
  }, [chart, pushHover]);

  const handleMouseLeave = useCallback(() => setHover(null), []);

  const trendAvailable = points.length >= 2;

  return (
    <Panel
      title="Monthly Cash Flow"
      className="flex h-full min-h-0 flex-col"
      bodyClass="flex min-h-0 flex-1 flex-col p-0"
    >
      <div className="flex items-center gap-4 border-b border-[var(--y-line-soft)] px-3 py-2 text-[11px]"
        style={{ background: "linear-gradient(#fbfbf9,#f1f1ee)" }}>
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SURPLUS_COLOR, opacity: 0.7 }} />
          <span style={{ color: "var(--y-ink-soft)" }}>Surplus</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: LOSS_COLOR, opacity: 0.7 }} />
          <span style={{ color: "var(--y-ink-soft)" }}>Loss</span>
        </span>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span
              className="y-caps text-[10px]"
              style={{ color: "var(--y-ink-faint)" }}
            >
              Trend
            </span>
            <Tooltip
              tip={
                trendAvailable
                  ? "Least-squares trend line over the visible months"
                  : "Trend line needs at least 2 months of data"
              }
            >
              <Button
                size="sm"
                variant={showTrend ? "primary" : "default"}
                active={showTrend}
                disabled={!trendAvailable}
                onClick={() => setShowTrend(!showTrend)}
              >
                {showTrend ? "On" : "Off"}
              </Button>
            </Tooltip>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="y-caps text-[10px]"
              style={{ color: "var(--y-ink-faint)" }}
            >
              Scale
            </span>
            <div className="y-seg">
              <Tooltip tip="Linear scale">
                <Button
                  size="sm"
                  variant={scaleMode === "linear" ? "primary" : "default"}
                  active={scaleMode === "linear"}
                  onClick={() => setScaleMode("linear")}
                >
                  Linear
                </Button>
              </Tooltip>
              <Tooltip tip="Logarithmic scale">
                <Button
                  size="sm"
                  variant={scaleMode === "log" ? "primary" : "default"}
                  active={scaleMode === "log"}
                  onClick={() => setScaleMode("log")}
                >
                  Log
                </Button>
              </Tooltip>
            </div>
          </div>
          <span className="y-hint">Hover any month for details</span>
        </div>
      </div>

      <div
        ref={ref}
        className="relative min-h-0 flex-1 w-full"
        onMouseMove={handleMove}
        onMouseLeave={handleMouseLeave}
        style={{ background: "linear-gradient(#ffffff, #f7f7f4)" }}
      >
        {empty && (
          <div className="grid h-full place-items-center y-hint">No data for this timeframe.</div>
        )}
        {chart && !empty && (
          <>
            <SurplusStaticChart chart={chart} points={points} gid={gid} showTrend={showTrend} />

            <svg
              width={chart.W}
              height={chart.H}
              className="absolute inset-0 overflow-visible pointer-events-none"
              style={{ top: 0, left: 0 }}
            >
              {hover && (
                <line
                  x1={chart.xAt(hover.idx)}
                  x2={chart.xAt(hover.idx)}
                  y1={chart.padT}
                  y2={chart.H - chart.padB}
                  stroke="#2d3340"
                  strokeOpacity={0.35}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>

            <ChartTip x={hover?.x ?? null} y={hover?.y ?? null} content={tipContent} />
          </>
        )}
      </div>
    </Panel>
  );
}
