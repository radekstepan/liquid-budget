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
import { isCreditPayoffTransfer, transferNetOnBudgetDelta } from "./transfers.js";

export type SpendingDimension = "categories" | "merchants";

export type SpendingBreakdownItem = {
  name: string;
  /** Net outflow in cents (always > 0). */
  value: number;
};

/**
 * Pseudo-group for spending rows that carry no category. Only appears in
 * the merchant dimension: category mode excludes uncategorized rows (same
 * as computeSpendingBreakdown), while merchant mode needs every drawn
 * target to route through the middle column. Exported so views and tests
 * agree.
 */
export const UNCATEGORIZED_GROUP_LABEL = "Uncategorized";

export type SpendingGroupFlowLink = {
  /** Index into SpendingGroupFlow.groups. */
  groupIndex: number;
  /** Index into SpendingGroupFlow.targets. */
  targetIndex: number;
  /** Cents of the target's value attributed to the group (always > 0). */
  value: number;
};

export type SpendingGroupFlow = {
  /**
   * Middle-column groups, sorted by value descending. Derived from the
   * links (each group's value is the sum of its links) so group values
   * always agree with the drawn ribbons; every value is > 0.
   */
  groups: SpendingBreakdownItem[];
  /**
   * Right-column targets — exactly what computeSpendingBreakdown returns
   * for the same inputs (sorted by value descending, every value > 0).
   */
  targets: SpendingBreakdownItem[];
  /**
   * Exact rollup cells, sorted by (groupIndex, targetIndex): links out of
   * a group sum to that group's value, links into a target sum to that
   * target's value.
   */
  links: SpendingGroupFlowLink[];
};

/**
 * Aggregate net outflows over a contiguous month range (inclusive) into a
 * two-level flow: category groups (middle column) feeding category or
 * merchant targets (right column).
 *
 * Row semantics (shared by both dimensions):
 * - Split-parent rows are excluded; only split children carry outflows.
 * - Income transactions are excluded (in category mode this is a no-op:
 *   income rows are uncategorized by definition).
 * - Refunds/returns (positive amounts on non-income rows) net against the
 *   cell's outflows; targets netting to <= 0 are dropped.
 * - Categorized transfers count as spending in category mode (matches the
 *   legacy Spending by Category tab); in merchant mode every non-income
 *   outflow row counts, categorized or not.
 * - Credit-card payoff transfers (internal moves touching an on-budget
 *   credit account) are excluded in both dimensions: the spending was
 *   already captured by the original card purchases, so money flows THROUGH
 *   instead of appearing as a second "Transfer" expense.
 * - Boundary-inflow transfers (money returning INTO the budget, e.g. an
 *   investment withdrawal) are excluded here: they count as income, never
 *   as negative spending.
 *
 * Group attribution: in category mode each target has exactly one group
 * (its category's group; a dangling category falls back to "—"), so every
 * link is exact. In merchant mode a merchant's net value is attributed
 * across the groups with a positive net cell in proportion to those cells —
 * exact whenever no cell nets negative, and only a net-negative
 * (group, merchant) cell (a refund bigger than that merchant's spending in
 * that group) is spread proportionally instead of drawn as an (impossible)
 * negative ribbon. Uncategorized rows land in UNCATEGORIZED_GROUP_LABEL.
 *
 * Groups are derived from the kept targets' links (never from raw
 * transactions), so a dropped (net <= 0) target can never orphan a link:
 * every link points at a kept group and a kept target.
 */
export function computeSpendingGroupFlow(
  data: BudgetData,
  startMonth: string,
  endMonth: string,
  dimension: SpendingDimension
): SpendingGroupFlow {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;

  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const catMap = new Map(data.categories.map((c) => [c.id, c]));
  const groupMap = new Map(data.groups.map((g) => [g.id, g.name]));
  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));
  const groupNameFor = (categoryId: number): string => {
    const cat = catMap.get(categoryId);
    if (!cat) return "—";
    return groupMap.get(cat.groupId) ?? "—";
  };

  // Cells: target name -> group name -> net outflow cents.
  const cells = new Map<string, Map<string, number>>();
  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    if (isIncomeTransaction(t, accountMap)) continue;
    if (isCreditPayoffTransfer(t, accountMap)) continue;
    if (transferNetOnBudgetDelta(t, accountMap) > 0) continue;
    const mk = t.date.slice(0, 7);
    if (mk < actualStart || mk > actualEnd) continue;

    let name: string;
    let group: string;
    if (dimension === "categories") {
      if (t.categoryId == null) continue;
      name = catMap.get(t.categoryId)?.name ?? "—";
      group = groupNameFor(t.categoryId);
    } else {
      const payee = t.payee.trim();
      name = payee === "" ? "—" : payee;
      group =
        t.categoryId == null ? UNCATEGORIZED_GROUP_LABEL : groupNameFor(t.categoryId);
    }
    let row = cells.get(name);
    if (!row) {
      row = new Map();
      cells.set(name, row);
    }
    // Amount < 0 is outflow (+ netOutflow); amount > 0 is a refund (- netOutflow).
    row.set(group, (row.get(group) ?? 0) - num(t.amount));
  }

  const targets = [...cells.entries()]
    .map(([name, row]) => ({
      name,
      value: [...row.values()].reduce((s, v) => s + v, 0),
      row,
    }))
    .filter((t) => t.value > 0)
    .sort((a, b) => b.value - a.value);

  const links: { group: string; targetIndex: number; value: number }[] = [];
  const groupTotals = new Map<string, number>();
  targets.forEach((t, targetIndex) => {
    let positives = 0;
    for (const v of t.row.values()) {
      if (v > 0) positives += v;
    }
    // A net-positive target always has a positive cell; without one there
    // is nothing to attribute, so the target draws with no incoming ribbon.
    if (!(positives > 0)) return;
    for (const [group, cell] of t.row) {
      if (!(cell > 0)) continue;
      const value = (t.value * cell) / positives;
      links.push({ group, targetIndex, value });
      groupTotals.set(group, (groupTotals.get(group) ?? 0) + value);
    }
  });

  const groups = [...groupTotals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const groupIndex = new Map(groups.map((g, i) => [g.name, i]));
  const outLinks = links
    .map((l) => ({
      groupIndex: groupIndex.get(l.group) ?? -1,
      targetIndex: l.targetIndex,
      value: l.value,
    }))
    .filter((l) => l.groupIndex >= 0)
    .sort((a, b) => a.groupIndex - b.groupIndex || a.targetIndex - b.targetIndex);

  return {
    groups,
    targets: targets.map(({ name, value }) => ({ name, value })),
    links: outLinks,
  };
}

/**
 * Aggregate net outflows over a contiguous month range (inclusive), grouped
 * by category name or merchant (payee) name. Returns items sorted by value
 * descending. This is the right-column half of computeSpendingGroupFlow —
 * see that function for the row semantics; delegating (rather than
 * re-implementing the filters) keeps the two outputs identical by
 * construction.
 */
export function computeSpendingBreakdown(
  data: BudgetData,
  startMonth: string,
  endMonth: string,
  dimension: SpendingDimension
): SpendingBreakdownItem[] {
  return computeSpendingGroupFlow(data, startMonth, endMonth, dimension).targets;
}

/**
 * Aggregate income over a contiguous month range (inclusive), grouped by
 * source (payee) name. Mirrors computeSpendingBreakdown with the predicate
 * flipped: only income rows (uncategorized, positive, on-budget — see
 * isIncomeTransaction) count; split parents are excluded. Negative
 * uncategorized rows are outflows, not corrections, so they are excluded
 * here (merchant spending picks them up instead).
 *
 * Additionally, boundary-inflow transfers — money returning INTO the budget
 * from an off-budget account, e.g. liquidating an investment account — count
 * as income even when categorized (withdrawing is income when the money
 * re-enters the budget; the contribution was already counted as an outflow
 * allocation on the way in). Transfer rows are valued at their net
 * on-budget delta so withdrawals recorded on either leg count positively.
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
    const netTransferDelta = transferNetOnBudgetDelta(t, accountMap);
    if (!isIncomeTransaction(t, accountMap) && !(netTransferDelta > 0)) continue;
    const mk = t.date.slice(0, 7);
    if (mk < actualStart || mk > actualEnd) continue;

    const payee = t.payee.trim();
    const name = payee === "" ? "—" : payee;
    // Transfer rows are valued at their budget impact: a withdrawal recorded
    // on the off-budget leg carries a negative amount but is positive income.
    const value = t.transferAccountId != null ? netTransferDelta : num(t.amount);
    bySource.set(name, (bySource.get(name) ?? 0) + value);
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
  /**
   * True only for merged "Other" bucket rows. A bucket can hold a single
   * row, so buckets are identified by this flag — never by name (a literal
   * "Other" row is still just a row) or by count.
   */
  bucket?: boolean;
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
    kept.push({ name: OTHER_BUCKET_LABEL, value: otherValue, mergedCount: otherCount, bucket: true });
  }
  return { items: kept, otherCount, otherValue };
}

export type MergedGroupFlowLink = SpendingGroupFlowLink;

export type MergedGroupFlow = {
  /** Middle column after merging (same order rules as mergeBelowThreshold). */
  groups: MergedSpendingItem[];
  /** Right column after merging (identical to mergeBelowThreshold output). */
  targets: MergedSpendingItem[];
  /**
   * Links re-aggregated by summing constituent cells, so both marginals
   * still hold: links out of a group sum to that group's value, links into
   * a target sum to that target's value. Sorted by (groupIndex, targetIndex).
   */
  links: MergedGroupFlowLink[];
  /** Groups + targets folded into Other (0 when no merge happened). */
  otherCount: number;
  /** Total cents folded into Other across both columns. */
  otherValue: number;
};

/**
 * Fold both columns of a SpendingGroupFlow below `thresholdCents`, keeping
 * the group→target links exact: each column merges with mergeBelowThreshold
 * semantics (kept rows stay in input order, "Other" sorts last), and links
 * are re-aggregated by summing the cells that land in the same merged
 * (group, target) pair. A kept category whose group merged still routes —
 * through the middle "Other" bucket — and a merged "Other" target draws one
 * ribbon per group that feeds it, so no flow is invented or lost.
 *
 * - `thresholdCents <= 0` disables merging (provenance-preserving pass-through).
 * - Merging is index-keyed, so a literal "Other" group or category name can
 *   never collide with the merged bucket.
 * - Links dangling past either column are dropped (defensive: well-formed
 *   flows never produce them).
 */
export function mergeGroupFlow(
  groups: SpendingBreakdownItem[],
  targets: SpendingBreakdownItem[],
  links: SpendingGroupFlowLink[],
  thresholdCents: number
): MergedGroupFlow {
  const partition = (items: SpendingBreakdownItem[]) => {
    const merged: MergedSpendingItem[] = [];
    const remap: number[] = new Array<number>(items.length).fill(-1);
    let otherCount = 0;
    let otherValue = 0;
    items.forEach((it, i) => {
      if (thresholdCents > 0 && it.value < thresholdCents) {
        otherCount += 1;
        otherValue += it.value;
      } else {
        remap[i] = merged.length;
        merged.push({ ...it, mergedCount: 1 });
      }
    });
    if (otherCount > 0) {
      const otherIndex = merged.length;
      merged.push({ name: OTHER_BUCKET_LABEL, value: otherValue, mergedCount: otherCount, bucket: true });
      for (let i = 0; i < remap.length; i++) {
        if (remap[i]! < 0) remap[i] = otherIndex;
      }
    }
    return { merged, otherCount, otherValue, remap };
  };

  const g = partition(groups);
  const t = partition(targets);

  const acc = new Map<string, number>();
  for (const l of links) {
    const ng = g.remap[l.groupIndex];
    const nt = t.remap[l.targetIndex];
    if (ng == null || ng < 0 || nt == null || nt < 0 || !(l.value > 0)) continue;
    const key = `${ng}:${nt}`;
    acc.set(key, (acc.get(key) ?? 0) + l.value);
  }
  const outLinks = [...acc.entries()]
    .map(([key, value]) => {
      const [gs, ts] = key.split(":");
      return { groupIndex: Number(gs), targetIndex: Number(ts), value };
    })
    .sort((a, b) => a.groupIndex - b.groupIndex || a.targetIndex - b.targetIndex);

  return {
    groups: g.merged,
    targets: t.merged,
    links: outLinks,
    otherCount: g.otherCount + t.otherCount,
    otherValue: g.otherValue + t.otherValue,
  };
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
  /** True only for merged "Other" bucket bars (copied from the item). */
  bucket: boolean;
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
/** Gap between middle-column bars and their start-anchored labels. */
export const SANKEY_MIDDLE_LABEL_GAP = 6;
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
    nodes.push({ name: it.name, value: it.value, mergedCount: it.mergedCount, bucket: it.bucket === true, share, x: nodeX, y, w: nodeWidth, h });
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
    bucket: s.bucket === true,
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
    bucket: t.bucket === true,
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

/** Middle-column node: same funded/unfunded shape as a right-column target. */
export type GroupedSankeyMiddleNode = DirectSankeyTargetNode;

export type GroupedIncomeSankeyLayout = {
  incomeTotal: number;
  spendingTotal: number;
  /** Height-scale denominator: max(income, spending). */
  flowTotal: number;
  /** Left column: one bar per income source. */
  sources: SankeyNodeLayout[];
  /** Middle column: one bar per category group. */
  middles: GroupedSankeyMiddleNode[];
  /**
   * Right column: one bar per spending group (category or merchant) plus a
   * trailing Remaining plug when income exceeds spending.
   */
  targets: DirectSankeyTargetNode[];
  /**
   * Index into targets of the Remaining plug, or null when spending covers
   * income. Identified by position (never by name), so a literal
   * "Remaining" category can never be mistaken for the plug.
   */
  remainingTargetIndex: number | null;
  /**
   * Left ribbons: income → middle, fungible proportional allocation
   * (sourceIndex into sources, targetIndex into middles) — except the
   * Remaining ribbons, which carry the plug index (one past the last
   * middle) and run full-width from their income source straight to the
   * Remaining target, passing behind the middle column: unspent money
   * bypasses groups.
   */
  linksLeft: DirectSankeyLinkLayout[];
  /**
   * Right ribbons: middle → spending, exact rollup attribution
   * (sourceIndex into middles, targetIndex into targets).
   */
  linksRight: DirectSankeyLinkLayout[];
  /** x for end-anchored income labels (left of the source column). */
  sourceLabelX: number;
  /** x for start-anchored group labels (right of the middle column). */
  middleLabelX: number;
  /** x for start-anchored target labels (right of the target column). */
  targetLabelX: number;
};

/**
 * Lay out a three-column money-flow Sankey: income sources (left) flow into
 * category groups (middle), which flow into spending groups (right). The
 * left hop reuses computeDirectFlowLinks (fungible proportional allocation);
 * the right hop draws the exact group→target rollup cells scaled by the
 * uniform coverage ratio income/spending. Surplus income lands in a
 * trailing Remaining target on the right, fed directly from the incomes —
 * unspent money bypasses groups, so those ribbons span the full width
 * behind the middle column.
 *
 * Geometry contract (covered by unit tests):
 * - The right column owns the pixel scale (targets plus Remaining always
 *   sum to flowTotal): right bars resolve via resolveNodeHeights, so the
 *   long tail of small spending rows keeps the minimum label pitch.
 * - Right ribbon heights subdivide each target bar's funded region in
 *   proportion to their values; Remaining bands subdivide the Remaining
 *   bar's (fully funded) region. Every ribbon has equal height at both ends
 *   (no taper): bands within a target run in middle order (source order for
 *   the Remaining plug), bands within a middle run in target order on the
 *   way out and in source order on the way in.
 * - Middle bars wrap their outgoing bands plus an unfunded segment at the
 *   bottom (top-aligned funded region, like the right column); with no
 *   income there are no ribbons and every bar is fully unfunded.
 * - Source bars wrap their outgoing bands exactly (group ribbons plus any
 *   full-width Remaining ribbons), water-filled up to the minimum node
 *   height from leftover plot space (never overflowing it).
 * - Node `share` is value/flowTotal on all three columns.
 * - Degenerate input (no positive right-column values, or a non-positive
 *   dimension) yields no nodes — never NaN geometry.
 * - Non-positive groups/targets are dropped, and links into dropped rows
 *   are dropped with them.
 *
 * Callers should size height with sankeyContentHeight over the LONGEST
 * column (see the readability contract above); the layout never exceeds the
 * padded plot area, but rows below the minimum pitch may touch.
 */
export function layoutGroupedIncomeSankey(
  sources: MergedSpendingItem[],
  groups: MergedSpendingItem[],
  targets: MergedSpendingItem[],
  groupLinks: SpendingGroupFlowLink[],
  opts: SankeyGeometryOptions
): GroupedIncomeSankeyLayout {
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

  const nodeX = Math.max(padLeft + nodeWidth + 24, width - padRight - nodeWidth);
  const linkLX0 = padLeft + nodeWidth;
  // The middle column sits centered between the outer columns; the clamp
  // keeps both ribbon runs positive while narrow widths squeeze the
  // ribbons, never the labels or bars.
  const midLo = linkLX0 + 2;
  const midHi = nodeX - nodeWidth - 2;
  const midX =
    midHi >= midLo
      ? Math.min(Math.max(Math.round((linkLX0 + nodeX - nodeWidth) / 2), midLo), midHi)
      : midLo;
  const linkRX0 = midX + nodeWidth;
  const linkRX1 = nodeX;

  // Drop non-positive rows first so link indices remap onto the drawn
  // columns (well-formed flows never trigger this: every value is > 0).
  const grpItems = groups.filter((g) => g.value > 0);
  const tgtItems = targets.filter((t) => t.value > 0);
  const grpRemap = new Map<number, number>();
  groups.forEach((g, i) => {
    if (g.value > 0) grpRemap.set(i, grpRemap.size);
  });
  const tgtRemap = new Map<number, number>();
  targets.forEach((t, i) => {
    if (t.value > 0) tgtRemap.set(i, tgtRemap.size);
  });
  const keptLinks = groupLinks.filter((l) => {
    const ng = grpRemap.get(l.groupIndex);
    const nt = tgtRemap.get(l.targetIndex);
    return ng != null && nt != null && l.value > 0;
  });

  // Left hop values: incomes feed the groups proportionally, and any
  // surplus feeds Remaining the same way (the plug is last by position).
  const left = computeDirectFlowLinks(sources, grpItems);
  const { incomeTotal, spendingTotal } = left;
  const flowTotal = Math.max(incomeTotal, spendingTotal);
  const coverage = spendingTotal > 0 ? Math.min(1, incomeTotal / spendingTotal) : 1;
  const hasRemaining = incomeTotal > spendingTotal;
  const plugIndex = left.targets.length - 1;

  // Right column: spending targets plus the surplus plug. Funded values use
  // the uniform coverage ratio (which is 1 whenever Remaining exists, so
  // the plug is always fully funded).
  const rightItems: MergedSpendingItem[] = hasRemaining
    ? [...tgtItems, left.targets[plugIndex]!]
    : [...tgtItems];
  const rightFunded = rightItems.map((t) => t.value * coverage);
  const remainingTargetIndex = hasRemaining ? rightItems.length - 1 : null;

  if (rightItems.length === 0 || flowTotal <= 0 || width <= 0 || height <= 0) {
    return {
      incomeTotal,
      spendingTotal,
      flowTotal,
      sources: [],
      middles: [],
      targets: [],
      remainingTargetIndex: null,
      linksLeft: [],
      linksRight: [],
      sourceLabelX: padLeft - SANKEY_SOURCE_LABEL_GAP,
      middleLabelX: midX + nodeWidth + SANKEY_MIDDLE_LABEL_GAP,
      targetLabelX: width - padRight,
    };
  }

  const srcItems = left.sources;
  const nS = srcItems.length;
  const nM = grpItems.length;
  const nR = rightItems.length;
  const nMax = Math.max(nS, nM, nR);

  const availH = Math.max(0, height - padTop - padBottom);
  // The longest column's gaps cap the shared gap so all columns fit.
  let gap = nodeGap;
  if (nMax > 1 && gap * (nMax - 1) > availH) {
    gap = Math.max(0, (availH - nMax) / (nMax - 1));
  }
  const bandH = Math.max(0, availH - gap * (nMax - 1));

  // Right owns the scale; targets plus Remaining always sum to flowTotal.
  const rightH = resolveNodeHeights(
    rightItems.map((t) => t.value),
    bandH,
    minNodeHeight
  );

  // Right hop values: exact rollup cells at the uniform coverage ratio.
  // Sorted by (middle, target) so bands run in target order within a
  // middle and in middle order within a target.
  const rightVals = keptLinks
    .map((l) => ({
      middleIndex: grpRemap.get(l.groupIndex) ?? -1,
      targetIndex: tgtRemap.get(l.targetIndex) ?? -1,
      value: l.value * coverage,
    }))
    .filter((l) => l.middleIndex >= 0 && l.targetIndex >= 0 && l.value > 0)
    .sort((a, b) => a.middleIndex - b.middleIndex || a.targetIndex - b.targetIndex);

  // Group ribbon indices per column. left.links is middle-major; Remaining
  // entries (the trailing plug-major run) split off into remIn.
  const midIn: number[][] = grpItems.map(() => []);
  const remIn: number[] = [];
  const srcOut: number[][] = srcItems.map(() => []);
  left.links.forEach((l, k) => {
    if (hasRemaining && l.targetIndex === plugIndex) remIn.push(k);
    else midIn[l.targetIndex]?.push(k);
    srcOut[l.sourceIndex]?.push(k);
  });
  const midOut: number[][] = grpItems.map(() => []);
  const tgtIn: number[][] = tgtItems.map(() => []);
  rightVals.forEach((l, k) => {
    midOut[l.middleIndex]?.push(k);
    tgtIn[l.targetIndex]?.push(k);
  });

  // Ribbon pixel heights derive from the right bars so bands exactly fill
  // each bar's funded region.
  const linkRH = new Array<number>(rightVals.length).fill(0);
  const linkLH = new Array<number>(left.links.length).fill(0);
  const rightUnfundedH: number[] = rightItems.map((t, j) => {
    const nodeH = rightH[j] ?? 0;
    const fundedPx = t.value > 0 ? nodeH * ((rightFunded[j] ?? 0) / t.value) : 0;
    const fj = rightFunded[j] ?? 0;
    if (fj > 0) {
      if (remainingTargetIndex === j) {
        for (const k of remIn) {
          linkLH[k] = fundedPx * ((left.links[k]?.value ?? 0) / fj);
        }
      } else {
        for (const k of tgtIn[j] ?? []) {
          linkRH[k] = fundedPx * ((rightVals[k]?.value ?? 0) / fj);
        }
      }
    }
    return Math.max(0, nodeH - fundedPx);
  });

  // Middle bars wrap their outgoing bands plus the unfunded segment below
  // (funded/total share of the bar, like the right column). With no income
  // there are no bands, so bars fall back to the right scale.
  const totalRightH = rightH.reduce((s, h) => s + h, 0);
  const rightScale = totalRightH / flowTotal;
  const outStack = grpItems.map((_, i) =>
    (midOut[i] ?? []).reduce((s, k) => s + (linkRH[k] ?? 0), 0)
  );
  const midH = grpItems.map((g, i) =>
    coverage > 0 ? (outStack[i] ?? 0) / coverage : rightScale * g.value
  );
  const midFunded = grpItems.map((g) => g.value * coverage);
  const midUnfundedH = grpItems.map((_, i) =>
    Math.max(0, (midH[i] ?? 0) - (outStack[i] ?? 0))
  );

  // Left group-ribbon heights subdivide each middle bar's funded region in
  // proportion to their values (Remaining bands were sized from the right).
  for (let i = 0; i < grpItems.length; i++) {
    const nodeH = midH[i] ?? 0;
    const g = grpItems[i]!;
    const fundedPx = g.value > 0 ? nodeH * ((midFunded[i] ?? 0) / g.value) : 0;
    const fj = midFunded[i] ?? 0;
    if (fj > 0) {
      for (const k of midIn[i] ?? []) {
        linkLH[k] = fundedPx * ((left.links[k]?.value ?? 0) / fj);
      }
    }
  }

  // Sources wrap their outgoing bands, water-filled to the minimum height
  // from leftover space: total bands fit bandH (a subset of the right
  // bars), so the fill can never push the column past the plot.
  const bandSum = srcItems.map((_, i) =>
    (srcOut[i] ?? []).reduce((s, k) => s + (linkLH[k] ?? 0), 0)
  );
  const totalBands = bandSum.reduce((s, b) => s + b, 0);
  const gapsLeft = gap * Math.max(0, nS - 1);
  const minH = nS > 0 ? Math.min(minNodeHeight, (availH - gapsLeft) / nS) : 0;
  const tiny = bandSum.filter((b) => b < minH).length;
  const extra = Math.max(0, availH - gapsLeft - totalBands);
  const effMin = tiny > 0 ? Math.min(minH, extra / tiny) : minH;
  const leftH = bandSum.map((b) => Math.max(b, effMin));

  const srcNodes: SankeyNodeLayout[] = srcItems.map((s, i) => ({
    name: s.name,
    value: s.value,
    mergedCount: s.mergedCount,
    bucket: s.bucket === true,
    share: s.value / flowTotal,
    x: padLeft,
    y: 0, // placed by the stacking pass below
    w: nodeWidth,
    h: Math.max(0, leftH[i] ?? 0),
  }));
  const midNodes: GroupedSankeyMiddleNode[] = grpItems.map((g, i) => ({
    name: g.name,
    value: g.value,
    mergedCount: g.mergedCount,
    bucket: g.bucket === true,
    share: g.value / flowTotal,
    x: midX,
    y: 0, // placed by the stacking pass below
    w: nodeWidth,
    h: Math.max(0, midH[i] ?? 0),
    fundedValue: midFunded[i] ?? 0,
    unfundedValue: g.value - (midFunded[i] ?? 0),
    unfundedH: midUnfundedH[i] ?? 0,
  }));
  const tgtNodes: DirectSankeyTargetNode[] = rightItems.map((t, j) => ({
    name: t.name,
    value: t.value,
    mergedCount: t.mergedCount,
    bucket: t.bucket === true,
    share: t.value / flowTotal,
    x: nodeX,
    y: 0, // placed by the stacking pass below
    w: nodeWidth,
    h: Math.max(0, rightH[j] ?? 0),
    fundedValue: rightFunded[j] ?? 0,
    unfundedValue: t.value - (rightFunded[j] ?? 0),
    unfundedH: rightUnfundedH[j] ?? 0,
  }));

  // Stack all columns top-down; bands accumulate from each bar's top edge.
  let y = padTop;
  for (let i = 0; i < srcNodes.length; i++) {
    srcNodes[i]!.y = y;
    y += (leftH[i] ?? 0) + gap;
  }
  y = padTop;
  for (let i = 0; i < midNodes.length; i++) {
    midNodes[i]!.y = y;
    y += (midH[i] ?? 0) + gap;
  }
  y = padTop;
  for (let j = 0; j < tgtNodes.length; j++) {
    tgtNodes[j]!.y = y;
    y += (rightH[j] ?? 0) + gap;
  }

  const linksLeft: DirectSankeyLinkLayout[] = left.links.map((l) => {
    // targetIndex keys into middles; the Remaining ribbons carry the plug
    // index (one past the last middle) and land on remainingTargetIndex.
    const isPlug = hasRemaining && l.targetIndex === plugIndex;
    const targetName = left.targets[l.targetIndex]?.name ?? "";
    return {
      name: targetName,
      value: l.value,
      mergedCount: 1,
      sourceIndex: l.sourceIndex,
      targetIndex: l.targetIndex,
      sourceName: srcItems[l.sourceIndex]?.name ?? "",
      targetName,
      sy0: 0,
      sy1: 0,
      ty0: 0,
      ty1: 0,
      x0: linkLX0,
      x1: isPlug ? linkRX1 : midX,
      d: "",
    };
  });
  for (let i = 0; i < srcNodes.length; i++) {
    let sy = srcNodes[i]!.y;
    for (const k of srcOut[i] ?? []) {
      const h = linkLH[k] ?? 0;
      linksLeft[k]!.sy0 = sy;
      linksLeft[k]!.sy1 = sy + h;
      sy += h;
    }
  }
  // Group bands stack within their middle bar; Remaining bands stack within
  // the Remaining bar on the right (source order — the plug-major run).
  for (let i = 0; i < midNodes.length; i++) {
    let ty = midNodes[i]!.y;
    for (const k of midIn[i] ?? []) {
      const h = linkLH[k] ?? 0;
      linksLeft[k]!.ty0 = ty;
      linksLeft[k]!.ty1 = ty + h;
      ty += h;
    }
  }
  if (remainingTargetIndex != null) {
    let ty = tgtNodes[remainingTargetIndex]!.y;
    for (const k of remIn) {
      const h = linkLH[k] ?? 0;
      linksLeft[k]!.ty0 = ty;
      linksLeft[k]!.ty1 = ty + h;
      ty += h;
    }
  }

  const linksRight: DirectSankeyLinkLayout[] = rightVals.map((l) => ({
    name: tgtItems[l.targetIndex]?.name ?? "",
    value: l.value,
    mergedCount: 1,
    sourceIndex: l.middleIndex,
    targetIndex: l.targetIndex,
    sourceName: grpItems[l.middleIndex]?.name ?? "",
    targetName: tgtItems[l.targetIndex]?.name ?? "",
    sy0: 0,
    sy1: 0,
    ty0: 0,
    ty1: 0,
    x0: linkRX0,
    x1: linkRX1,
    d: "",
  }));
  for (let i = 0; i < midNodes.length; i++) {
    let sy = midNodes[i]!.y;
    for (const k of midOut[i] ?? []) {
      const h = linkRH[k] ?? 0;
      linksRight[k]!.sy0 = sy;
      linksRight[k]!.sy1 = sy + h;
      sy += h;
    }
  }
  for (let j = 0; j < tgtItems.length; j++) {
    let ty = tgtNodes[j]!.y;
    for (const k of tgtIn[j] ?? []) {
      const h = linkRH[k] ?? 0;
      linksRight[k]!.ty0 = ty;
      linksRight[k]!.ty1 = ty + h;
      ty += h;
    }
  }
  for (const l of linksLeft) {
    l.d = ribbonPath(l.x0, l.x1, l.sy0, l.sy1, l.ty0, l.ty1);
  }
  for (const l of linksRight) {
    l.d = ribbonPath(l.x0, l.x1, l.sy0, l.sy1, l.ty0, l.ty1);
  }

  return {
    incomeTotal,
    spendingTotal,
    flowTotal,
    sources: srcNodes,
    middles: midNodes,
    targets: tgtNodes,
    remainingTargetIndex,
    linksLeft,
    linksRight,
    sourceLabelX: padLeft - SANKEY_SOURCE_LABEL_GAP,
    middleLabelX: midX + nodeWidth + SANKEY_MIDDLE_LABEL_GAP,
    targetLabelX: nodeX + nodeWidth + 8,
  };
}
