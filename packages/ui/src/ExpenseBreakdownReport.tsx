"use client";

import { useMemo, useState, type ReactNode } from "react";
import { fmt } from "@ynab/logic";
import { Panel } from "@ynab/theme";
import { ChartTip, colorAt, TipLabel, useElementSize } from "./chartUtils.js";
import type { SpendingItem } from "./SpendingReport.js";

export function ExpenseBreakdownReport({
  spending,
  total,
}: {
  spending: SpendingItem[];
  total: number;
}) {
  const { ref, size } = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);

  const segments = useMemo(() => {
    return spending.map((s, i) => {
      const share = total ? s.value / total : 0;
      const pct = Math.round(share * 100);
      return { ...s, color: colorAt(i), share, pct, i };
    });
  }, [spending, total]);

  const empty = segments.length === 0;

  const side = Math.max(0, Math.min(size.width * 0.45, size.height * 0.92, 380));
  const cx = side / 2;
  const cy = side / 2;
  const strokeWidth = Math.max(18, Math.min(36, side * 0.12));
  const r = side > 0 ? Math.max(20, side / 2 - strokeWidth / 2 - 8) : 0;
  const circumference = 2 * Math.PI * r;

  const tipContent: ReactNode | null = (() => {
    if (hover == null) return null;
    const seg = segments[hover.idx];
    if (!seg) return null;
    return (
      <div className="space-y-[3px]">
        <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
          {seg.name}
        </div>
        <TipLabel color={seg.color} label="Spent" value={fmt(seg.value)} pct={seg.pct + "%"} />
        <div className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
          style={{ color: "rgba(242,245,247,0.65)" }}>
          <span>of {fmt(total)} total</span>
        </div>
      </div>
    );
  })();

  const rOut = r + strokeWidth / 2 + 1;
  const rIn = r - strokeWidth / 2 - 1;

  // Tiny categories (e.g. <0.1% of the total) would previously produce
  // sub-pixel `stroke-dasharray` dashes on <circle> elements, which browsers
  // rasterize as a ragged multi-colour sliver at the seam — the "bow". Render
  // explicit annular arc paths instead, and clamp the drawn wedge of tiny
  // slices to a small fixed arc so they stay visible. The legend, tooltip and
  // percentages keep the true (unclamped) values.
  const minShare = circumference > 0 ? Math.min(0.012, Math.max(0.003, 4 / circumference)) : 0;
  const renderShares = segments.map((s) => s.share);
  if (minShare > 0) {
    const belowMin = renderShares.filter((v) => v > 0 && v < minShare).length;
    if (belowMin > 0) {
      const short = renderShares.reduce((acc, v) => acc + (v > 0 && v < minShare ? minShare - v : 0), 0);
      const largest = renderShares
        .map((v, idx) => ({ v, idx }))
        .filter((o) => o.v > minShare)
        .sort((a, b) => b.v - a.v);
      let left = short;
      for (const o of largest) {
        if (left <= 0) break;
        const give = Math.min(o.v - minShare, left);
        renderShares[o.idx] = (renderShares[o.idx] ?? o.v) - give;
        left -= give;
      }
      for (let idx = 0; idx < renderShares.length; idx++) {
        const v = renderShares[idx];
        if (v != null && v > 0 && v < minShare) {
          renderShares[idx] = minShare;
        }
      }
    }
    const totalShare = renderShares.reduce((a, v) => a + v, 0);
    if (totalShare > 1) {
      let over = totalShare - 1;
      const largest = renderShares
        .map((v, idx) => ({ v, idx }))
        .sort((a, b) => b.v - a.v);
      for (const o of largest) {
        if (over <= 0) break;
        const give = Math.min(o.v - minShare, over);
        renderShares[o.idx] = (renderShares[o.idx] ?? o.v) - give;
        over -= give;
      }
    }
  }

  const polar = (frac: number, rr: number) => {
    const a = (frac - 0.25) * 2 * Math.PI;
    return `${(cx + rr * Math.cos(a)).toFixed(3)} ${(cy + rr * Math.sin(a)).toFixed(3)}`;
  };

  let cum = 0;
  const rendered = segments.map((s, idx) => {
    const share = renderShares[idx] ?? s.share;
    const start = cum;
    const end = Math.min(1, cum + share);
    cum += share;
    const full = end - start >= 1 - 1e-9;
    const large = share > 0.5 ? 1 : 0;
    const hovered = hover?.idx === s.i;
    const grow = 2;
    const or = rOut + (hovered ? grow : 0);
    const ir = rIn - (hovered ? grow : 0);
    const arc = (to: number, rr: number, sweep: number, la: number) =>
      `A ${rr} ${rr} 0 ${la} ${sweep} ${polar(to, rr)}`;
    // A path arc whose start equals its end is not rendered, so a full circle
    // is drawn as two half-circle arcs instead. The outer arcs sweep forward
    // (1), the closing inner arcs sweep back (0) along the ring's inner edge.
    const d = full
      ? `M ${polar(start, or)} ${arc(start + 0.5, or, 1, 0)} ${arc(end, or, 1, 0)} L ${polar(end, ir)} ${arc(end - 0.5, ir, 0, 0)} ${arc(start, ir, 0, 0)} Z`
      : `M ${polar(start, or)} ${arc(end, or, 1, large)} L ${polar(end, ir)} ${arc(start, ir, 0, large)} Z`;
    return (
      <path
        key={s.i}
        d={d}
        fill={s.color}
        fillOpacity={hover == null || hovered ? 1 : 0.32}
        stroke={s.color}
        strokeWidth={hovered ? 2 : 1}
        style={{
          transition: "fill-opacity 120ms, stroke-width 120ms",
          cursor: "pointer",
        }}
        onMouseMove={(e) => {
          setHover({ idx: s.i, x: e.clientX, y: e.clientY });
        }}
        onMouseLeave={() => setHover(null)}
      />
    );
  });

  const innerLabelSize = Math.max(20, side * 0.12);

  return (
    <Panel
      title="Expense Breakdown"
      className="flex h-full min-h-0 flex-col"
      bodyClass="flex min-h-0 flex-1 flex-col p-0"
    >
      <div className="flex items-center gap-3 border-b border-[var(--y-line-soft)] px-3 py-2 text-[11px]"
        style={{ background: "linear-gradient(#fbfbf9,#f1f1ee)" }}>
        <span style={{ color: "var(--y-ink-soft)" }}>
          Total: <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>{fmt(total)}</span>
        </span>
        <span style={{ color: "var(--y-ink-faint)" }}>·</span>
        <span style={{ color: "var(--y-ink-soft)" }}>
          {segments.length} categor{segments.length === 1 ? "y" : "ies"}
        </span>
        <span className="ml-auto y-hint">Hover a slice or a row for details</span>
      </div>

      <div
        ref={ref}
        className="relative flex min-h-0 flex-1 items-center justify-center"
        style={{ background: "linear-gradient(#ffffff, #f7f7f4)" }}
        onMouseLeave={() => setHover(null)}
      >
        {empty && <div className="y-hint">No data for this timeframe.</div>}
        {!empty && size.width > 0 && side > 0 && (
          <>
            <div
              className="flex shrink-0 items-center justify-center"
              style={{ width: side, height: side }}
            >
              <svg width={side} height={side}>
                <defs>
                  <radialGradient id="donut-bg" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#fcfcfb" />
                    <stop offset="100%" stopColor="#f0f0ed" />
                  </radialGradient>
                </defs>
                <circle cx={cx} cy={cy} r={r} fill="url(#donut-bg)" />
                {rendered}
                <text
                  x={cx}
                  y={cy - innerLabelSize * 0.05}
                  textAnchor="middle"
                  fontSize={Math.max(11, innerLabelSize * 0.32)}
                  fill="var(--y-ink-faint)"
                  style={{ textShadow: "0 1px 0 #fff" }}
                  fontWeight={700}
                  letterSpacing={0.5}
                  className="y-caps"
                >
                  TOTAL
                </text>
                <text
                  x={cx}
                  y={cy + innerLabelSize * 0.55}
                  textAnchor="middle"
                  fontSize={Math.max(15, innerLabelSize * 0.52)}
                  fill="var(--y-ink)"
                  fontWeight={700}
                  className="y-num"
                >
                  {fmt(total)}
                </text>
                {hover != null && segments[hover.idx] && (
                  <text
                    x={cx}
                    y={cy + innerLabelSize * 1.4}
                    textAnchor="middle"
                    fontSize={Math.max(11, innerLabelSize * 0.34)}
                    fill={segments[hover.idx]!.color}
                    fontWeight={700}
                    style={{ textShadow: "0 1px 0 rgba(255,255,255,.85)" }}
                    className="y-num"
                  >
                    {segments[hover.idx]!.name} · {segments[hover.idx]!.pct}%
                  </text>
                )}
              </svg>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3 y-scroll" style={{ maxHeight: size.height }}>
              <div className="space-y-[3px]">
                {segments.map((s) => {
                  const isHover = hover?.idx === s.i;
                  return (
                    <div
                      key={s.i}
                      className="group flex cursor-default items-center gap-2 rounded-[4px] px-2 py-[5px] transition-colors"
                      style={{ background: isHover ? "var(--y-row-sel)" : "transparent" }}
                      onMouseMove={(e) => setHover({ idx: s.i, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setHover(null)}
                    >
                      <span
                        className="inline-block h-3 w-3 shrink-0 rounded-sm"
                        style={{
                          background: s.color,
                          boxShadow:
                            "inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(0,0,0,0.1)",
                        }}
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-[12px]"
                        style={{ color: "var(--y-ink)" }}
                      >
                        {s.name}
                      </span>
                      <span
                        className="y-num w-[100px] text-right text-[12px] font-semibold"
                        style={{ color: "var(--y-ink)" }}
                      >
                        {fmt(s.value)}
                      </span>
                      <span
                        className="y-num w-[44px] text-right text-[11px]"
                        style={{ color: "var(--y-ink-faint)" }}
                      >
                        {s.pct}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      <ChartTip x={hover?.x ?? null} y={hover?.y ?? null} content={tipContent} />
    </Panel>
  );
}
