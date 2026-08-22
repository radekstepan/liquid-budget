"use client";

import { useMemo, useState, type ReactNode } from "react";
import { fmt } from "@ynab/logic";
import { Button, Panel } from "@ynab/theme";
import { ChartTip, colorAt, TipLabel, useElementSize } from "./chartUtils.js";
import { useLocalStorage } from "./useLocalStorage.js";

export type SpendingItem = { name: string; value: number };

export function SpendingReport({
  spending,
  total,
  initialView = "bars",
}: {
  spending: SpendingItem[];
  total: number;
  initialView?: "bars" | "donut";
}) {
  const [viewMode, setViewMode] = useLocalStorage<"bars" | "donut">("ynab:reports:spendingViewMode", initialView);
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);
  const { ref: donutRef, size: donutSize } = useElementSize<HTMLDivElement>();

  const rows = useMemo(() => {
    const maxSpend = spending.reduce((m, s) => Math.max(m, s.value), 1);
    return spending.map((s, i) => {
      const share = total ? s.value / total : 0;
      const pctOfTotal = Math.round(share * 100);
      const pctOfMax = (s.value / maxSpend) * 100;
      const color = colorAt(i);
      return { ...s, share, pctOfTotal, pctOfMax, color, i };
    });
  }, [spending, total]);

  const empty = rows.length === 0;
  const growRows = rows.length > 0 && rows.length <= 14;

  const side = Math.max(0, Math.min(donutSize.width * 0.45, donutSize.height * 0.92, 380));
  const cx = side / 2;
  const cy = side / 2;
  const strokeWidth = Math.max(18, Math.min(36, side * 0.12));
  const r = side > 0 ? Math.max(20, side / 2 - strokeWidth / 2 - 8) : 0;
  const circumference = 2 * Math.PI * r;

  const rOut = r + strokeWidth / 2 + 1;
  const rIn = r - strokeWidth / 2 - 1;

  // Tiny categories (e.g. <0.1% of the total) would previously produce
  // sub-pixel `stroke-dasharray` dashes on <circle> elements, which browsers
  // rasterize as a ragged multi-colour sliver at the seam — the "bow". Render
  // explicit annular arc paths instead, and clamp the drawn wedge of tiny
  // slices to a small fixed arc so they stay visible. The legend, tooltip and
  // percentages keep the true (unclamped) values.
  const minShare = circumference > 0 ? Math.min(0.012, Math.max(0.003, 4 / circumference)) : 0;
  const renderShares = rows.map((s) => s.share);
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
  const renderedDonutSlices = rows.map((s, idx) => {
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

  const tipContent: ReactNode | null = (() => {
    if (!hover) return null;
    const r = rows[hover.idx];
    if (!r) return null;
    return (
      <div className="space-y-[3px]">
        <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
          {r.name}
        </div>
        <TipLabel color={r.color} label="Spent" value={fmt(r.value)} pct={r.pctOfTotal + "%"} />
        <div
          className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
          style={{ color: "rgba(242,245,247,0.65)" }}
        >
          <span>of {fmt(total)} total</span>
        </div>
      </div>
    );
  })();

  return (
    <Panel
      title="Spending by Category"
      className="flex h-full min-h-0 flex-col"
      bodyClass="flex min-h-0 flex-1 flex-col p-0"
    >
      <div
        className="flex items-center gap-3 border-b border-[var(--y-line-soft)] px-3 py-2 text-[11px]"
        style={{ background: "linear-gradient(#fbfbf9,#f1f1ee)" }}
      >
        <span style={{ color: "var(--y-ink-soft)" }}>
          Total: <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>{fmt(total)}</span>
        </span>
        <span style={{ color: "var(--y-ink-faint)" }}>·</span>
        <span style={{ color: "var(--y-ink-soft)" }}>
          {rows.length} categor{rows.length === 1 ? "y" : "ies"}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="y-caps text-[10px]" style={{ color: "var(--y-ink-faint)" }}>View</span>
            <div className="y-seg">
              <Button
                size="sm"
                variant={viewMode === "bars" ? "primary" : "default"}
                active={viewMode === "bars"}
                onClick={() => {
                  setViewMode("bars");
                  setHover(null);
                }}
                title="Bar chart"
              >
                Bars
              </Button>
              <Button
                size="sm"
                variant={viewMode === "donut" ? "primary" : "default"}
                active={viewMode === "donut"}
                onClick={() => {
                  setViewMode("donut");
                  setHover(null);
                }}
                title="Donut chart"
              >
                Donut
              </Button>
            </div>
          </div>
          <span className="y-hint">
            {viewMode === "bars"
              ? "Hover any row for details"
              : "Hover a slice or a row for details"}
          </span>
        </div>
      </div>

      {viewMode === "bars" ? (
        <div
          className={
            "min-h-0 flex-1 overflow-y-auto px-4 py-3 y-scroll " +
            (growRows ? "flex flex-col" : "")
          }
        >
          <div
            className={
              "mx-auto w-full max-w-[1100px] " +
              (growRows ? "flex h-full min-h-0 flex-col gap-[6px] justify-center" : "space-y-[6px]")
            }
          >
            {empty && <div className="grid place-items-center py-12 y-hint">No data for this timeframe.</div>}
            {rows.map((r) => {
              const isHover = hover?.idx === r.i;
              return (
                <div
                  key={r.name}
                  className={
                    "group flex cursor-default items-center gap-3 rounded-[4px] px-2 transition-colors " +
                    (growRows ? "min-h-[36px] flex-1 py-[6px]" : "py-[7px]")
                  }
                  style={{ background: isHover ? "var(--y-row-sel)" : "transparent" }}
                  onMouseMove={(e) => setHover({ idx: r.i, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setHover(null)}
                >
                  <span
                    className="inline-block h-3 w-3 shrink-0 rounded-sm"
                    style={{
                      background: r.color,
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(0,0,0,0.1)",
                    }}
                  />
                  <span
                    className={
                      "shrink-0 truncate text-[12.5px] " +
                      (growRows ? "w-[22%]" : "w-[26%]")
                    }
                    style={{ color: "var(--y-ink)" }}
                  >
                    {r.name}
                  </span>
                  <div
                    className="y-bar-track relative h-[14px] flex-1 overflow-hidden rounded-[3px]"
                    style={{
                      boxShadow:
                        "inset 0 1px 2px rgba(0,0,0,0.18), 0 1px 0 rgba(255,255,255,0.6)",
                    }}
                  >
                    {(() => {
                      // Simple linear scale against the largest category; no
                      // truncation caps or axis breaks on this report.
                      const displayWidth = Math.round(Math.max(r.pctOfMax, r.value > 0 ? 1 : 0) * 100) / 100;
                      return (
                        <div
                          className="relative h-full rounded-[3px] transition-[width] duration-150"
                          style={{
                            width: `${displayWidth}%`,
                            background: `linear-gradient(rgba(255,255,255,0.18), rgba(255,255,255,0)) , ${r.color}`,
                            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.18)",
                          }}
                        />
                      );
                    })()}
                  </div>
                  <span
                    className="y-num w-[110px] shrink-0 text-right text-[12px] font-semibold"
                    style={{ color: "var(--y-ink)" }}
                  >
                    {fmt(r.value)}
                  </span>
                  <span
                    className="y-num w-[52px] shrink-0 text-right text-[11px]"
                    style={{ color: "var(--y-ink-faint)" }}
                  >
                    {r.pctOfTotal}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div
          ref={donutRef}
          className="relative flex min-h-0 flex-1 items-center justify-center"
          style={{ background: "linear-gradient(#ffffff, #f7f7f4)" }}
          onMouseLeave={() => setHover(null)}
        >
          {empty && <div className="y-hint">No data for this timeframe.</div>}
          {!empty && donutSize.width > 0 && side > 0 && (
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
                  {renderedDonutSlices}
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
                  {hover != null && rows[hover.idx] && (
                    <text
                      x={cx}
                      y={cy + innerLabelSize * 1.4}
                      textAnchor="middle"
                      fontSize={Math.max(11, innerLabelSize * 0.34)}
                      fill={rows[hover.idx]!.color}
                      fontWeight={700}
                      style={{ textShadow: "0 1px 0 rgba(255,255,255,.85)" }}
                      className="y-num"
                    >
                      {rows[hover.idx]!.name} · {rows[hover.idx]!.pctOfTotal}%
                    </text>
                  )}
                </svg>
              </div>

              <div
                className="min-h-0 flex-1 overflow-y-auto p-3 y-scroll"
                style={{ maxHeight: donutSize.height }}
              >
                <div className="space-y-[3px]">
                  {rows.map((s) => {
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
                          {s.pctOfTotal}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <ChartTip x={hover?.x ?? null} y={hover?.y ?? null} content={tipContent} />
    </Panel>
  );
}
