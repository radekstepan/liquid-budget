"use client";

import { useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { fmt, MONTHS, monthLabel, parseMonthKey, type NetWorthPoint } from "@ynab/logic";
import { Panel } from "@ynab/theme";
import {
  ChartTip,
  colorAt,
  fmtShort,
  niceTicks,
  TipLabel,
  useElementSize,
} from "./chartUtils.js";

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

  const chart = useMemo(() => {
    if (size.width === 0 || size.height === 0 || points.length === 0) return null;
    const W = size.width;
    const H = size.height;
    const padL = 64;
    const padR = 18;
    const padT = 14;
    const padB = 36;
    const innerW = Math.max(1, W - padL - padR);
    const innerH = Math.max(1, H - padT - padB);

    let maxVal = 1;
    let minVal = 0;
    for (const p of points) {
      if (p.assets > maxVal) maxVal = p.assets;
      if (p.debts < minVal) minVal = p.debts;
    }
    const ticks = niceTicks(minVal, maxVal);
    const tMax = ticks[ticks.length - 1] ?? maxVal;
    const tMin = ticks[0] ?? minVal;
    const range = tMax - tMin || 1;
    const y = (v: number) => padT + innerH * (1 - (v - tMin) / range);
    const zeroY = y(0);

    const n = points.length;
    const xAt = (i: number) =>
      n === 1 ? padL + innerW / 2 : padL + (i * innerW) / (n - 1);

    const barW = Math.max(4, Math.min(28, (innerW / Math.max(1, n)) * 0.42));

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

    return { W, H, padL, padR, padT, padB, innerW, innerH, y, zeroY, ticks, tMin, tMax, linePath, areaPath, barW, n, xAt };
  }, [size, points]);

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
        <span className="ml-auto y-hint">Hover any month for details</span>
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
            </defs>

            {chart.ticks.map((t, i) => (
              <g key={i}>
                <line
                  x1={chart.padL}
                  x2={chart.W - chart.padR}
                  y1={chart.y(t)}
                  y2={chart.y(t)}
                  stroke={GRID}
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

            <line
              x1={chart.padL}
              x2={chart.W - chart.padR}
              y1={chart.zeroY}
              y2={chart.zeroY}
              stroke={AXIS_LINE}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />

            {points.map((p, i) => {
              const x = chart.xAt(i);
              const assetH = Math.max(0, chart.zeroY - chart.y(p.assets));
              const debtH = Math.max(0, chart.y(p.debts) - chart.zeroY);
              const barX = x - chart.barW / 2;
              return (
                <g key={p.month}>
                  {p.assets > 0 && (
                    <rect
                      x={barX}
                      y={chart.zeroY - assetH}
                      width={chart.barW}
                      height={assetH}
                      rx={1.5}
                      fill={`url(#${gid}-assets-grad)`}
                      stroke={ASSETS_COLOR}
                      strokeOpacity={0.2}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {p.debts < 0 && (
                    <rect
                      x={barX}
                      y={chart.zeroY}
                      width={chart.barW}
                      height={debtH}
                      rx={1.5}
                      fill={`url(#${gid}-debts-grad)`}
                      stroke={DEBTS_COLOR}
                      strokeOpacity={0.2}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </g>
              );
            })}

            <path d={chart.areaPath} fill={`url(#${gid}-net-grad)`} />
            <path
              d={chart.linePath}
              fill="none"
              stroke={NET_COLOR}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />

            {points.map((p, i) => (
              <circle
                key={`pt-${i}`}
                cx={chart.xAt(i)}
                cy={chart.y(p.net)}
                r={hover?.idx === i ? 5.5 : 3.5}
                fill={hover?.idx === i ? NET_COLOR : "#fff"}
                stroke={NET_COLOR}
                strokeWidth={hover?.idx === i ? 2 : 1.5}
                vectorEffect="non-scaling-stroke"
              />
            ))}

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
              const stride = chart.n <= 12 ? 1 : Math.ceil(chart.n / 12);
              const tickEvery = (i: number) => i === 0 || i === chart.n - 1 || i % stride === 0;
              return points.map((p, i) => {
                if (!tickEvery(i)) return null;
                const { month0, year } = parseMonthKey(p.month);
                const label = `${MONTHS[month0] ?? ""} ${year}`;
                return (
                  <text
                    key={`lbl-${i}`}
                    x={chart.xAt(i)}
                    y={chart.H - chart.padB + 18}
                    fill="var(--y-ink-soft)"
                    fontSize={10.5}
                    textAnchor="middle"
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
