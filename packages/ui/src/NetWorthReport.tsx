"use client";

import { useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { fmt, MONTHS, monthLabel, parseMonthKey, type NetWorthPoint } from "@ynab/logic";
import { Button, Panel } from "@ynab/theme";
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
  TRUNC_RATIO,
  TruncHatchPattern,
  TruncMarker,
  useElementSize,
} from "./chartUtils.js";
import { useLocalStorage } from "./useLocalStorage.js";

export type { NetWorthPoint };

const AXIS_LINE = "#b6b6b1";
const GRID = "#dcdcd8";

const ASSETS_COLOR = "#2f7fb0";
const DEBTS_COLOR = "#c0483a";
const NET_COLOR = "#2d3340";

export function NetWorthReport({ points }: { points: NetWorthPoint[] }) {
  const gid = useId();
  const { ref, size } = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [scaleMode, setScaleMode] = useLocalStorage<"linear" | "log">("ynab:reports:scaleMode", "linear");

  const chart = useMemo(() => {
    if (size.width === 0 || size.height === 0 || points.length === 0) return null;
    const W = size.width;
    const H = size.height;
    const padL = 64;
    const padR = 18;
    const padT = 10;
    const padB = 34;
    const innerW = Math.max(1, W - padL - padR);
    const innerH = Math.max(1, H - padT - padB);

    const isLog = scaleMode === "log";
    const assetBreak = isLog ? NO_BREAK : computeOutlierBreak(points.map((p) => p.assets));
    const debtBreak = isLog ? NO_BREAK : computeOutlierBreak(points.map((p) => -p.debts));
    const hasBreak = assetBreak.hasBreak || debtBreak.hasBreak;

    let maxVal = 1;
    let minVal = 0;
    for (const p of points) {
      if (p.assets > maxVal) maxVal = p.assets;
      if (p.debts < minVal) minVal = p.debts;
      if (p.net > maxVal) maxVal = p.net;
      if (p.net < minVal) minVal = p.net;
    }

    const posTopVal = Math.max(1, maxVal);
    const negTopVal = Math.max(1, -minVal);
    // Zero-line placement follows the pre-break domain so inliers keep their
    // fair share of the vertical space (the compressed zone only extends upward).
    const fracZero =
      Math.max(1, maxVal) / (Math.max(1, maxVal) + Math.max(1, -minVal));
    let zeroY = padT + innerH * (1 - fracZero);

    // value -> 0..1 distance from the zero line (0 = baseline, 1 = domain top)
    const posNorm = (v: number) => {
      if (v <= 0) return 0;
      if (assetBreak.hasBreak) {
        if (v <= assetBreak.breakTop) return (v / assetBreak.breakTop) * assetBreak.split;
        return assetBreak.split + ((v - assetBreak.breakTop) / (assetBreak.topVal - assetBreak.breakTop)) * (1 - assetBreak.split);
      }
      return v / posTopVal;
    };
    const negNorm = (d: number) => {
      if (d <= 0) return 0;
      if (debtBreak.hasBreak) {
        if (d <= debtBreak.breakTop) return (d / debtBreak.breakTop) * debtBreak.split;
        return debtBreak.split + ((d - debtBreak.breakTop) / (debtBreak.topVal - debtBreak.breakTop)) * (1 - debtBreak.split);
      }
      return d / negTopVal;
    };

    // value -> y pixel
    let y: (v: number) => number;

    // ---- ticks ---------------------------------------------------------
    // grid: false => label-only tick for the top of a compressed zone.
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
      if (assetBreak.hasBreak) {
        for (const t of assetBreak.ticks) ticks.push({ v: t, grid: true });
        ticks.push({ v: assetBreak.topVal, grid: false });
      } else {
        for (const t of niceTicks(0, posTopVal, 4)) {
          if (t > 0) ticks.push({ v: t, grid: true });
        }
      }
      if (debtBreak.hasBreak) {
        for (const t of debtBreak.ticks) ticks.push({ v: -t, grid: true });
        ticks.push({ v: -debtBreak.topVal, grid: false });
      } else {
        for (const t of niceTicks(0, negTopVal, 4)) {
          if (t > 0) ticks.push({ v: -t, grid: true });
        }
      }
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
    const xAt = (i: number) =>
      n === 1 ? padL + innerW / 2 : padL + (i * innerW) / (n - 1);

    const barW = Math.max(4, Math.min(28, (innerW / Math.max(1, n)) * 0.42));

    // Bars scale against the largest asset/debt values so the tallest bars
    // always reach the visual cap; the axis keeps its own data-derived domain.
    const barScaleAssets = Math.max(1, ...points.map((p) => p.assets));
    const barScaleDebts = Math.max(1, ...points.map((p) => -p.debts));
    const maxBarH = Math.max(0, (zeroY - padT) * TRUNC_RATIO);
    const maxBarHD = Math.max(0, (H - padB - zeroY) * TRUNC_RATIO);

    let linePath = "";
    for (let i = 0; i < n; i++) {
      const p = points[i]!;
      linePath += (i === 0 ? "M " : " L ") + xAt(i) + "," + y(p.net);
    }
    let areaPath = "";
    if (n > 0) {
      const first = points[0]!;
      areaPath =
        "M " + xAt(0) + "," + y(first.net) +
        points.slice(1).map((p, i) => " L " + xAt(i + 1) + "," + y(p.net)).join("") +
        " L " + xAt(n - 1) + "," + zeroY +
        " L " + xAt(0) + "," + zeroY + " Z";
    }

    return {
      W, H, padL, padR, padT, padB, innerW, innerH, y, hasBreak,
      assetBreak: assetBreak.hasBreak ? assetBreak : null,
      debtBreak: debtBreak.hasBreak ? debtBreak : null,
      zeroY, ticks, linePath, areaPath, barW, n, xAt,
      barScaleAssets, barScaleDebts, maxBarH, maxBarHD, isLog,
    };
  }, [size, points, scaleMode]);

  const empty = points.length === 0;

  const tipContent: ReactNode | null = (() => {
    if (hover == null) return null;
    const p = points[hover.idx];
    if (!p) return null;
    return (
      <div className="space-y-[3px]">
        <div className="text-[11px] font-bold mb-1" style={{ color: "#f2f5f7" }}>
          {monthLabel(p.month)}
        </div>
        <TipLabel color={ASSETS_COLOR} label="Assets" value={fmt(p.assets)} />
        <TipLabel color={DEBTS_COLOR} label="Debts" value={fmt(p.debts)} />
        <TipLabel color={NET_COLOR} label="Net" value={fmt(p.net)} />
      </div>
    );
  })();

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!chart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    if (chart.n === 1) {
      setHover({ idx: 0, x: e.clientX, y: e.clientY });
      return;
    }
    const stride = chart.innerW / (chart.n - 1);
    const idx = Math.max(0, Math.min(chart.n - 1, Math.round((relX - chart.padL) / stride)));
    setHover({ idx, x: e.clientX, y: e.clientY });
  };

  return (
    <Panel
      title="Net Worth"
      className="flex h-full min-h-0 flex-col"
      bodyClass="flex min-h-0 flex-1 flex-col p-0"
    >
      <div className="flex items-center gap-4 border-b border-[var(--y-line-soft)] px-3 py-2 text-[11px]"
        style={{ background: "linear-gradient(#fbfbf9,#f1f1ee)" }}>
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: ASSETS_COLOR, opacity: 0.5 }} />
          <span style={{ color: "var(--y-ink-soft)" }}>Assets</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: DEBTS_COLOR, opacity: 0.5 }} />
          <span style={{ color: "var(--y-ink-soft)" }}>Debts</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-[3px] w-5 rounded-full" style={{ background: NET_COLOR }} />
          <span style={{ color: "var(--y-ink-soft)" }}>Net</span>
        </span>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="y-caps text-[10px]" style={{ color: "var(--y-ink-faint)" }}>Scale</span>
            <div className="y-seg">
              <Button
                size="sm"
                variant={scaleMode === "linear" ? "primary" : "default"}
                active={scaleMode === "linear"}
                onClick={() => setScaleMode("linear")}
                title="Linear scale"
              >
                Linear
              </Button>
              <Button
                size="sm"
                variant={scaleMode === "log" ? "primary" : "default"}
                active={scaleMode === "log"}
                onClick={() => setScaleMode("log")}
                title="Logarithmic scale"
              >
                Log
              </Button>
            </div>
          </div>
          <span className="y-hint">Hover any month for details</span>
        </div>
      </div>

      <div
        ref={ref}
        className="relative min-h-0 flex-1 w-full"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        style={{ background: "linear-gradient(#ffffff, #f7f7f4)" }}
      >
        {empty && (
          <div className="grid h-full place-items-center y-hint">No data for this timeframe.</div>
        )}
        {chart && !empty && (
          <svg width={chart.W} height={chart.H}>
            <defs>
              <linearGradient id={`${gid}-net-grad`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={NET_COLOR} stopOpacity={0.28} />
                <stop offset="100%" stopColor={NET_COLOR} stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`${gid}-assets-grad`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={ASSETS_COLOR} stopOpacity={0.85} />
                <stop offset="100%" stopColor={ASSETS_COLOR} stopOpacity={0.45} />
              </linearGradient>
              <linearGradient id={`${gid}-debts-grad`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={DEBTS_COLOR} stopOpacity={0.45} />
                <stop offset="100%" stopColor={DEBTS_COLOR} stopOpacity={0.85} />
              </linearGradient>
              <TruncHatchPattern id={`${gid}-hatch`} />
              {chart.hasBreak && (
                <AxisBreakMask
                  maskId={`${gid}-break`}
                  x1={chart.padL}
                  x2={chart.W - chart.padR}
                  breaks={[
                    ...(chart.assetBreak ? [{ y: chart.y(chart.assetBreak.breakTop) }] : []),
                    ...(chart.debtBreak ? [{ y: chart.y(-chart.debtBreak.breakTop) }] : []),
                  ]}
                />
              )}
            </defs>

            {chart.ticks.map((t, i) => {
              const ty = chart.y(t.v);
              const inBreak =
                t.grid &&
                chart.hasBreak &&
                ((chart.assetBreak && Math.abs(ty - chart.y(chart.assetBreak.breakTop)) < 7) ||
                  (chart.debtBreak && Math.abs(ty - chart.y(-chart.debtBreak.breakTop)) < 7));
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

            {/* Bars + area fill — masked to cut a transparent break band */}
            <g mask={chart.hasBreak ? `url(#${gid}-break)` : undefined}>
              {points.map((p, i) => {
                const x = chart.xAt(i);
                const assetH = Math.max(0, chart.zeroY - chart.y(Math.max(0, p.assets)));
                const debtH = Math.max(0, chart.y(Math.min(0, p.debts)) - chart.zeroY);
                const useBreakBars = chart.hasBreak;
                const assetTruncated = !useBreakBars && p.assets > 0 && p.assets >= chart.barScaleAssets * TRUNC_RATIO;
                const debtTruncated = !useBreakBars && p.debts < 0 && -p.debts >= chart.barScaleDebts * TRUNC_RATIO;
                const assetHNorm = useBreakBars ? assetH : Math.max(0, chart.maxBarH * Math.min(1, Math.max(0, p.assets) / chart.barScaleAssets));
                const debtHNorm = useBreakBars ? debtH : Math.max(0, chart.maxBarHD * Math.min(1, Math.max(0, -p.debts) / chart.barScaleDebts));
                const barX = x - chart.barW / 2;
                return (
                  <g key={p.month}>
                    {p.assets > 0 && (
                      <>
                        <rect
                          x={barX}
                          y={chart.zeroY - assetHNorm}
                          width={chart.barW}
                          height={assetHNorm}
                          rx={1.5}
                          fill={`url(#${gid}-assets-grad)`}
                          stroke={ASSETS_COLOR}
                          strokeOpacity={0.2}
                          vectorEffect="non-scaling-stroke"
                        />
                        {assetTruncated && (
                          <TruncMarker
                            x={barX}
                            y={chart.zeroY - assetHNorm}
                            width={chart.barW}
                            fill={ASSETS_COLOR}
                            hatchId={`url(#${gid}-hatch)`}
                            rx={1.5}
                          />
                        )}
                      </>
                    )}
                    {p.debts < 0 && (
                      <>
                        <rect
                          x={barX}
                          y={chart.zeroY}
                          width={chart.barW}
                          height={debtHNorm}
                          rx={1.5}
                          fill={`url(#${gid}-debts-grad)`}
                          stroke={DEBTS_COLOR}
                          strokeOpacity={0.2}
                          vectorEffect="non-scaling-stroke"
                        />
                        {debtTruncated && (
                          <TruncMarker
                            dir="down"
                            x={barX}
                            y={chart.zeroY + debtHNorm}
                            width={chart.barW}
                            fill={DEBTS_COLOR}
                            hatchId={`url(#${gid}-hatch)`}
                            rx={1.5}
                          />
                        )}
                      </>
                    )}
                  </g>
                );
              })}

              <path d={chart.areaPath} fill={`url(#${gid}-net-grad)`} />
            </g>
            <path
              d={chart.linePath}
              fill="none"
              stroke={NET_COLOR}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />

            {chart.hasBreak && (
              <>
                {chart.assetBreak && (
                  <AxisBreakMark
                    x1={chart.padL}
                    x2={chart.W - chart.padR}
                    y={chart.y(chart.assetBreak.breakTop)}
                  />
                )}
                {chart.debtBreak && (
                  <AxisBreakMark
                    x1={chart.padL}
                    x2={chart.W - chart.padR}
                    y={chart.y(-chart.debtBreak.breakTop)}
                  />
                )}
              </>
            )}

            {points.map((p, i) => {
              const isHovered = hover?.idx === i;
              return (
                <g key={`pt-${i}`}>
                  {isHovered && (
                    <circle
                      cx={chart.xAt(i)}
                      cy={chart.y(p.net)}
                      r={6.5}
                      fill={NET_COLOR}
                      fillOpacity={0.25}
                    />
                  )}
                  <circle
                    cx={chart.xAt(i)}
                    cy={chart.y(p.net)}
                    r={isHovered ? 4.5 : 2.5}
                    fill={NET_COLOR}
                    stroke={isHovered ? "#ffffff" : "none"}
                    strokeWidth={isHovered ? 1.5 : 0}
                    vectorEffect="non-scaling-stroke"
                    opacity={hover && !isHovered ? 0.45 : 1}
                  />
                </g>
              );
            })}

            {hover && (
              <line
                x1={chart.xAt(hover.idx)}
                x2={chart.xAt(hover.idx)}
                y1={chart.padT}
                y2={chart.H - chart.padB}
                stroke={NET_COLOR}
                strokeOpacity={0.4}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                strokeDasharray="3 3"
              />
            )}

            {(() => {
              if (chart.n === 0) return null;
              const maxTicks = Math.max(2, Math.min(12, Math.floor(chart.innerW / 65)));
              const stride = chart.n <= maxTicks ? 1 : Math.ceil((chart.n - 1) / (maxTicks - 1));
              const tickIndices: number[] = [];
              for (let i = 0; i < chart.n; i += stride) {
                tickIndices.push(i);
              }
              const lastIdx = chart.n - 1;
              const prevIdx = tickIndices[tickIndices.length - 1]!;
              if (lastIdx !== prevIdx) {
                if (lastIdx - prevIdx < Math.max(2, Math.round(stride * 0.75))) {
                  tickIndices[tickIndices.length - 1] = lastIdx;
                } else {
                  tickIndices.push(lastIdx);
                }
              }
              const tickSet = new Set(tickIndices);

              return points.map((p, i) => {
                if (!tickSet.has(i)) return null;
                const { month0, year } = parseMonthKey(p.month);
                const label = `${MONTHS[month0] ?? ""} ${year}`;
                const anchor =
                  chart.n === 1
                    ? "middle"
                    : i === 0
                    ? "start"
                    : i === chart.n - 1
                    ? "end"
                    : "middle";
                return (
                  <text
                    key={`lbl-${i}`}
                    x={chart.xAt(i)}
                    y={chart.H - chart.padB + 18}
                    fill="var(--y-ink-soft)"
                    fontSize={10.5}
                    textAnchor={anchor}
                    className="y-num"
                  >
                    {label}
                  </text>
                );
              });
            })()}
          </svg>
        )}
      </div>

      <ChartTip x={hover?.x ?? null} y={hover?.y ?? null} content={tipContent} />
    </Panel>
  );
}

export const __netWorthColors = { ASSETS_COLOR, DEBTS_COLOR, NET_COLOR };
