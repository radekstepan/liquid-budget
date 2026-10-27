/**
 * sankey.ts
 *
 * Pure business logic for the Spending Flow (Sankey) report:
 * outflow aggregation by category or merchant, small-value merging into an
 * "Other" bucket, and a dependency-free two-column Sankey layout.
 * No React, no DB access.
 */

import type { BudgetData } from "./types.js";
import { num } from "./format.js";
import { isIncomeTransaction } from "./budget-engine.js";

export type SpendingDimension = "categories" | "merchants";

export type SpendingBreakdownItem = {
  name: string;
  /** Net outflow in cents (always > 0). */
  value: number;
};

/**
 * Aggregate net outflows over a contiguous month range (inclusive), grouped
 * by category name or merchant (payee) name.
 *
 * Semantics (shared by both dimensions):
 * - Split-parent rows are excluded; only split children carry outflows.
 * - Income transactions are excluded (in category mode this is a no-op:
 *   income rows are uncategorized by definition).
 * - Refunds/returns (positive amounts on non-income rows) net against the
 *   group's outflows; groups netting to <= 0 are dropped.
 * - Categorized transfers count as spending in category mode (matches the
 *   legacy Spending by Category tab); in merchant mode every non-income
 *   outflow row counts, categorized or not.
 *
 * Returns items sorted by value descending.
 */
export function computeSpendingBreakdown(
  data: BudgetData,
  startMonth: string,
  endMonth: string,
  dimension: SpendingDimension
): SpendingBreakdownItem[] {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;

  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const catMap = new Map(data.categories.map((c) => [c.id, c.name]));
  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));

  const byGroup = new Map<string, number>();
  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    if (isIncomeTransaction(t, accountMap)) continue;
    const mk = t.date.slice(0, 7);
    if (mk < actualStart || mk > actualEnd) continue;

    let name: string;
    if (dimension === "categories") {
      if (t.categoryId == null) continue;
      name = catMap.get(t.categoryId) ?? "—";
    } else {
      const payee = t.payee.trim();
      name = payee === "" ? "—" : payee;
    }
    // Amount < 0 is outflow (+ netOutflow); amount > 0 is a refund (- netOutflow).
    byGroup.set(name, (byGroup.get(name) ?? 0) - num(t.amount));
  }

  return [...byGroup.entries()]
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

export type MergedSpendingItem = SpendingBreakdownItem & {
  /** How many breakdown groups this row represents (1, or N for "Other"). */
  mergedCount: number;
};

export type MergedSpending = {
  items: MergedSpendingItem[];
  /** Number of groups folded into "Other" (0 when no merge happened). */
  otherCount: number;
  /** Total cents folded into "Other" (0 when no merge happened). */
  otherValue: number;
};

/** Label used for the merged bucket. Exported so views and tests agree. */
export const OTHER_BUCKET_LABEL = "Other";

/**
 * Fold every item strictly below `thresholdCents` into a single trailing
 * "Other" bucket (kept items stay sorted descending; "Other" always sorts
 * last so the chart order is stable).
 *
 * - `thresholdCents <= 0` disables merging (all items pass through).
 * - A threshold above every value merges everything into one "Other" row.
 * - Empty input yields empty output (no phantom "Other").
 */
export function mergeBelowThreshold(
  items: SpendingBreakdownItem[],
  thresholdCents: number
): MergedSpending {
  if (thresholdCents <= 0 || items.length === 0) {
    return {
      items: items.map((it) => ({ ...it, mergedCount: 1 })),
      otherCount: 0,
      otherValue: 0,
    };
  }
  const kept: MergedSpendingItem[] = [];
  let otherCount = 0;
  let otherValue = 0;
  for (const it of items) {
    if (it.value < thresholdCents) {
      otherCount += 1;
      otherValue += it.value;
    } else {
      kept.push({ ...it, mergedCount: 1 });
    }
  }
  if (otherCount > 0) {
    kept.push({ name: OTHER_BUCKET_LABEL, value: otherValue, mergedCount: otherCount });
  }
  return { items: kept, otherCount, otherValue };
}

export type SankeyGeometryOptions = {
  /** Total SVG width/height in px. */
  width: number;
  height: number;
  /** Width of the source and target node bars. Defaults to 14. */
  nodeWidth?: number;
  /** Vertical gap between target nodes. Defaults to 6. */
  nodeGap?: number;
  /** Minimum drawn node height so tiny flows stay hoverable. Defaults to 8. */
  minNodeHeight?: number;
  /** Left gutter before the source node. Defaults to 8. */
  padLeft?: number;
  /** Right gutter after the target nodes (label zone). Defaults to 8. */
  padRight?: number;
  /** Top/bottom gutters. Default to 8. */
  padTop?: number;
  padBottom?: number;
};

export type SankeyNodeLayout = {
  name: string;
  value: number;
  mergedCount: number;
  share: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type SankeyLinkLayout = {
  name: string;
  value: number;
  mergedCount: number;
  /** Source band vertical span (left edge). */
  sy0: number;
  sy1: number;
  /** Target band vertical span (right edge) — equals the node span. */
  ty0: number;
  ty1: number;
  x0: number;
  x1: number;
  /** Closed ribbon path from the source band to the target band. */
  d: string;
};

export type SankeyLayout = {
  total: number;
  /** Source ("Total") node bar; h is 0 when there is no data. */
  source: { x: number; y: number; w: number; h: number };
  nodes: SankeyNodeLayout[];
  links: SankeyLinkLayout[];
  /** x where target-node labels should start (right of the node column). */
  labelX: number;
};

/**
 * Lay out a two-column Sankey: one source node ("Total") on the left, one
 * target node per item on the right, connected by bezier ribbons.
 *
 * Invariants (covered by unit tests):
 * - Every link's source band height equals its target node's height
 *   (`sy1 - sy0 === node.h`), so ribbons never over/under-fill a node.
 * - Target nodes stack top-down in input order with `nodeGap` between them
 *   and stay inside the padded plot area.
 * - The source node spans exactly the stacked bands (first band top to last
 *   band bottom), so it is always a subset of the plot area too.
 * - Empty input (or non-positive total) yields an empty layout with
 *   `total: 0` and zero-height source — never NaN geometry.
 */
export function layoutSankey(
  items: MergedSpendingItem[],
  opts: SankeyGeometryOptions
): SankeyLayout {
  const {
    width,
    height,
    nodeWidth = 14,
    nodeGap = 6,
    minNodeHeight = 8,
    padLeft = 8,
    padRight = 8,
    padTop = 8,
    padBottom = 8,
  } = opts;

  const empty: SankeyLayout = {
    total: 0,
    source: { x: padLeft, y: padTop, w: nodeWidth, h: 0 },
    nodes: [],
    links: [],
    labelX: width - padRight,
  };

  const total = items.reduce((s, it) => s + it.value, 0);
  if (items.length === 0 || total <= 0 || width <= 0 || height <= 0) {
    return empty;
  }

  const availH = Math.max(0, height - padTop - padBottom);
  // Pathological many-node case: the gaps alone can exceed the plot, so
  // shrink the effective gap to leave at least 1px per node.
  const n = items.length;
  const gap =
    n > 1 && nodeGap * (n - 1) > availH ? Math.max(0, (availH - n) / (n - 1)) : nodeGap;
  const gapsH = gap * Math.max(0, n - 1);
  const bandH = Math.max(0, availH - gapsH);

  // Proportional heights, then enforce the minimum by taking from the
  // largest nodes first (largest-first keeps small-but-visible nodes exact).
  const heights = items.map((it) => (it.value / total) * bandH);
  const minH = Math.min(minNodeHeight, items.length > 0 ? bandH / items.length : 0);
  if (minH > 0) {
    const below = heights.filter((h) => h < minH).length;
    if (below > 0) {
      let short = 0;
      for (const h of heights) {
        if (h < minH) short += minH - h;
      }
      const donors = heights
        .map((h, idx) => ({ h, idx }))
        .filter((o) => o.h > minH)
        .sort((a, b) => b.h - a.h);
      for (const o of donors) {
        if (short <= 0) break;
        const give = Math.min(o.h - minH, short);
        heights[o.idx] = (heights[o.idx] ?? o.h) - give;
        short -= give;
      }
      for (let i = 0; i < heights.length; i++) {
        if ((heights[i] ?? 0) < minH) heights[i] = minH;
      }
      // Pathological case (everything tiny): rescale to fit the plot.
      const sum = heights.reduce((a, h) => a + h, 0);
      if (sum > bandH && sum > 0) {
        const k = bandH / sum;
        for (let i = 0; i < heights.length; i++) heights[i] = (heights[i] ?? 0) * k;
      }
    }
  }

  const nodeX = Math.max(padLeft + nodeWidth + 24, width - padRight - nodeWidth);
  const sourceX = padLeft;
  const linkX0 = sourceX + nodeWidth;
  const linkX1 = nodeX;
  const midX = (linkX0 + linkX1) / 2;

  const nodes: SankeyNodeLayout[] = [];
  const links: SankeyLinkLayout[] = [];
  let y = padTop;
  let sy = padTop;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const h = Math.max(0, heights[i] ?? 0);
    const share = total !== 0 ? it.value / total : 0;
    nodes.push({ name: it.name, value: it.value, mergedCount: it.mergedCount, share, x: nodeX, y, w: nodeWidth, h });
    const sy0 = sy;
    const sy1 = sy + h;
    const ty0 = y;
    const ty1 = y + h;
    const f = (n: number) => n.toFixed(2);
    links.push({
      name: it.name,
      value: it.value,
      mergedCount: it.mergedCount,
      sy0,
      sy1,
      ty0,
      ty1,
      x0: linkX0,
      x1: linkX1,
      d:
        `M ${f(linkX0)} ${f(sy0)} C ${f(midX)} ${f(sy0)} ${f(midX)} ${f(ty0)} ${f(linkX1)} ${f(ty0)} ` +
        `L ${f(linkX1)} ${f(ty1)} C ${f(midX)} ${f(ty1)} ${f(midX)} ${f(sy1)} ${f(linkX0)} ${f(sy1)} Z`,
    });
    y += h + gap;
    sy += h + gap;
  }

  const stackedH = y - gap - padTop;
  return {
    total,
    source: { x: sourceX, y: padTop, w: nodeWidth, h: Math.max(0, stackedH) },
    nodes,
    links,
    labelX: nodeX + nodeWidth + 8,
  };
}
