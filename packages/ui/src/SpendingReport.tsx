"use client";

import { useState } from "react";
import type {
  MonthlySankeySeries,
  SpendingDimension,
  SpendingGroupFlow,
} from "@ynab/logic";
import { Panel } from "@ynab/theme";
import { ChartTip, useElementSize, useRafThrottledSet } from "./chartUtils.js";
import { SANKEY_SPOTLIGHT_TRANSITION_MS } from "./spending/sankeyConstants.js";
import type { Hover, SpendingItem, SpendingViewMode } from "./spending/types.js";
import { usePrefersReducedMotion } from "./spending/usePrefersReducedMotion.js";
import { SankeyDiagram } from "./spending/SankeyDiagram.js";
import { SpendingBars } from "./spending/SpendingBars.js";
import { SpendingControls } from "./spending/SpendingControls.js";
import { buildTipContent } from "./spending/SpendingTooltip.js";
import { useSankeyDerived } from "./spending/useSankeyDerived.js";
import { useSpendingData } from "./spending/useSpendingData.js";
import { useSpendingFilters } from "./spending/useSpendingFilters.js";

export {
  SANKEY_AUTOFIT_SESSION_KEY,
  SANKEY_BUCKET_HATCH_ID,
  SANKEY_INCOME_GRADIENT_ID_PREFIX,
  SANKEY_MIDDLE_GRADIENT_ID_PREFIX,
  SANKEY_RIBBON_DIM_OPACITY,
  SANKEY_RIBBON_HOVER_OPACITY,
  SANKEY_RIBBON_OPACITY,
  SANKEY_SPOTLIGHT_TRANSITION_MS,
  SOURCE_AMOUNT_PX_PER_CHAR,
  SOURCE_NAME_PX_PER_CHAR,
} from "./spending/sankeyConstants.js";
export type { SpendingItem, SpendingViewMode } from "./spending/types.js";

export function SpendingReport({
  categoryFlow,
  merchantFlow,
  income,
  // Monthly series behind each flow (see computeMonthlySankeySeries): the
  // Sankey funds spending chronologically from these, so an income can only
  // spotlight spending it could actually have funded. Absent (tests,
  // embeds), the Sankey falls back to the legacy proportional split.
  categorySeries,
  merchantSeries,
  // Budget view group names in Budget order (group.sort) — the "Group"
  // sort mode orders the Sankey's middle column by this.
  groupOrder = [],
  // Budget view category names in group-major sort order — the "Group"
  // sort mode orders categories within their parent group by this.
  // Merchants have no Budget position and stay value-descending.
  categoryOrder = [],
  initialView = "sankey",
  initialDimension = "categories",
  initialShowHeld = true,
}: {
  categoryFlow: SpendingGroupFlow;
  merchantFlow: SpendingGroupFlow;
  income: SpendingItem[];
  categorySeries?: MonthlySankeySeries;
  merchantSeries?: MonthlySankeySeries;
  groupOrder?: readonly string[];
  categoryOrder?: readonly string[];
  initialView?: SpendingViewMode;
  initialDimension?: SpendingDimension;
  initialShowHeld?: boolean;
}) {
  const filters = useSpendingFilters({
    initialView,
    initialDimension,
    initialShowHeld,
  });
  const [hover, setHover] = useState<Hover | null>(null);
  // Mousemove fires far more often than the display refreshes; coalescing
  // hover commits to one per frame (latest wins) keeps cursor sweeps from
  // queuing a full multi-hundred-element re-render per event — the same
  // throttle the other reports use. Hover-leaves ride the same throttle
  // (never a synchronous clear — Sankey and Bars alike): moving directly
  // from one element to another delivers leave+move as one commit, so arms
  // that stay dimmed never flash through rest in between and the Bars
  // tooltip never blinks off between rows.
  const pushHover = useRafThrottledSet(setHover);
  // Reduced-motion users get the instant (zero-duration) spotlight: same
  // semantics, no glide.
  const transitionMs = usePrefersReducedMotion() ? 0 : SANKEY_SPOTLIGHT_TRANSITION_MS;
  const { ref: chartRef, size: chartSize } = useElementSize<HTMLDivElement>();
  const data = useSpendingData({
    categoryFlow,
    merchantFlow,
    income,
    categorySeries,
    merchantSeries,
    groupOrder,
    categoryOrder,
    filters,
    chartSize,
    setHover,
  });
  const derived = useSankeyDerived({ data, hover });
  const tipContent = buildTipContent(hover, data, derived);

  return (
    <Panel
      title={filters.dimension === "categories" ? "Spending by Category" : "Spending by Merchant"}
      className="flex h-full min-h-0 flex-col"
      bodyClass="flex min-h-0 flex-1 flex-col p-0"
    >
      <SpendingControls filters={filters} data={data} setHover={setHover} />

      {filters.viewMode === "bars" ? (
        <SpendingBars data={data} derived={derived} pushHover={pushHover} />
      ) : (
        <SankeyDiagram
          filters={filters}
          data={data}
          derived={derived}
          chartRef={chartRef}
          chartSize={chartSize}
          transitionMs={transitionMs}
          pushHover={pushHover}
        />
      )}

      <ChartTip x={hover?.x ?? null} y={hover?.y ?? null} content={tipContent} />
    </Panel>
  );
}
