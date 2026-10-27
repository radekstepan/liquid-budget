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
/**
 * Label for an expense's unfunded slice. When spending exceeds income there
 * is no extra income source (money is not invented) — each expense is only
 * partly funded, and the shortfall renders as a distinct neutral segment on
 * the expense side. "Shortfall" names the gap (spent more than earned, the
 * difference covered from savings or debt) without implying new income.
 */
export const SHORTFALL_LABEL = "Shortfall";

export type DirectFlowLinkValue = {
  sourceIndex: number;
  targetIndex: number;
  /** Cents on this ribbon (funded flow only; always > 0). */
  value: number;
};

export type DirectFlowModel = {
  incomeTotal: number;
  spendingTotal: number;
  /** Income sources with value > 0, in input order; link.sourceIndex keys here. */
  sources: MergedSpendingItem[];
  /**
   * Spending groups plus a trailing Remaining plug when income exceeds
   * spending; link.targetIndex, funded, and unfunded key here. There is
   * deliberately no plug for the reverse imbalance (see SHORTFALL_LABEL).
   */
  targets: MergedSpendingItem[];
  /** Funded cents per target; incoming links sum to this. */
  funded: number[];
  /** Unfunded cents per target (0 unless spending exceeds income). */
  unfunded: number[];
  /** One ribbon per (source, target) pair with positive flow, target-major. */
  links: DirectFlowLinkValue[];
};

/**
 * Fungible proportional allocation of income to expenses: money has no
 * identity, so every expense draws from every income source in proportion to
 * that source's share of total income. Each link's value is
 * `funded(target) * source.value / incomeTotal`.
 *
 * Imbalance handling:
 * - Income exceeds spending: the surplus lands in a trailing Remaining
 *   target, fed proportionally like any other expense.
 * - Spending exceeds income: every expense is funded pro-rata at the uniform
 *   coverage ratio `incomeTotal / spendingTotal`; the remainder per expense
 *   is reported as unfunded. No phantom income is invented.
 *
 * Conservation (covered by unit tests): links out of a source sum to that
 * source's value; links into a target sum to that target's funded value.
 * Items with value <= 0 are dropped (they would be phantom nodes).
 */
export function computeDirectFlowLinks(
  sources: MergedSpendingItem[],
  spending: MergedSpendingItem[]
): DirectFlowModel {
  const src = sources.filter((s) => s.value > 0);
  const spend = spending.filter((t) => t.value > 0);
  const incomeTotal = src.reduce((s, it) => s + it.value, 0);
  const spendingTotal = spend.reduce((s, it) => s + it.value, 0);

  const targets: MergedSpendingItem[] = [...spend];
  if (incomeTotal > spendingTotal) {
    targets.push({ name: REMAINING_LABEL, value: incomeTotal - spendingTotal, mergedCount: 1 });
  }

  const coverage = spendingTotal > 0 ? Math.min(1, incomeTotal / spendingTotal) : 1;
  const funded = targets.map((t) => t.value * coverage);
  const unfunded = targets.map((t, j) => t.value - (funded[j] ?? 0));

  const links: DirectFlowLinkValue[] = [];
  if (incomeTotal > 0) {
    for (let j = 0; j < targets.length; j++) {
      const fj = funded[j] ?? 0;
      if (!(fj > 0)) continue;
      for (let i = 0; i < src.length; i++) {
        const value = fj * ((src[i]?.value ?? 0) / incomeTotal);
        if (value > 0) links.push({ sourceIndex: i, targetIndex: j, value });
      }
    }
  }
  return { incomeTotal, spendingTotal, sources: src, targets, funded, unfunded, links };
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
/** Gap between end-anchored left-column labels and the source bar column. */
export const SANKEY_SOURCE_LABEL_GAP = 8;
/** Minimum clear space between any left-column label and the SVG left edge. */
export const SANKEY_LEFT_LABEL_INSET = 8;
/**
 * Left gutter: room for two-line income labels (truncated name + $ amount)
 * ending SANKEY_SOURCE_LABEL_GAP before the bars while starting no closer
 * than SANKEY_LEFT_LABEL_INSET to x=0.
 */
export const SANKEY_SOURCE_GUTTER = 160;

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
 * Resolve per-node pixel heights for a column of `values` filling `bandH`
 * (the plot height minus gaps): proportional shares first, then a minimum
 * height enforced by taking from the largest nodes first (largest-first
 * keeps small-but-visible nodes exact), then a rescale to fit when even the
 * minimums overflow (pathological all-tiny case). The result always sums to
 * at most `bandH` and never contains NaN.
 */
function resolveNodeHeights(values: number[], bandH: number, minNodeHeight: number): number[] {
  const total = values.reduce((s, v) => s + v, 0);
  if (values.length === 0 || total <= 0 || bandH <= 0) {
    return values.map(() => 0);
  }
  const heights = values.map((v) => (v / total) * bandH);
  const minH = Math.min(minNodeHeight, bandH / values.length);
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
  return heights;
}

/** Closed bezier ribbon path from the source band to the target band. */
function ribbonPath(
  x0: number,
  x1: number,
  sy0: number,
  sy1: number,
  ty0: number,
  ty1: number
): string {
  const f = (n: number) => n.toFixed(2);
  const midX = (x0 + x1) / 2;
  return (
    `M ${f(x0)} ${f(sy0)} C ${f(midX)} ${f(sy0)} ${f(midX)} ${f(ty0)} ${f(x1)} ${f(ty0)} ` +
    `L ${f(x1)} ${f(ty1)} C ${f(midX)} ${f(ty1)} ${f(midX)} ${f(sy1)} ${f(x0)} ${f(sy1)} Z`
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

  const heights = resolveNodeHeights(
    items.map((it) => it.value),
    bandH,
    minNodeHeight
  );

  const nodeX = Math.max(padLeft + nodeWidth + 24, width - padRight - nodeWidth);
  const sourceX = padLeft;
  const linkX0 = sourceX + nodeWidth;
  const linkX1 = nodeX;

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
      d: ribbonPath(linkX0, linkX1, sy0, sy1, ty0, ty1),
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

export type DirectSankeyTargetNode = SankeyNodeLayout & {
  /** Funded cents; incoming ribbons sum to this. */
  fundedValue: number;
  /** Unfunded cents (0 unless spending exceeds income). */
  unfundedValue: number;
  /** Height of the unfunded segment at the node's bottom edge (px). */
  unfundedH: number;
};

export type DirectSankeyLinkLayout = SankeyLinkLayout & {
  sourceIndex: number;
  targetIndex: number;
  sourceName: string;
  targetName: string;
};

export type DirectIncomeSankeyLayout = {
  incomeTotal: number;
  spendingTotal: number;
  /** Height-scale denominator: max(income, spending). */
  flowTotal: number;
  /** Left column: one bar per income source. */
  sources: SankeyNodeLayout[];
  /** Right column: one bar per spending group (plus Remaining when unspent). */
  targets: DirectSankeyTargetNode[];
  /** One ribbon per (source, target) pair, target-major. */
  links: DirectSankeyLinkLayout[];
  /** x for end-anchored income labels (left of the source column). */
  sourceLabelX: number;
  /** x for start-anchored target labels (right of the target column). */
  targetLabelX: number;
};

/**
 * Lay out a two-column direct money-flow Sankey: income sources (left) flow
 * DIRECTLY into spending groups (right) — there is no middle Total bar.
 * Ribbon values come from computeDirectFlowLinks (fungible proportional
 * allocation), so each expense visibly draws from each income.
 *
 * Geometry contract (covered by unit tests):
 * - The expense (right) column owns the pixel scale: target bars resolve via
 *   resolveNodeHeights, incoming bands exactly fill each bar's funded region
 *   (top-aligned; the unfunded segment, if any, sits at the bar's bottom),
 *   and bands within a bar split its height in proportion to their values.
 * - The income (left) column wraps its outgoing bands: each source bar is
 *   exactly its bands' height, water-filled up to the minimum node height
 *   from leftover plot space (never overflowing it).
 * - Every ribbon has equal height at both ends (no taper): `sy1 - sy0` sums
 *   to the source bar's band region and `ty1 - ty0` to the target's funded
 *   region. Bands within a source run in target order; bands within a target
 *   run in source order.
 * - Node `share` is value/flowTotal on both sides, matching drawn heights.
 * - Degenerate input (no positive values, or a non-positive dimension)
 *   yields no nodes — never NaN geometry.
 *
 * Callers should size height with sankeyContentHeight over the LONGER column
 * (see the readability contract above); the layout never exceeds the padded
 * plot area, but rows below the minimum pitch may touch.
 */
export function layoutDirectIncomeSankey(
  sources: MergedSpendingItem[],
  spending: MergedSpendingItem[],
  opts: SankeyGeometryOptions
): DirectIncomeSankeyLayout {
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

  const model = computeDirectFlowLinks(sources, spending);
  const { incomeTotal, spendingTotal } = model;
  const flowTotal = Math.max(incomeTotal, spendingTotal);

  if (model.targets.length === 0 || flowTotal <= 0 || width <= 0 || height <= 0) {
    return {
      incomeTotal,
      spendingTotal,
      flowTotal,
      sources: [],
      targets: [],
      links: [],
      sourceLabelX: padLeft - SANKEY_SOURCE_LABEL_GAP,
      targetLabelX: width - padRight,
    };
  }

  const srcItems = model.sources;
  const tgtItems = model.targets;
  const nS = srcItems.length;
  const nT = tgtItems.length;
  const nMax = Math.max(nS, nT);

  const availH = Math.max(0, height - padTop - padBottom);
  // The longer column's gaps cap the shared gap so both columns fit.
  let gap = nodeGap;
  if (nMax > 1 && gap * (nMax - 1) > availH) {
    gap = Math.max(0, (availH - nMax) / (nMax - 1));
  }
  const bandH = Math.max(0, availH - gap * (nMax - 1));

  // Right column owns the scale; resolveNodeHeights guarantees the bars plus
  // the longer column's gaps fit the plot.
  const rightH = resolveNodeHeights(
    tgtItems.map((t) => t.value),
    bandH,
    minNodeHeight
  );

  // Group ribbon indices per side (model.links is target-major, so groups
  // stay in input order on both sides).
  const byTarget: number[][] = tgtItems.map(() => []);
  const bySource: number[][] = srcItems.map(() => []);
  model.links.forEach((l, k) => {
    byTarget[l.targetIndex]?.push(k);
    bySource[l.sourceIndex]?.push(k);
  });

  // Ribbon pixel heights, derived from the target side so bands exactly fill
  // each bar's funded region.
  const linkH = new Array<number>(model.links.length).fill(0);
  const unfundedH: number[] = tgtItems.map((t, j) => {
    const nodeH = rightH[j] ?? 0;
    const fundedPx = t.value > 0 ? nodeH * ((model.funded[j] ?? 0) / t.value) : 0;
    const fj = model.funded[j] ?? 0;
    if (fj > 0) {
      for (const k of byTarget[j] ?? []) {
        linkH[k] = fundedPx * ((model.links[k]?.value ?? 0) / fj);
      }
    }
    return Math.max(0, nodeH - fundedPx);
  });

  // Left column wraps its outgoing bands, water-filled to the minimum height
  // from leftover space: total bands fit bandH (a subset of the right bars),
  // so the fill can never push the column past the plot.
  const bandSum = srcItems.map((_, i) =>
    (bySource[i] ?? []).reduce((s, k) => s + (linkH[k] ?? 0), 0)
  );
  const totalBands = bandSum.reduce((s, b) => s + b, 0);
  const gapsLeft = gap * Math.max(0, nS - 1);
  const minH = nS > 0 ? Math.min(minNodeHeight, (availH - gapsLeft) / nS) : 0;
  const tiny = bandSum.filter((b) => b < minH).length;
  const extra = Math.max(0, availH - gapsLeft - totalBands);
  const effMin = tiny > 0 ? Math.min(minH, extra / tiny) : minH;
  const leftH = bandSum.map((b) => Math.max(b, effMin));

  const nodeX = Math.max(padLeft + nodeWidth + 24, width - padRight - nodeWidth);
  const linkX0 = padLeft + nodeWidth;
  const linkX1 = nodeX;

  const srcNodes: SankeyNodeLayout[] = srcItems.map((s, i) => ({
    name: s.name,
    value: s.value,
    mergedCount: s.mergedCount,
    share: s.value / flowTotal,
    x: padLeft,
    y: 0, // placed by the stacking pass below
    w: nodeWidth,
    h: Math.max(0, leftH[i] ?? 0),
  }));
  const tgtNodes: DirectSankeyTargetNode[] = tgtItems.map((t, j) => ({
    name: t.name,
    value: t.value,
    mergedCount: t.mergedCount,
    share: t.value / flowTotal,
    x: nodeX,
    y: 0, // placed by the stacking pass below
    w: nodeWidth,
    h: Math.max(0, rightH[j] ?? 0),
    fundedValue: model.funded[j] ?? 0,
    unfundedValue: model.unfunded[j] ?? 0,
    unfundedH: unfundedH[j] ?? 0,
  }));

  // Stack both columns top-down; bands accumulate from each bar's top edge.
  let y = padTop;
  for (let i = 0; i < srcNodes.length; i++) {
    srcNodes[i]!.y = y;
    y += (leftH[i] ?? 0) + gap;
  }
  y = padTop;
  for (let j = 0; j < tgtNodes.length; j++) {
    tgtNodes[j]!.y = y;
    y += (rightH[j] ?? 0) + gap;
  }

  const links: DirectSankeyLinkLayout[] = model.links.map((l) => ({
    name: tgtItems[l.targetIndex]?.name ?? "",
    value: l.value,
    mergedCount: 1,
    sourceIndex: l.sourceIndex,
    targetIndex: l.targetIndex,
    sourceName: srcItems[l.sourceIndex]?.name ?? "",
    targetName: tgtItems[l.targetIndex]?.name ?? "",
    sy0: 0,
    sy1: 0,
    ty0: 0,
    ty1: 0,
    x0: linkX0,
    x1: linkX1,
    d: "",
  }));
  for (let i = 0; i < srcNodes.length; i++) {
    let sy = srcNodes[i]!.y;
    for (const k of bySource[i] ?? []) {
      const h = linkH[k] ?? 0;
      links[k]!.sy0 = sy;
      links[k]!.sy1 = sy + h;
      sy += h;
    }
  }
  for (let j = 0; j < tgtNodes.length; j++) {
    let ty = tgtNodes[j]!.y;
    for (const k of byTarget[j] ?? []) {
      const h = linkH[k] ?? 0;
      links[k]!.ty0 = ty;
      links[k]!.ty1 = ty + h;
      ty += h;
    }
  }
  for (const l of links) {
    l.d = ribbonPath(l.x0, l.x1, l.sy0, l.sy1, l.ty0, l.ty1);
  }

  return {
    incomeTotal,
    spendingTotal,
    flowTotal,
    sources: srcNodes,
    targets: tgtNodes,
    links,
    sourceLabelX: padLeft - SANKEY_SOURCE_LABEL_GAP,
    targetLabelX: nodeX + nodeWidth + 8,
  };
}
