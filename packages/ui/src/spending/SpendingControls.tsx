"use client";

import { fmt } from "@ynab/logic";
import { Button, Tooltip } from "@ynab/theme";
import { markSankeyAutoFitDone } from "./sankeyHelpers.js";
import type { Hover } from "./types.js";
import type { SpendingData } from "./useSpendingData.js";
import type { SpendingFilters } from "./useSpendingFilters.js";

export function SpendingControls({
  filters,
  data,
  setHover,
}: {
  filters: SpendingFilters;
  data: SpendingData;
  setHover: (hover: Hover | null) => void;
}) {
  const {
    dimension,
    setDimension,
    viewMode,
    setViewMode,
    sort,
    setSort,
    showHeld,
    setShowHeld,
    setThresholdDollars,
  } = filters;
  const {
    totals,
    remaining,
    rows,
    nounSingular,
    nounPlural,
    mergedOtherCount,
    activeThreshold,
    stops,
    sliderPos,
    empty,
  } = data;
  return (
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--y-line-soft)] px-3 py-2 text-[11px]"
        style={{ background: "linear-gradient(#fbfbf9,#f1f1ee)" }}
      >
        <span style={{ color: "var(--y-ink-soft)" }}>
          In:{" "}
          <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
            {fmt(totals.incomeTotal)}
          </span>
        </span>
        <span style={{ color: "var(--y-ink-faint)" }}>·</span>
        <span style={{ color: "var(--y-ink-soft)" }}>
          Out:{" "}
          <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
            {fmt(totals.spendingTotal)}
          </span>
        </span>
        <span style={{ color: "var(--y-ink-faint)" }}>·</span>
        <span style={{ color: "var(--y-ink-soft)" }}>
          {remaining >= 0 ? "Left: " : "Over: "}
          <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
            {fmt(Math.abs(remaining))}
          </span>
        </span>
        <span style={{ color: "var(--y-ink-faint)" }}>·</span>
        <span style={{ color: "var(--y-ink-soft)" }}>
          {rows.length} {rows.length === 1 ? nounSingular : nounPlural}
          {mergedOtherCount > 0 && (
            <span style={{ color: "var(--y-ink-faint)" }}>
              {" "}
              ({mergedOtherCount} in Other)
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
          {viewMode === "sankey" && (
            <div className="flex items-center gap-1.5">
              <span className="y-caps text-[10px]" style={{ color: "var(--y-ink-faint)" }}>Sort</span>
              <div className="y-seg">
                <Tooltip tip={`Sort ${nounPlural} by current amount`}>
                  <Button
                    size="sm"
                    variant={sort === "amount" ? "primary" : "default"}
                    active={sort === "amount"}
                    onClick={() => {
                      setSort("amount");
                      setHover(null);
                    }}
                  >
                    Amount
                  </Button>
                </Tooltip>
                <Tooltip
                  tip={
                    dimension === "categories"
                      ? "Sort categories by Budget order: parent group, then each category's position in its group"
                      : `Sort ${nounPlural} by parent group in Budget view order (amount within a group)`
                  }
                >
                  <Button
                    size="sm"
                    variant={sort === "group" ? "primary" : "default"}
                    active={sort === "group"}
                    onClick={() => {
                      setSort("group");
                      setHover(null);
                    }}
                  >
                    Group
                  </Button>
                </Tooltip>
              </div>
            </div>
          )}
          {viewMode === "sankey" && (
            <div className="flex items-center gap-1.5">
              <span className="y-caps text-[10px]" style={{ color: "var(--y-ink-faint)" }}>Held</span>
              <Tooltip
                tip={
                  showHeld
                    ? "Hide still-held flows (their money folds into Remaining)"
                    : "Show still-held flows"
                }
              >
                <Button
                  size="sm"
                  variant={showHeld ? "primary" : "default"}
                  active={showHeld}
                  onClick={() => {
                    setShowHeld(!showHeld);
                    setHover(null);
                  }}
                >
                  {showHeld ? "On" : "Off"}
                </Button>
              </Tooltip>
            </div>
          )}
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
                  aria-label="Merge smaller groups under threshold"
                  aria-valuetext={
                    activeThreshold === 0 ? "Off" : fmt(Math.round(activeThreshold * 100))
                  }
                  className="ml-1.5 inline-block w-[110px] align-middle"
                  style={{ accentColor: "var(--y-blue)" }}
                  min={0}
                  max={stops.length - 1}
                  step={1}
                  value={sliderPos}
                  disabled={empty}
                  onChange={(e) => {
                    markSankeyAutoFitDone();
                    setThresholdDollars(stops[Number(e.target.value)] ?? 0);
                    setHover(null);
                  }}
                />
              </label>
            </Tooltip>
          </div>
        </div>
      </div>
  );
}
