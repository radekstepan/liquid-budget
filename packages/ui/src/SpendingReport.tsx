"use client";

import { useMemo, useState, type ReactNode } from "react";
import { fmt } from "@ynab/logic";
import { Panel } from "@ynab/theme";
import { ChartTip, colorAt, TipLabel } from "./chartUtils.js";

export type SpendingItem = { name: string; value: number };

export function SpendingReport({
  spending,
  total,
}: {
  spending: SpendingItem[];
  total: number;
}) {
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);

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
        <div className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
          style={{ color: "rgba(242,245,247,0.6)" }}>
          <span>{rows.length} categor{rows.length === 1 ? "y" : "ies"} total</span>
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
      <div className="flex items-center gap-3 border-b border-[var(--y-line-soft)] px-3 py-2 text-[11px]"
        style={{ background: "linear-gradient(#fbfbf9,#f1f1ee)" }}>
        <span style={{ color: "var(--y-ink-soft)" }}>
          Total: <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>{fmt(total)}</span>
        </span>
        <span style={{ color: "var(--y-ink-faint)" }}>·</span>
        <span style={{ color: "var(--y-ink-soft)" }}>
          {rows.length} categor{rows.length === 1 ? "y" : "ies"}
        </span>
        <span className="ml-auto y-hint">Hover any row for details</span>
      </div>

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
                  className="y-bar-track h-[14px] flex-1 overflow-hidden rounded-[3px]"
                  style={{
                    boxShadow:
                      "inset 0 1px 2px rgba(0,0,0,0.18), 0 1px 0 rgba(255,255,255,0.6)",
                  }}
                >
                  <div
                    className="relative h-full rounded-[3px] transition-[width] duration-150"
                    style={{
                      width: `${Math.max(r.pctOfMax, r.value > 0 ? 1 : 0)}%`,
                      background: `linear-gradient(rgba(255,255,255,0.18), rgba(255,255,255,0)) , ${r.color}`,
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.18)",
                    }}
                  />
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

      <ChartTip x={hover?.x ?? null} y={hover?.y ?? null} content={tipContent} />
    </Panel>
  );
}
