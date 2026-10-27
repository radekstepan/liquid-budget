"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  fmt,
  mergeBelowThreshold,
  layoutSankey,
  OTHER_BUCKET_LABEL,
  type SpendingBreakdownItem,
  type SpendingDimension,
} from "@ynab/logic";
import { Button, Panel, Tooltip } from "@ynab/theme";
import { ChartTip, colorForName, TipLabel, useElementSize } from "./chartUtils.js";
import { useLocalStorage } from "./useLocalStorage.js";

export type SpendingItem = SpendingBreakdownItem;
export type SpendingViewMode = "bars" | "sankey";

type Hover =
  | { kind: "node" | "link"; idx: number; x: number; y: number }
  | { kind: "source"; x: number; y: number };

const LABEL_ZONE = 190;

function truncateName(name: string, max = 26): string {
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

export function SpendingReport({
  categories,
  merchants,
  initialView = "sankey",
  initialDimension = "categories",
}: {
  categories: SpendingItem[];
  merchants: SpendingItem[];
  initialView?: SpendingViewMode;
  initialDimension?: SpendingDimension;
}) {
  const [viewMode, setViewMode] = useLocalStorage<SpendingViewMode>(
    "ynab:reports:spendingViewMode",
    initialView,
    (v): v is SpendingViewMode => v === "bars" || v === "sankey"
  );
  const [dimension, setDimension] = useLocalStorage<SpendingDimension>(
    "ynab:reports:spendingDimension",
    initialDimension,
    (v): v is SpendingDimension => v === "categories" || v === "merchants"
  );
  const [thresholdDollars, setThresholdDollars] = useLocalStorage<number>(
    "ynab:reports:spendingThreshold",
    0,
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0
  );
  const [hover, setHover] = useState<Hover | null>(null);
  const { ref: chartRef, size: chartSize } = useElementSize<HTMLDivElement>();

  const raw = dimension === "categories" ? categories : merchants;

  const maxDollars = useMemo(
    () => raw.reduce((m, s) => Math.max(m, s.value / 100), 0),
    [raw]
  );
  // Slider ceiling: a round number covering the largest group, floored at
  // $50 so the control stays useful on small datasets, capped at $2000 so
  // the slider keeps its resolution on large ones.
  const sliderMax = Math.max(50, Math.min(2000, Math.ceil(maxDollars / 10) * 10));
  const sliderStep = sliderMax <= 100 ? 5 : 10;
  const activeThreshold = Math.min(Math.max(0, thresholdDollars), sliderMax);

  const merged = useMemo(
    () => mergeBelowThreshold(raw, Math.round(activeThreshold * 100)),
    [raw, activeThreshold]
  );
  const total = useMemo(() => merged.items.reduce((s, x) => s + x.value, 0), [merged.items]);

  const rows = useMemo(() => {
    const maxSpend = merged.items.reduce((m, s) => Math.max(m, s.value), 1);
    return merged.items.map((s, i) => {
      const share = total !== 0 ? s.value / total : 0;
      const pctOfTotal = Math.round(share * 100);
      const pctOfMax = (s.value / maxSpend) * 100;
      const color = colorForName(s.name);
      return { ...s, share, pctOfTotal, pctOfMax, color, i };
    });
  }, [merged.items, total]);

  const empty = rows.length === 0;
  const growRows = rows.length > 0 && rows.length <= 14;
  const nounSingular = dimension === "categories" ? "category" : "merchant";
  const nounPlural = dimension === "categories" ? "categories" : "merchants";

  const sankey = useMemo(() => {
    if (chartSize.width <= 0 || chartSize.height <= 0) return null;
    return layoutSankey(merged.items, {
      width: chartSize.width,
      height: chartSize.height,
      padRight: LABEL_ZONE,
    });
  }, [merged.items, chartSize.width, chartSize.height]);

  const tipContent: ReactNode | null = (() => {
    if (!hover) return null;
    if (hover.kind === "source") {
      return (
        <div className="space-y-[3px]">
          <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
            Total spending
          </div>
          <TipLabel color="var(--y-blue)" label="Spent" value={fmt(total)} pct="100%" />
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>
              across {rows.length} {rows.length === 1 ? nounSingular : nounPlural}
            </span>
          </div>
        </div>
      );
    }
    const r = rows[hover.idx];
    if (!r) return null;
    const isOther = r.name === OTHER_BUCKET_LABEL && r.mergedCount > 1;
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
          <span>
            {isOther
              ? `${r.mergedCount} smaller ${nounPlural} under ${fmt(Math.round(activeThreshold * 100))}`
              : `of ${fmt(total)} total`}
          </span>
        </div>
      </div>
    );
  })();

  const hoverIdx = hover != null && hover.kind !== "source" ? hover.idx : null;

  return (
    <Panel
      title={dimension === "categories" ? "Spending by Category" : "Spending by Merchant"}
      className="flex h-full min-h-0 flex-col"
      bodyClass="flex min-h-0 flex-1 flex-col p-0"
    >
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--y-line-soft)] px-3 py-2 text-[11px]"
        style={{ background: "linear-gradient(#fbfbf9,#f1f1ee)" }}
      >
        <span style={{ color: "var(--y-ink-soft)" }}>
          Total: <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>{fmt(total)}</span>
        </span>
        <span style={{ color: "var(--y-ink-faint)" }}>·</span>
        <span style={{ color: "var(--y-ink-soft)" }}>
          {rows.length} {rows.length === 1 ? nounSingular : nounPlural}
          {merged.otherCount > 0 && (
            <span style={{ color: "var(--y-ink-faint)" }}>
              {" "}
              ({merged.otherCount} in Other)
            </span>
          )}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-1.5">
            <span className="y-caps text-[10px]" style={{ color: "var(--y-ink-faint)" }}>Group</span>
            <div className="y-seg">
              <Tooltip tip="Group spending by category">
                <Button
                  size="sm"
                  variant={dimension === "categories" ? "primary" : "default"}
                  active={dimension === "categories"}
                  onClick={() => {
                    setDimension("categories");
                    setHover(null);
                  }}
                >
                  Categories
                </Button>
              </Tooltip>
              <Tooltip tip="Group spending by merchant">
                <Button
                  size="sm"
                  variant={dimension === "merchants" ? "primary" : "default"}
                  active={dimension === "merchants"}
                  onClick={() => {
                    setDimension("merchants");
                    setHover(null);
                  }}
                >
                  Merchants
                </Button>
              </Tooltip>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="y-caps text-[10px]" style={{ color: "var(--y-ink-faint)" }}>View</span>
            <div className="y-seg">
              <Tooltip tip="Sankey flow chart">
                <Button
                  size="sm"
                  variant={viewMode === "sankey" ? "primary" : "default"}
                  active={viewMode === "sankey"}
                  onClick={() => {
                    setViewMode("sankey");
                    setHover(null);
                  }}
                >
                  Sankey
                </Button>
              </Tooltip>
              <Tooltip tip="Bar chart">
                <Button
                  size="sm"
                  variant={viewMode === "bars" ? "primary" : "default"}
                  active={viewMode === "bars"}
                  onClick={() => {
                    setViewMode("bars");
                    setHover(null);
                  }}
                >
                  Bars
                </Button>
              </Tooltip>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Tooltip
              tip={
                activeThreshold === 0
                  ? "Merge groups smaller than a threshold into Other"
                  : `Groups under ${fmt(Math.round(activeThreshold * 100))} merge into Other`
              }
            >
              <label
                className="y-caps cursor-pointer text-[10px]"
                style={{ color: "var(--y-ink-faint)" }}
              >
                Under{" "}
                <span className="y-num" style={{ color: "var(--y-ink)" }}>
                  {activeThreshold === 0 ? "—" : fmt(Math.round(activeThreshold * 100))}
                </span>
                <input
                  type="range"
                  aria-label="Merge smaller expenses under threshold"
                  className="ml-1.5 inline-block w-[110px] align-middle"
                  style={{ accentColor: "var(--y-blue)" }}
                  min={0}
                  max={sliderMax}
                  step={sliderStep}
                  value={activeThreshold}
                  disabled={empty}
                  onChange={(e) => {
                    setThresholdDollars(Number(e.target.value));
                    setHover(null);
                  }}
                />
              </label>
            </Tooltip>
          </div>
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
              const isHover = hoverIdx === r.i;
              return (
                <div
                  key={r.name}
                  className={
                    "group flex cursor-default items-center gap-3 rounded-[4px] px-2 transition-colors " +
                    (growRows ? "min-h-[36px] flex-1 py-[6px]" : "py-[7px]")
                  }
                  style={{ background: isHover ? "var(--y-row-sel)" : "transparent" }}
                  onMouseMove={(e) => setHover({ kind: "node", idx: r.i, x: e.clientX, y: e.clientY })}
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
                    {r.name === OTHER_BUCKET_LABEL && r.mergedCount > 1 && (
                      <span className="ml-1 text-[11px]" style={{ color: "var(--y-ink-faint)" }}>
                        ({r.mergedCount} merged)
                      </span>
                    )}
                  </span>
                  <div
                    className="y-bar-track relative h-[14px] flex-1 overflow-hidden rounded-[3px]"
                    style={{
                      boxShadow:
                        "inset 0 1px 2px rgba(0,0,0,0.18), 0 1px 0 rgba(255,255,255,0.6)",
                    }}
                  >
                    {(() => {
                      // Simple linear scale against the largest group; no
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
          ref={chartRef}
          className="relative min-h-0 flex-1"
          style={{ background: "linear-gradient(#ffffff, #f7f7f4)" }}
          onMouseLeave={() => setHover(null)}
        >
          {empty && (
            <div className="grid h-full place-items-center y-hint">No data for this timeframe.</div>
          )}
          {!empty && sankey != null && chartSize.width > 0 && chartSize.height > 0 && (
            <svg
              data-testid="sankey-svg"
              width={chartSize.width}
              height={chartSize.height}
              className="block"
            >
              {sankey.links.map((link, idx) => {
                const color = colorForName(link.name);
                const isHover = hoverIdx === idx;
                const dim = hoverIdx != null && !isHover;
                return (
                  <path
                    key={link.name}
                    data-testid="sankey-link"
                    d={link.d}
                    fill={color}
                    fillOpacity={isHover ? 0.65 : dim ? 0.18 : 0.35}
                    stroke="none"
                    style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                    onMouseMove={(e) => setHover({ kind: "link", idx, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })}
              <rect
                data-testid="sankey-source"
                x={sankey.source.x}
                y={sankey.source.y}
                width={sankey.source.w}
                height={Math.max(0, sankey.source.h)}
                rx={2}
                fill="var(--y-blue)"
                style={{ cursor: "pointer" }}
                onMouseMove={(e) => setHover({ kind: "source", x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHover(null)}
              />
              <text
                x={sankey.source.x + sankey.source.w / 2}
                y={Math.max(12, sankey.source.y - 8)}
                textAnchor="middle"
                fontSize={11}
                fontWeight={700}
                fill="var(--y-ink-faint)"
                className="y-caps"
              >
                TOTAL
              </text>
              <text
                x={sankey.source.x + sankey.source.w / 2}
                y={Math.min(chartSize.height - 4, sankey.source.y + sankey.source.h + 16)}
                textAnchor="middle"
                fontSize={12}
                fontWeight={700}
                fill="var(--y-ink)"
                className="y-num"
              >
                {fmt(total)}
              </text>
              {sankey.nodes.map((node, idx) => {
                const color = colorForName(node.name);
                const isHover = hoverIdx === idx;
                const dim = hoverIdx != null && !isHover;
                const r = rows[idx]!;
                const labelY = node.y + node.h / 2;
                return (
                  <g key={node.name}>
                    <rect
                      data-testid="sankey-node"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      rx={2}
                      fill={color}
                      fillOpacity={dim ? 0.35 : 1}
                      stroke={isHover ? "var(--y-ink)" : "rgba(0,0,0,0.15)"}
                      strokeWidth={isHover ? 2 : 1}
                      style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                      onMouseMove={(e) =>
                        setHover({ kind: "node", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
                    />
                    <text
                      x={sankey.labelX}
                      y={node.h >= 26 ? labelY - 2 : labelY - 6}
                      fontSize={12}
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      style={{ pointerEvents: "none" }}
                    >
                      {truncateName(node.name)}
                    </text>
                    <text
                      x={sankey.labelX}
                      y={node.h >= 26 ? labelY + 13 : labelY + 7}
                      fontSize={11}
                      fill="var(--y-ink-faint)"
                      className="y-num"
                      opacity={dim ? 0.4 : 1}
                      style={{ pointerEvents: "none" }}
                    >
                      {fmt(node.value)} · {r.pctOfTotal}%
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      )}

      <ChartTip x={hover?.x ?? null} y={hover?.y ?? null} content={tipContent} />
    </Panel>
  );
}
