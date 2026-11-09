"use client";

import { useEffect, useMemo, useRef } from "react";
import type {
  MergedSpendingItem,
  MonthlySankeySeries,
  SpendingGroupFlow,
} from "@ynab/logic";
import {
  computeSankeyViewModel,
  excludeHeldCells,
  layoutGroupedIncomeSankey,
  mergeBelowThreshold,
  mergeGroupFlow,
  sankeyAutoFitThreshold,
  sankeyContentHeight,
  sankeyTargetColor,
  sankeyThresholdStep,
  sankeyThresholdStops,
  sortMergedGroupFlow,
  SANKEY_FUNDING_EPSILON_CENTS,
  SANKEY_LEFT_LABEL_INSET,
  SANKEY_NODE_GAP,
  SANKEY_NODE_MIN_HEIGHT,
  SANKEY_PAD_BOTTOM,
  SANKEY_PAD_TOP,
  SANKEY_SOURCE_GUTTER,
} from "@ynab/logic";
import {
  LABEL_ZONE,
  SOURCE_NAME_PX_PER_CHAR,
} from "./sankeyConstants.js";
import { markSankeyAutoFitDone, sankeyAutoFitDone } from "./sankeyHelpers.js";
import type { Hover, SpendingItem } from "./types.js";
import type { SpendingFilters } from "./useSpendingFilters.js";

export function useSpendingData({
  categoryFlow,
  merchantFlow,
  income,
  categorySeries,
  merchantSeries,
  groupOrder,
  categoryOrder,
  filters: {
    dimension,
    showHeld,
    sort,
    viewMode,
    thresholdDollars,
    setThresholdDollars,
  },
  chartSize,
  setHover,
}: {
  categoryFlow: SpendingGroupFlow;
  merchantFlow: SpendingGroupFlow;
  income: SpendingItem[];
  categorySeries?: MonthlySankeySeries;
  merchantSeries?: MonthlySankeySeries;
  groupOrder: readonly string[];
  categoryOrder: readonly string[];
  filters: SpendingFilters;
  chartSize: { width: number; height: number };
  setHover: (hover: Hover | null) => void;
}) {
  const flow = dimension === "categories" ? categoryFlow : merchantFlow;
  const raw = flow.targets;

  // One shared threshold merges all three columns, so the ceiling covers
  // the largest row on any side.
  const maxDollars = useMemo(
    () =>
      [...raw, ...flow.groups, ...income].reduce((m, s) => Math.max(m, s.value / 100), 0),
    [raw, flow.groups, income]
  );
  // The slider walks stepped stops (small increments first, larger jumps
  // later — see SANKEY_THRESHOLD_STOPS) instead of raw dollars. The stored
  // dollar value snaps to its nearest stop, so values saved before the
  // stepped slider keep working.
  const stops = useMemo(() => sankeyThresholdStops(maxDollars), [maxDollars]);
  const sliderPos = sankeyThresholdStep(stops, thresholdDollars);
  const activeThreshold = stops[sliderPos] ?? 0;

  const merged = useMemo(
    () =>
      mergeGroupFlow(flow.groups, flow.targets, flow.links, Math.round(activeThreshold * 100)),
    [flow, activeThreshold]
  );
  const mergedIncome = useMemo(
    () => mergeBelowThreshold(income, Math.round(activeThreshold * 100)),
    [income, activeThreshold]
  );
  const series = dimension === "categories" ? categorySeries : merchantSeries;
  // Sankey-scoped inputs: the Still-held toggle strips held cells here — a
  // logic-level transform of the flow+series pair, never render-side
  // filtering — so funding, merging, sorting, and the Remaining plug all
  // see consistent inputs. Shown (the default) passes the full pair
  // through untouched.
  const sankeyInputs = useMemo(
    () => (showHeld ? { flow, series } : excludeHeldCells(flow, series)),
    [showHeld, flow, series]
  );
  const sankeyFlow = sankeyInputs.flow;
  const sankeySeries = sankeyInputs.series;
  // The Sankey's own merged columns: the full `merged` when shown (same
  // reference — the default path is today's behavior exactly), a
  // held-excluded merge when hidden. Header totals and Bars rows always
  // read `merged`.
  const sankeyMerged = useMemo(
    () =>
      showHeld
        ? merged
        : mergeGroupFlow(
            sankeyFlow.groups,
            sankeyFlow.targets,
            sankeyFlow.links,
            Math.round(activeThreshold * 100)
          ),
    [showHeld, merged, sankeyFlow, activeThreshold]
  );
  // Column order for the Sankey layout (a permutation — sums and marginals
  // are untouched, so the header totals and Bars rows read `merged`).
  const ordered = useMemo(
    () => sortMergedGroupFlow(sankeyMerged, groupOrder, sort, categoryOrder),
    [sankeyMerged, groupOrder, sort, categoryOrder]
  );
  // Time-aware Sankey model: the merged + sorted columns from above
  // (the same merge/sort calls Bars uses, so the two views cannot disagree
  // while held rows show) plus the chronological funding of each cell.
  // Null without series — the layout then uses the legacy split.
  const timeAware = useMemo(
    () =>
      sankeySeries == null
        ? null
        : computeSankeyViewModel(sankeyFlow, income, sankeySeries, {
            thresholdCents: Math.round(activeThreshold * 100),
            groupOrder,
            sort,
            categoryOrder,
          }),
    [sankeyFlow, income, sankeySeries, activeThreshold, groupOrder, sort, categoryOrder]
  );
  // The header "(N in Other)" note covers all three merged columns.
  const mergedOtherCount = merged.otherCount + mergedIncome.otherCount;

  // Header totals: plain sums (merging preserves sums and breakdowns never
  // emit non-positive values, so these match the layout's filtered totals).
  const totals = useMemo(() => {
    const incomeTotal = mergedIncome.items.reduce((s, x) => s + x.value, 0);
    const spendingTotal = merged.targets.reduce((s, x) => s + x.value, 0);
    return {
      incomeTotal,
      spendingTotal,
      flowTotal: Math.max(incomeTotal, spendingTotal),
      remaining: incomeTotal - spendingTotal,
    };
  }, [merged.targets, mergedIncome.items]);
  const spentTotal = totals.spendingTotal;

  // Bars rows: spending shares (unchanged by the income side). Each row
  // keeps its own full-brightness stable color — NOT the Sankey family
  // shades: those darken toward black to stay readable at translucent
  // ribbon opacity, but at the Bars' full opacity they read too dark
  // (task-31 restore of the pre-task-19 palette). Buckets render slate by
  // flag (never by name, so a literal "Other" row keeps its own color).
  const rows = useMemo(() => {
    const maxSpend = merged.targets.reduce((m, s) => Math.max(m, s.value), 1);
    return merged.targets.map((s, i) => {
      const share = spentTotal !== 0 ? s.value / spentTotal : 0;
      const pctOfTotal = Math.round(share * 100);
      const pctOfMax = (s.value / maxSpend) * 100;
      const color = sankeyTargetColor({ name: s.name, bucket: s.bucket === true, isPlug: false });
      return { ...s, share, pctOfTotal, pctOfMax, color, i };
    });
  }, [merged.targets, spentTotal]);

  // Income rows for the layout: the same Under threshold folds small
  // income sources into an Other bucket on the left, and the proportional
  // link math runs on the merged columns (conservation preserved).
  const incomeRows: MergedSpendingItem[] = mergedIncome.items;

  const empty = incomeRows.length === 0 && merged.targets.length === 0;
  // Sankey-scoped emptiness for the chart below: hiding held rows can leave
  // the Sankey with nothing to draw (only-held data, no income) while Bars
  // still lists the held rows — so the Sankey's own empty state reads the
  // held-excluded columns. Identical to `empty` while held rows show.
  const sankeyEmpty = incomeRows.length === 0 && sankeyMerged.targets.length === 0;
  const nounSingular = dimension === "categories" ? "category" : "merchant";
  const nounPlural = dimension === "categories" ? "categories" : "merchants";
  // Epsilon rule: with full partitioning (every dollar spent or held) Left
  // reconciles to exactly zero — but fractional-cent amounts can leave
  // allocator-scale dust on either side of it. Anything under the
  // allocator's own epsilon (SANKEY_FUNDING_EPSILON_CENTS) is not money, so
  // the header clamps it to $0 and reads "Left", never "Over" — agreeing
  // with the layout's plug, which snaps the same way via
  // allocateCellFunding. A real shortfall (≥ one cent) still reads "Over".
  const remaining =
    Math.abs(totals.remaining) < SANKEY_FUNDING_EPSILON_CENTS ? 0 : totals.remaining;

  // The chart grows past the viewport when rows need more room (the
  // container scrolls) instead of crushing labels onto each other. Counts
  // come from the Sankey's own merged columns (plus the future Remaining
  // plug, detected against the held-excluded spending so a refolded plug
  // still reserves its row): merged lengths can only overestimate the
  // layout's filtered columns, erring toward harmless slack rather than
  // crushed rows.
  const contentH = useMemo(() => {
    const sankeySpendingTotal = sankeyMerged.targets.reduce((s, x) => s + x.value, 0);
    return sankeyContentHeight(
      Math.max(
        incomeRows.length,
        sankeyMerged.groups.length,
        sankeyMerged.targets.length + (totals.incomeTotal > sankeySpendingTotal ? 1 : 0)
      ),
      chartSize.height
    );
  }, [incomeRows.length, sankeyMerged, totals.incomeTotal, chartSize.height]);

  // Math-first: the layout owns EVERYTHING drawn below — node bars, ribbon
  // paths, sub-ribbon paths, bar gradient stops, fills, and label anchors —
  // and this component renders those objects verbatim with no geometry,
  // subdivision, path, color, or label math of its own. A visual glitch is
  // fixed in the layout (unit-tested in @ynab/logic), never here.
  const sankey = useMemo(() => {
    if (chartSize.width <= 0 || chartSize.height <= 0) return null;
    return layoutGroupedIncomeSankey(
      timeAware?.sources ?? incomeRows,
      timeAware?.groups ?? ordered.groups,
      timeAware?.targets ?? ordered.targets,
      timeAware?.links ?? ordered.links,
      {
        width: chartSize.width,
        height: contentH,
        padLeft: SANKEY_SOURCE_GUTTER,
        padRight: LABEL_ZONE,
        padTop: SANKEY_PAD_TOP,
        padBottom: SANKEY_PAD_BOTTOM,
        nodeGap: SANKEY_NODE_GAP,
        minNodeHeight: SANKEY_NODE_MIN_HEIGHT,
        // Both groupings subdivide each income→middle band into one
        // sub-ribbon per downstream cell (layout leftCells), so each color
        // crosses the middle as one contiguous block at its cell's thickness:
        // the same through-color flows from the right column all the way to
        // income in Categories and Merchants alike — and with time-aware
        // funding, only for income that could actually have funded the cell.
        leftDetail: "cells",
        ...(timeAware != null ? { leftHop: timeAware.left } : {}),
      }
    );
  }, [incomeRows, ordered.groups, ordered.targets, ordered.links, timeAware, chartSize.width, chartSize.height, contentH]);

  // Initial-load auto-fit: raise the Under threshold to the smallest stop
  // whose merged columns fit the measured container, so the Sankey shows
  // fully with no amounts under the fold (or as close as merging allows).
  // Raise-only — a stored threshold that already fits is the user's choice
  // and stays — and once per tab session, so later remounts (report tab
  // switches) and resizes never fight the user's in-session slider.
  const autoFittedRef = useRef(false);
  useEffect(() => {
    if (autoFittedRef.current || sankeyAutoFitDone()) return;
    if (viewMode !== "sankey") return;
    if (chartSize.width <= 0 || chartSize.height <= 0) return;
    if (empty) return;
    autoFittedRef.current = true;
    markSankeyAutoFitDone();
    const best = sankeyAutoFitThreshold(
      sankeyFlow.groups,
      sankeyFlow.targets,
      sankeyFlow.links,
      income,
      stops,
      chartSize.height,
      sankeySeries
    );
    if (best > activeThreshold) {
      setThresholdDollars(best);
      setHover(null);
    }
  }, [
    viewMode,
    chartSize.width,
    chartSize.height,
    empty,
    sankeyFlow,
    income,
    sankeySeries,
    stops,
    activeThreshold,
    setThresholdDollars,
  ]);

  // Left-column names truncate to fit the pixel budget between the label
  // anchor and the minimum left inset, so even long names (with ellipsis)
  // end inside the visible area instead of clipping past x=0.
  const sourceLabelMaxChars = Math.max(
    8,
    Math.floor(
      ((sankey?.sourceLabelX ?? 0) - SANKEY_LEFT_LABEL_INSET) / SOURCE_NAME_PX_PER_CHAR
    )
  );

  return {
    stops,
    sliderPos,
    activeThreshold,
    merged,
    mergedOtherCount,
    totals,
    spentTotal,
    rows,
    empty,
    sankeyEmpty,
    nounSingular,
    nounPlural,
    remaining,
    contentH,
    sankey,
    sourceLabelMaxChars,
  };
}

export type SpendingData = ReturnType<typeof useSpendingData>;
