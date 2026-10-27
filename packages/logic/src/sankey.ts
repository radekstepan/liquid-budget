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

/**
 * Aggregate income over a contiguous month range (inclusive), grouped by
 * source (payee) name. Mirrors computeSpendingBreakdown with the predicate
 * flipped: only income rows (uncategorized, positive, on-budget — see
 * isIncomeTransaction) count; split parents are excluded. Negative
 * uncategorized rows are outflows, not corrections, so they are excluded
 * here (merchant spending picks them up instead).
 *
 * Returns items sorted by value descending.
 */
export function computeIncomeBreakdown(
  data: BudgetData,
  startMonth: string,
  endMonth: string
): SpendingBreakdownItem[] {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;

  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));

  const bySource = new Map<string, number>();
  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    if (!isIncomeTransaction(t, accountMap)) continue;
    const mk = t.date.slice(0, 7);
    if (mk < actualStart || mk > actualEnd) continue;

    const payee = t.payee.trim();
    const name = payee === "" ? "—" : payee;
    bySource.set(name, (bySource.get(name) ?? 0) + num(t.amount));
  }

  return [...bySource.entries()]
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

/** Label for the unspent-income node on the target (right) side. */
export const REMAINING_LABEL = "Remaining";
/** Label for the income shortfall node on the source (left) side. */
export const OVERSPENT_LABEL = "Overspent";

export type FlowColumns = {
  /** Income sources, plus an Overspent plug when spending exceeds income. */
  sources: MergedSpendingItem[];
  /** Spending groups, plus a Remaining plug when income exceeds spending. */
  targets: MergedSpendingItem[];
  incomeTotal: number;
  spendingTotal: number;
  /** Conserved flow: both columns sum to this. */
  flowTotal: number;
};

/**
 * Assemble balanced Sankey columns: the plugs keep both sides summing to
 * max(income, spending) so inflow always equals outflow. Exactly one plug
 * exists at most (never both); equal totals need none.
 */
export function buildFlowColumns(
  spending: MergedSpendingItem[],
  income: SpendingBreakdownItem[]
): FlowColumns {
  const incomeTotal = income.reduce((s, it) => s + it.value, 0);
  const spendingTotal = spending.reduce((s, it) => s + it.value, 0);
  const flowTotal = Math.max(incomeTotal, spendingTotal);

  const sources: MergedSpendingItem[] = income.map((it) => ({ ...it, mergedCount: 1 }));
  if (spendingTotal > incomeTotal) {
    sources.push({ name: OVERSPENT_LABEL, value: spendingTotal - incomeTotal, mergedCount: 1 });
  }
  const targets: MergedSpendingItem[] = [...spending];
  if (incomeTotal > spendingTotal) {
    targets.push({ name: REMAINING_LABEL, value: incomeTotal - spendingTotal, mergedCount: 1 });
  }
  return { sources, targets, incomeTotal, spendingTotal, flowTotal };
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

// ---------------------------------------------------------------------------
// Readability contract shared with the view: minimum geometry that keeps
// two-line node labels from overlapping each other and keeps the TOTAL
// captions clear of the source bar. The view must size the chart with
// sankeyContentHeight and pass these spacings into layoutSankey.
// ---------------------------------------------------------------------------

/** Minimum node height: a two-line label (name + amount) needs a 24px row. */
export const SANKEY_NODE_MIN_HEIGHT = 24;
/** Vertical gap between nodes; pitch = height + gap = 32px per row. */
export const SANKEY_NODE_GAP = 8;
/** Minimum vertical pitch per node so adjacent two-line labels never touch. */
export const SANKEY_MIN_PITCH = SANKEY_NODE_MIN_HEIGHT + SANKEY_NODE_GAP;
/** Top/bottom gutters: room for the TOTAL caption above, amount below. */
export const SANKEY_PAD_TOP = 28;
export const SANKEY_PAD_BOTTOM = 28;
/** Left gutter: TOTAL caption + amount right-align into it, clear of the bar. */
export const SANKEY_SOURCE_GUTTER = 112;

/**
 * Chart height honoring the minimum pitch: grows past the container (the
 * view scrolls) instead of crushing rows when there are many groups.
 */
export function sankeyContentHeight(itemCount: number, containerHeight: number): number {
  return Math.max(
    containerHeight,
    itemCount * SANKEY_MIN_PITCH + SANKEY_PAD_TOP + SANKEY_PAD_BOTTOM
  );
}

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

export type IncomeSankeyLayout = {
  incomeTotal: number;
  spendingTotal: number;
  /** Conserved flow: both columns sum to this. */
  flowTotal: number;
  /** Middle ("Total") node spanning both stacks. */
  middle: { x: number; y: number; w: number; h: number };
  /** Left column: one bar per income source. */
  sources: SankeyNodeLayout[];
  /** Right column: one bar per spending group. */
  targets: SankeyNodeLayout[];
  /** Ribbons from each source bar into the middle node. */
  inLinks: SankeyLinkLayout[];
  /** Ribbons from the middle node out to each target bar. */
  outLinks: SankeyLinkLayout[];
  /** x for end-anchored income labels (left of the source column). */
  sourceLabelX: number;
  /** x for start-anchored target labels (right of the target column). */
  targetLabelX: number;
};

/**
 * Lay out a three-column money-flow Sankey: income sources (left) flow into
 * a middle Total node, which flows out to spending groups (right). Both
 * columns must sum to the same total (see buildFlowColumns); each column
 * stacks independently, top-aligned, reusing layoutSankey per side so the
 * band math stays identical. The left side's per-source bars are re-derived
 * from its bands (a shared source bar would be wrong there).
 *
 * Empty input on one side yields that side empty; both empty yields a
 * zero-height middle — never NaN geometry.
 */
export function layoutIncomeSankey(
  sources: MergedSpendingItem[],
  targets: MergedSpendingItem[],
  opts: SankeyGeometryOptions
): IncomeSankeyLayout {
  const { width, nodeWidth = 14, padLeft = 8, padTop = 8 } = opts;
  const padRight = opts.padRight ?? 8;
  const zoneL = padLeft + nodeWidth;
  const zoneR = width - padRight - nodeWidth;
  const middleX = Math.max(zoneL + 24, (zoneL + zoneR) / 2 - nodeWidth / 2);

  // Left flow (sources -> middle): keep the bands; the per-source bars are
  // re-derived below from each band's source span.
  const left = layoutSankey(sources, { ...opts, width: middleX + nodeWidth, padRight: 0 });
  // Right flow (middle -> targets): its source bar IS the middle node.
  const right = layoutSankey(targets, { ...opts, padLeft: middleX });

  const srcNodes: SankeyNodeLayout[] = sources.map((s, i) => {
    const link = left.links[i];
    return {
      name: s.name,
      value: s.value,
      mergedCount: s.mergedCount,
      share: left.total > 0 ? s.value / left.total : 0,
      x: padLeft,
      y: link?.sy0 ?? padTop,
      w: nodeWidth,
      h: link ? Math.max(0, link.sy1 - link.sy0) : 0,
    };
  });

  const incomeTotal = sources.reduce((s, it) => s + it.value, 0);
  const spendingTotal = targets.reduce((s, it) => s + it.value, 0);
  return {
    incomeTotal,
    spendingTotal,
    flowTotal: Math.max(incomeTotal, spendingTotal),
    middle: {
      x: middleX,
      y: padTop,
      w: nodeWidth,
      h: Math.max(left.source.h, right.source.h),
    },
    sources: srcNodes,
    targets: right.nodes,
    inLinks: left.links,
    outLinks: right.links,
    sourceLabelX: padLeft - 10,
    targetLabelX: right.labelX,
  };
}
