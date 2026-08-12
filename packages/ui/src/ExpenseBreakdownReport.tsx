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

  let offset = 0;
  const rendered = segments.map((s) => {
    const len = s.share * circumference;
    const node = (
      <circle
        key={s.i}
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={s.color}
        strokeOpacity={hover == null || hover.idx === s.i ? 1 : 0.32}
        strokeWidth={hover?.idx === s.i ? strokeWidth + 4 : strokeWidth}
        strokeDasharray={`${len} ${circumference - len}`}
        strokeDashoffset={-offset}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{
          transition: "stroke-opacity 120ms, stroke-width 120ms",
          cursor: "pointer",
        }}
        onMouseMove={(e) => {
          setHover({ idx: s.i, x: e.clientX, y: e.clientY });
        }}
        onMouseLeave={() => setHover(null)}
      />
    );
    offset += len;
    return node;
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
