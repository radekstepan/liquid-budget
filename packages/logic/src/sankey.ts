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
import { isInternalTransfer, isOffBudgetTransfer } from "./transfers.js";

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
 * - No transfer leg counts as spending in either dimension, categorized
 *   or not: every transfer is movement between pools, and the terminal
 *   purchase (wherever its account sits) is the one spending record. In
 *   particular internal on-budget transfers (chequing to an on-budget
 *   savings account, credit-card payoffs) are excluded: counting the legs
 *   would show gross pass-through "spending" under `Transfer: <account>`
 *   payees that can never net out, since each leg names the OTHER account
 *   (a round-trip through a savings account is movement, not spending —
 *   only money that actually leaves the budget counts). Matches the
 *   internal-transfer exclusion in computeCashFlowRange.
 * - Off-budget transfers (any transfer touching an off-budget account: a
 *   contribution out, a withdrawal back, or a move between two off-budget
 *   accounts) are excluded in both dimensions: off-budget accounts are
 *   intermediate pools, so money flows THROUGH them — a contribution is
 *   movement, not a terminal outflow allocation, and a withdrawal never
 *   nets against spending. The final purchase (wherever its account sits)
 *   is the one spending record, attributed to the original income sources
 *   by the fungible left-hop allocation; an off-budget account appears as
 *   income only for its external profit (see computeIncomeBreakdown).
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
    // Every transfer leg is movement between pools, never terminal spending
    // (internal on-budget moves and credit payoffs via isInternalTransfer,
    // boundary crossings via isOffBudgetTransfer — together they cover every
    // row with transferAccountId set).
    if (isInternalTransfer(t, accountMap)) continue;
    if (isOffBudgetTransfer(t, accountMap)) continue;
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
 * source name. Two source kinds feed the Sankey's income column:
 *
 * - Plain income rows (uncategorized, positive, on-budget, non-transfer —
 *   see isIncomeTransaction), grouped by payee. Transfer rows are never
 *   plain income here even when the budget engine classifies an
 *   uncategorized withdrawal as income: withdrawals are pass-through
 *   principal, not new money (see below).
 * - Off-budget account profit: external growth recorded directly in an
 *   off-budget account (dividends, interest, deposits) — positive,
 *   uncategorized, non-transfer rows on an off-budget account — grouped
 *   under the ACCOUNT name. The account is the income source, valued at
 *   profit only, never at pass-through principal.
 *
 * Flow-through attribution: money is fungible, so every outflow from an
 * intermediate off-budget account is funded pro-rata by that account's
 * traced inflow sources — which, with every pool fungible, is exactly the
 * report-wide proportional allocation the left hop already computes
 * (computeDirectFlowLinks). The legs themselves are movement, never
 * terminal flows: contributions are excluded from spending (see
 * computeSpendingGroupFlow) and withdrawals are excluded from income, so
 * if salary funded the investment account and the investment account
 * later funded vacation spending, the Sankey shows salary → vacation
 * (attributed to the original income source), not
 * investment-account → vacation. Chains of arbitrary depth collapse the
 * same way: every intermediate leg is skipped, the final purchase is the
 * one spending record, and each account contributes only its own profit.
 *
 * Loss / break-even display decision: an account with no external inflows
 * contributes no income source at all (clamped at zero — there is no
 * mark-to-market in transaction data, so a "loss" is just outflows
 * exceeding period inflows, funded from pre-period balances). The
 * shortfall surfaces through the existing uniform-coverage shortfall:
 * every expense is funded pro-rata and the remainder stays unfunded
 * (OVER_INCOME_LABEL), which reduces every attributed source
 * proportionally instead of inventing a negative income node.
 *
 * Split parents are excluded; negative uncategorized rows are outflows,
 * not corrections, so they are excluded here (merchant spending picks
 * them up instead). Categorized positive rows on off-budget accounts are
 * refunds, not profit: they net against spending and must not also count
 * as income. An explicit `isIncome: false` always wins (matches
 * isIncomeTransaction).
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
    const mk = t.date.slice(0, 7);
    if (mk < actualStart || mk > actualEnd) continue;

    if (t.transferAccountId == null && isIncomeTransaction(t, accountMap)) {
      const payee = t.payee.trim();
      const name = payee === "" ? "—" : payee;
      bySource.set(name, (bySource.get(name) ?? 0) + num(t.amount));
    } else if (
      t.transferAccountId == null &&
      t.categoryId == null &&
      t.isIncome !== false &&
      num(t.amount) > 0 &&
      (accountMap.get(t.accountId)?.onBudget ?? true) === false
    ) {
      // External profit in an off-budget account, grouped under the
      // account's own name (the account is the source).
      const raw = accountMap.get(t.accountId)?.name.trim() ?? "";
      const name = raw === "" ? "—" : raw;
      bySource.set(name, (bySource.get(name) ?? 0) + num(t.amount));
    }
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
 * partly funded, and the gap renders as a distinct neutral segment on the
 * expense side. "Over income" names it in the header's own words (the
 * header reads "Over: $X" in this state): spent more than earned, the
 * difference covered from savings or debt — without implying new income.
 */
export const OVER_INCOME_LABEL = "Over income";

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
   * deliberately no plug for the reverse imbalance (see OVER_INCOME_LABEL).
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
    kept.push({
      name: OTHER_BUCKET_LABEL,
      value: otherValue,
      mergedCount: otherCount,
      bucket: true,
    });
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
      merged.push({
        name: OTHER_BUCKET_LABEL,
        value: otherValue,
        mergedCount: otherCount,
        bucket: true,
      });
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

/**
 * Right-column sort mode for the Spending Sankey: by current amount (the
 * long-standing value-descending order on every column) or by parent
 * category group (Budget view group order, value-descending within).
 */
export type SankeyTargetSort = "amount" | "group";

/**
 * Reorder a merged group flow for the Sankey's sort control. `"amount"` is
 * a pass-through (returns the input flow unchanged). `"group"` orders the
 * middle column by `groupOrder` — the Budget view's group names in
 * `group.sort` order — and the right column by each target's dominant
 * (largest-link) parent group in that same order, then by `categoryOrder`
 * rank within a group (the Budget view's category names in group-major
 * `sort` order, so each category follows its position in its parent
 * group). Targets missing from `categoryOrder` — merchants, which have no
 * Budget position — sort after the known names, value-descending (name,
 * then current position, break ties deterministically).
 *
 * - Names missing from `groupOrder` (the Uncategorized pseudo-group, the
 *   "—" fallback) sort after the known groups, keeping current order.
 * - The render-only Other buckets stay last on both columns.
 * - Targets with no incoming link (defensive: well-formed flows never
 *   produce them) sort after the grouped targets, value-descending.
 * - Links are remapped onto the new indices and re-sorted by
 *   (groupIndex, targetIndex); both marginals still hold (a permutation
 *   moves cells, never values).
 */
export function sortMergedGroupFlow(
  flow: MergedGroupFlow,
  groupOrder: readonly string[],
  sort: SankeyTargetSort,
  categoryOrder: readonly string[] = []
): MergedGroupFlow {
  if (sort === "amount") return flow;
  const orderIndex = new Map<string, number>();
  groupOrder.forEach((name, i) => {
    if (!orderIndex.has(name)) orderIndex.set(name, i);
  });
  const rankOf = (name: string): number => orderIndex.get(name) ?? groupOrder.length;
  const categoryIndex = new Map<string, number>();
  categoryOrder.forEach((name, i) => {
    if (!categoryIndex.has(name)) categoryIndex.set(name, i);
  });
  const categoryRankOf = (name: string): number =>
    categoryIndex.get(name) ?? Number.MAX_SAFE_INTEGER;

  const groupPerm = flow.groups
    .map((_, i) => i)
    .sort((a, b) => {
      const ga = flow.groups[a]!;
      const gb = flow.groups[b]!;
      const ba = ga.bucket === true ? 1 : 0;
      const bb = gb.bucket === true ? 1 : 0;
      if (ba !== bb) return ba - bb;
      const ra = rankOf(ga.name);
      const rb = rankOf(gb.name);
      if (ra !== rb) return ra - rb;
      return a - b;
    });

  // Dominant parent per target (largest incoming link wins; ties keep the
  // first link in input order so the result is deterministic).
  const dominant = new Array<number>(flow.targets.length).fill(-1);
  const best = new Array<number>(flow.targets.length).fill(0);
  for (const l of flow.links) {
    if (l.targetIndex < 0 || l.targetIndex >= flow.targets.length) continue;
    if (l.groupIndex < 0 || l.groupIndex >= flow.groups.length) continue;
    if (!(l.value > 0)) continue;
    if (dominant[l.targetIndex] === -1 || l.value > (best[l.targetIndex] ?? 0)) {
      dominant[l.targetIndex] = l.groupIndex;
      best[l.targetIndex] = l.value;
    }
  }

  const targetPerm = flow.targets
    .map((_, i) => i)
    .sort((a, b) => {
      const ta = flow.targets[a]!;
      const tb = flow.targets[b]!;
      const ba = ta.bucket === true ? 1 : 0;
      const bb = tb.bucket === true ? 1 : 0;
      if (ba !== bb) return ba - bb;
      const da = dominant[a] ?? -1;
      const db = dominant[b] ?? -1;
      const la = da < 0 ? 1 : 0;
      const lb = db < 0 ? 1 : 0;
      if (la !== lb) return la - lb;
      if (da >= 0 && db >= 0) {
        const ra = rankOf(flow.groups[da]?.name ?? "");
        const rb = rankOf(flow.groups[db]?.name ?? "");
        if (ra !== rb) return ra - rb;
      }
      // Within a parent group, categories follow their Budget position;
      // merchants (absent from categoryOrder) stay value-descending.
      const ca = categoryRankOf(ta.name);
      const cb = categoryRankOf(tb.name);
      if (ca !== cb) return ca - cb;
      if (ta.value !== tb.value) return tb.value - ta.value;
      if (ta.name !== tb.name) return ta.name < tb.name ? -1 : 1;
      return a - b;
    });

  const gRemap = new Map(groupPerm.map((old, next) => [old, next]));
  const tRemap = new Map(targetPerm.map((old, next) => [old, next]));
  const links = flow.links
    .map((l) => ({
      groupIndex: gRemap.get(l.groupIndex) ?? -1,
      targetIndex: tRemap.get(l.targetIndex) ?? -1,
      value: l.value,
    }))
    .filter((l) => l.groupIndex >= 0 && l.targetIndex >= 0)
    .sort((a, b) => a.groupIndex - b.groupIndex || a.targetIndex - b.targetIndex);

  return {
    groups: groupPerm.map((i) => flow.groups[i]!),
    targets: targetPerm.map((i) => flow.targets[i]!),
    links,
    otherCount: flow.otherCount,
    otherValue: flow.otherValue,
  };
}

/**
 * Canonical "Under" threshold stops in whole dollars. The slider walks these
 * positions (0 = off) instead of raw dollars, so the first steps merge in
 * small increments ($10, $25, $50…) where rows are dense and later steps
 * jump in thousands where only the long tail is left. Gaps grow down the
 * list; sankeyThresholdStops doubles past the last stop for huge datasets.
 */
export const SANKEY_THRESHOLD_STOPS: readonly number[] = [
  0, 10, 25, 50, 75, 100, 150, 200, 250, 300, 350, 400, 500, 750, 1000, 1500,
  2000, 3000, 5000, 7500, 10000, 15000, 25000, 50000,
];

/**
 * Slider stops covering `maxDollars` (the largest row on any column): the
 * canonical prefix through the smallest stop at or above the data, floored
 * at $50 so the control stays useful on tiny datasets, extended by doubling
 * when the data exceeds the largest canonical stop. Always starts at 0
 * (threshold off) and is strictly ascending.
 */
export function sankeyThresholdStops(maxDollars: number): number[] {
  const target = Math.max(50, Number.isFinite(maxDollars) ? maxDollars : 0);
  const ceiling = SANKEY_THRESHOLD_STOPS.find((s) => s >= target);
  if (ceiling != null) return SANKEY_THRESHOLD_STOPS.filter((s) => s <= ceiling);
  // Beyond the canonical range: keep every canonical stop, then double
  // (50k → 100k → 200k …) until covered.
  const stops = [...SANKEY_THRESHOLD_STOPS];
  const lastCanonical = stops[stops.length - 1]!;
  let next = lastCanonical * 2;
  while (next < target) {
    stops.push(next);
    next *= 2;
  }
  stops.push(next);
  return stops;
}

/**
 * Slider position for a dollar threshold: the nearest stop (ties round
 * down, out-of-range clamps). Stored dollar values from before the stepped
 * slider snap to their closest stop through this.
 */
export function sankeyThresholdStep(stops: readonly number[], dollars: number): number {
  if (stops.length === 0) return 0;
  let best = 0;
  for (let i = 1; i < stops.length; i++) {
    const cur = Math.abs((stops[i] ?? 0) - dollars);
    const prev = Math.abs((stops[best] ?? 0) - dollars);
    if (cur < prev) best = i;
  }
  return best;
}

export type SankeyBandSpan = {
  /** Sub-band vertical extent; spans tile the input band edge to edge. */
  y0: number;
  y1: number;
  /** Index into the input values, so colors survive skipped cells. */
  valueIndex: number;
};

/**
 * Subdivide an income band `[y0, y1]` into one span per positive cell
 * value, proportional to value, in input order: the Categories-grouped
 * income bar nests each income→group band's downstream categories inside
 * it, so the category colors drive the bar's segments. Each category has
 * exactly one parent group, so the split is exact — income i's span for
 * category c is its fungible share of that category's funded cell.
 *
 * - Spans tile the band edge to edge (the last span snaps to y1, so float
 *   shares leave no hairline gap); shared boundaries render as hard edges
 *   downstream in sankeyIncomeGradientStops.
 * - Non-positive values are skipped (defensive: layout cells are > 0);
 *   survivors keep their input index for color lookup.
 * - Empty, all non-positive, or zero-height input yields [] so the caller
 *   falls back to the whole band in the group color.
 */
export function subdivideBandByValues(
  band: readonly [number, number],
  values: readonly number[]
): SankeyBandSpan[] {
  const [y0, y1] = band;
  if (!(y1 > y0)) return [];
  let total = 0;
  for (const v of values) {
    if (v > 0) total += v;
  }
  if (!(total > 0)) return [];
  const live = values
    .map((value, valueIndex) => ({ value, valueIndex }))
    .filter((c) => c.value > 0);
  const spans: SankeyBandSpan[] = [];
  let y = y0;
  live.forEach((c, k) => {
    const last = k === live.length - 1;
    // The last span snaps to the band edge instead of accumulating float
    // error across the shares.
    const ny = last ? y1 : y + ((y1 - y0) * c.value) / total;
    spans.push({ y0: y, y1: ny, valueIndex: c.valueIndex });
    y = ny;
  });
  return spans;
}

// ---------------------------------------------------------------------------
// Sankey color math: pure, deterministic, and part of the layout objects.
// The layout resolves every drawable's exact fill (flat colors and gradient
// stops), so rendering is pure presentation with no color logic. Canonical
// home of the palette (previously in ui/chartUtils, which re-exports it).
// ---------------------------------------------------------------------------

export const PALETTE = [
  "#2f7fb0", // 0: Classic Steel Blue
  "#5c8f2c", // 1: Olive/Forest Green
  "#e8a33d", // 2: Amber/Gold
  "#7e57c2", // 3: Purple/Violet
  "#d45042", // 4: Coral Red
  "#26a69a", // 5: Teal/Cyan
  "#1f5c85", // 6: Deep Navy
  "#c07d1c", // 7: Warm Ochre
  "#b0608f", // 8: Rose/Magenta
  "#5aa5d0", // 9: Sky Blue
  "#78909c", // 10: Slate Grey
  "#8bc34a", // 11: Lime Green
];

export function colorAt(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? "#888";
}

// The merged "Other" bucket always renders slate; the unspent-income plug
// is green and each expense's over-income slice is neutral gray (an
// unfunded slice is not a series, so it never takes a palette color).
export const OTHER_BUCKET_COLOR = "#78909c";
export const REMAINING_COLOR = "#2f9e5f";
export const OVER_INCOME_COLOR = "#a3adb6";
// Sankey income bars carry no series color: every left-column bar renders
// this one neutral gray so the income side never competes with the
// group/category colors on the right.
export const SANKEY_INCOME_COLOR = "#9aa3ad";

// Stable color per series name (djb2 hash into PALETTE): a category or
// merchant keeps its color across month ranges, dimension toggles, and
// threshold merges. Bucket/plug colors are NEVER name-based: a literal
// "Other" or "Remaining" row keeps its own hash color, and only rows
// flagged bucket/plug render slate/green (see sankeyTargetColor) —
// otherwise a real row shares the computed rows' color and the flows that
// share the color stop being traceable.
export function colorForName(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length] ?? "#888";
}

/**
 * One color for a right-column Sankey target: the category (or merchant)
 * determines its own color, and that color flows backwards along every
 * ribbon arriving at it — no matter which middle group each ribbon comes
 * from. The parent group never tints the target: two categories sharing a
 * group keep their own stable hues, and a merchant split across groups is
 * still one color on every leg. The Remaining plug stays green and merged
 * Other buckets stay slate — both by flag, never by name, so a literal
 * "Remaining" or "Other" row still keeps its own stable color. Sources and
 * middles resolve through the same function with isPlug: false.
 */
export function sankeyTargetColor(t: {
  name: string;
  bucket: boolean;
  isPlug: boolean;
}): string {
  if (t.isPlug) return REMAINING_COLOR;
  if (t.bucket) return OTHER_BUCKET_COLOR;
  return colorForName(t.name);
}

/** One outgoing ribbon band across an income bar: vertical span + ribbon color. */
export type SankeyIncomeBand = { y0: number; y1: number; color: string };
/** One linear-gradient stop: fractional offset + color. */
export type SankeyGradientStop = { offset: number; color: string };

/**
 * Hard-edged top-to-bottom gradient stops for a Sankey income or middle
 * bar, built from the colors of the ribbons extending from it: each band
 * keeps its ribbon's destination color through its exact span, and
 * adjacent bands meet at a hard edge on their shared boundary — so every
 * bar segment matches the ribbon leaving it. (An earlier feathered blend
 * smeared each boundary across the bar and the bar stopped matching its
 * ribbons.) Pure geometry → stops.
 *
 * - Band order is the gradient order (top to bottom); zero-height bands
 *   are skipped.
 * - Shared boundary offsets are kept, not collapsed: the duplicate offset
 *   is what renders the hard edge between two bands.
 * - A single band (or none, defensively) yields a solid fill: the band's
 *   own color, or `fallback` when there are no bands (the neutral income
 *   gray for income bars, the group's own color for middle bars with no
 *   outgoing ribbons).
 */
export function sankeyIncomeGradientStops(
  barY0: number,
  barY1: number,
  bands: readonly SankeyIncomeBand[],
  fallback: string = SANKEY_INCOME_COLOR
): SankeyGradientStop[] {
  const h = barY1 - barY0;
  const live = bands.filter((b) => b.y1 > b.y0 && h > 0);
  if (live.length === 0) {
    return [
      { offset: 0, color: fallback },
      { offset: 1, color: fallback },
    ];
  }
  if (live.length === 1) {
    return [
      { offset: 0, color: live[0]!.color },
      { offset: 1, color: live[0]!.color },
    ];
  }
  const frac = (y: number) => (y - barY0) / h;
  const clamp01 = (o: number) => Math.min(1, Math.max(0, o));
  const stops: SankeyGradientStop[] = [];
  for (const b of live) {
    stops.push({ offset: clamp01(frac(b.y0)), color: b.color });
    stops.push({ offset: clamp01(frac(b.y1)), color: b.color });
  }
  // Bands arrive top-to-bottom, so this sort is a no-op on well-formed
  // input; stability keeps each shared boundary's outgoing color before
  // the incoming one, which is what renders the hard edge.
  stops.sort((a, b) => a.offset - b.offset);
  return stops;
}

export type SankeyGeometryOptions = {
  /** Total SVG width/height in px. */
  width: number;
  height: number;
  /** Width of the source and target node bars. Defaults to 14. */
  nodeWidth?: number;
  /** Vertical gap between target nodes. Defaults to 6. */
  nodeGap?: number;
  /**
   * Minimum drawn node height so tiny flows stay hoverable. Defaults to 8.
   * Legacy two-column layouts only — the grouped layout sizes bars from
   * their bands (see minLinkHeight) and reserves label pitch separately,
   * so it ignores this option.
   */
  minNodeHeight?: number;
  /**
   * Minimum drawn band height in the grouped layout: every right-hop cell
   * band and every Remaining plug band draws at least this thick, so tiny
   * flows stay visible as hairlines instead of vanishing. Bars wrap their
   * bands exactly — nothing is ever taken from large bars to fund the
   * floor (no stealing, no crush). Defaults to SANKEY_MIN_LINK_HEIGHT.
   * Legacy layouts ignore this option.
   */
  minLinkHeight?: number;
  /**
   * Left-hop detail in the grouped layout: "bands" draws one whole ribbon
   * per income→middle band (plus the full-width Remaining ribbons);
   * "cells" additionally subdivides each band into one sub-ribbon per
   * downstream cell (leftCells), so each color crosses the middle at one
   * contiguous thickness. Defaults to "bands".
   */
  leftDetail?: "bands" | "cells";
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
  /**
   * Exact flat fill for the bar. Targets render this; sources and middles
   * render their gradient stops (sourceFills/middleFills) and use this as
   * the no-bands fallback color.
   */
  fill: string;
  /**
   * Vertical center for the bar's two-line label, in SVG px. Bars shorter
   * than a label still anchor the label clear of neighbors (the layout
   * reserves label pitch per row), so rendering positions labels here
   * verbatim — never recomputed view-side.
   */
  labelY: number;
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
// captions clear of the source bar. Legacy layouts size the chart with
// sankeyContentHeight; the grouped layout reserves SANKEY_MIN_PITCH per
// row itself and reports its canvas need as contentHeight.
// ---------------------------------------------------------------------------

/** Minimum node height: a two-line label (name + amount) needs a 24px row. */
export const SANKEY_NODE_MIN_HEIGHT = 24;
/** Vertical gap between nodes; pitch = height + gap = 32px per row. */
export const SANKEY_NODE_GAP = 8;
/** Minimum vertical pitch per node so adjacent two-line labels never touch. */
export const SANKEY_MIN_PITCH = SANKEY_NODE_MIN_HEIGHT + SANKEY_NODE_GAP;
/**
 * Minimum drawn band height in the grouped layout: every right-hop cell
 * band and every Remaining plug band draws at least this thick. A hairline
 * that stays visible without pretending to be more flow than it is — bars
 * wrap their bands exactly, so the floor only ever grows tiny bars and the
 * canvas (via contentHeight), never shrinks large ones.
 */
export const SANKEY_MIN_LINK_HEIGHT = 2;
/**
 * Minimum label-center offset below a row's top edge: labelY sits at
 * slotTop + max(barH / 2, this), so hairline bars still anchor their label
 * inside their own reserved pitch instead of on the sliver.
 */
export const SANKEY_LABEL_CENTER_MIN = 13;
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
 * Minimum left-column source bar height (px) that fits a two-line
 * (name + amount) label. Shorter bars render the name only so tiny income
 * sources stay legible instead of crushing two lines into a sliver.
 */
export const SANKEY_SOURCE_AMOUNT_MIN_HEIGHT = 26;

/**
 * Whether a left-column source bar of `nodeHeight` px fits a two-line
 * label. Pure (decides from the rendered node height) so the view rule is
 * unit-testable.
 */
export function showSankeySourceAmount(nodeHeight: number): boolean {
  return nodeHeight >= SANKEY_SOURCE_AMOUNT_MIN_HEIGHT;
}

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
 * Auto-fit "Under" threshold in whole dollars (always one of `stops`): the
 * smallest stop whose merged layout fits `containerHeight`, so the Sankey
 * shows fully on first paint with no amounts under the fold. Fit is
 * measured with the real layout (contentHeight at the container height),
 * not a row-count heuristic, so bars, pitch, and the Remaining lane all
 * count exactly as rendered.
 *
 * When no stop fits, returns the stop with the smallest contentHeight —
 * ties prefer the smaller stop — so the chart gets as close to the
 * viewport as merging allows. Empty stops yield 0. Callers pass the
 * measured container height.
 */
export function sankeyAutoFitThreshold(
  groups: SpendingBreakdownItem[],
  targets: SpendingBreakdownItem[],
  links: SpendingGroupFlowLink[],
  income: SpendingBreakdownItem[],
  stops: readonly number[],
  containerHeight: number
): number {
  if (stops.length === 0) return 0;
  let fallback = stops[0] ?? 0;
  let fallbackHeight = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    const thresholdCents = Math.round(stop * 100);
    const merged = mergeGroupFlow(groups, targets, links, thresholdCents);
    const mergedIncome = mergeBelowThreshold(income, thresholdCents);
    // Width is irrelevant to heights (the y-geometry never reads x), so a
    // fixed width keeps the probe reproducible; height is the container's.
    const probe = layoutGroupedIncomeSankey(
      mergedIncome.items,
      merged.groups,
      merged.targets,
      merged.links,
      {
        width: 800,
        height: Math.max(0, containerHeight),
        padTop: SANKEY_PAD_TOP,
        padBottom: SANKEY_PAD_BOTTOM,
        nodeGap: SANKEY_NODE_GAP,
      }
    );
    if (probe.contentHeight < fallbackHeight) {
      fallbackHeight = probe.contentHeight;
      fallback = stop;
    }
    if (probe.contentHeight <= containerHeight) return stop;
  }
  return fallback;
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

/**
 * Closed bezier ribbon path from the source band to the target band.
 * The layout uses it for every ribbon and sub-ribbon, so a subdivided
 * band reads as one ribbon split lengthwise.
 */
export function ribbonPath(
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
 * Closed lane ribbon path for a Remaining plug ribbon: from its source band
 * the ribbon drops into a dedicated lane below the middle column, bridges
 * horizontally under the middle bars ([laneX0, laneX1] is the middle bar
 * column), then traverses to its target band on the right. All three runs
 * share the ribbonPath curve family (horizontal tangents at every joint, so
 * the joints are smooth), and the bridge is straight, so the whole path
 * reads as one ribbon that dips under the groups instead of a diagonal
 * slash across them.
 *
 * The traverse run spans [laneX1, x1] — the same x-range as the middle→target
 * ribbons — so when the lane sits below the middle column and the target
 * band sits below the last spending target, the traverse cannot cross any
 * category ribbon: every curve shares one x-parameterization, making each
 * edge a convex combination of its endpoints, and both endpoints of the
 * plug's top edge sit strictly below both endpoints of every category
 * ribbon's bottom edge. (The drop run still crosses income→group ribbons in
 * the left half: the plug band is buried inside its source bar while the
 * lane sits below every middle bar, so the endpoints straddle and a crossing
 * is topological — the same dense-bipartite crossings group ribbons already
 * make with each other. What the lane removes is every crossing with a BAR
 * and every crossing with a middle→target category ribbon.)
 */
export function remainingLanePath(
  x0: number,
  laneX0: number,
  laneX1: number,
  x1: number,
  sy0: number,
  sy1: number,
  ly0: number,
  ly1: number,
  ty0: number,
  ty1: number
): string {
  const f = (n: number) => n.toFixed(2);
  const mDrop = (x0 + laneX0) / 2;
  const mTrav = (laneX1 + x1) / 2;
  return (
    `M ${f(x0)} ${f(sy0)} ` +
    `C ${f(mDrop)} ${f(sy0)} ${f(mDrop)} ${f(ly0)} ${f(laneX0)} ${f(ly0)} ` +
    `L ${f(laneX1)} ${f(ly0)} ` +
    `C ${f(mTrav)} ${f(ly0)} ${f(mTrav)} ${f(ty0)} ${f(x1)} ${f(ty0)} ` +
    `L ${f(x1)} ${f(ty1)} ` +
    `C ${f(mTrav)} ${f(ty1)} ${f(mTrav)} ${f(ly1)} ${f(laneX1)} ${f(ly1)} ` +
    `L ${f(laneX0)} ${f(ly1)} ` +
    `C ${f(mDrop)} ${f(ly1)} ${f(mDrop)} ${f(sy1)} ${f(x0)} ${f(sy1)} Z`
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
    nodes.push({ name: it.name, value: it.value, mergedCount: it.mergedCount, bucket: it.bucket === true, share, x: nodeX, y, w: nodeWidth, h, fill: sankeyTargetColor({ name: it.name, bucket: it.bucket === true, isPlug: false }), labelY: y + h / 2 });
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
  /**
   * Height of the unfunded segment at the node's bottom edge (px). Always
   * 0 in the grouped layout, whose bars wrap their funded flow (the
   * shortfall shows in tooltips and the header only); the legacy direct
   * layout still reserves the segment.
   */
  unfundedH: number;
};

export type DirectSankeyLinkLayout = SankeyLinkLayout & {
  sourceIndex: number;
  targetIndex: number;
  sourceName: string;
  targetName: string;
  /** Exact flat fill for the ribbon (the final destination's color). */
  fill: string;
  /**
   * Lane band vertical span at the middle-column bridge — present only on
   * lane-routed Remaining plug ribbons (see remainingLanePath). The ribbon
   * drops from its source band into this span, bridges under the middle
   * bars, then traverses to its target band; spans tile the lane in source
   * order with no taper (ly1 - ly0 equals the source and target heights).
   */
  ly0?: number;
  ly1?: number;
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
    fill: sankeyTargetColor({ name: s.name, bucket: s.bucket === true, isPlug: false }),
    labelY: 0, // placed by the stacking pass below
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
    fill: sankeyTargetColor({
      name: t.name,
      bucket: t.bucket === true,
      isPlug: incomeTotal > spendingTotal && j === tgtItems.length - 1 && t.name === REMAINING_LABEL,
    }),
    labelY: 0, // placed by the stacking pass below
    fundedValue: model.funded[j] ?? 0,
    unfundedValue: model.unfunded[j] ?? 0,
    unfundedH: unfundedH[j] ?? 0,
  }));

  // Stack both columns top-down; bands accumulate from each bar's top edge.
  let y = padTop;
  for (let i = 0; i < srcNodes.length; i++) {
    srcNodes[i]!.y = y;
    srcNodes[i]!.labelY = y + (leftH[i] ?? 0) / 2;
    y += (leftH[i] ?? 0) + gap;
  }
  y = padTop;
  for (let j = 0; j < tgtNodes.length; j++) {
    tgtNodes[j]!.y = y;
    tgtNodes[j]!.labelY = y + (rightH[j] ?? 0) / 2;
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
    fill: tgtNodes[l.targetIndex]?.fill ?? "#888",
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

/**
 * Right-hop link: one middle→target cell drawn as ONE ribbon. The right hop
 * used to subdivide each cell per income source, but the per-income bands
 * rendered as visible split lines inside every cell — money is fungible, so
 * a group feeds each of its targets through a single band in the TARGET's
 * color, and hovering a group spotlights every line leading out of it in
 * full. (sourceIndex into middles, targetIndex into targets.)
 */
export type GroupedRightLinkLayout = DirectSankeyLinkLayout;

/**
 * One left-hop sub-ribbon: income i's share of one middle→target cell,
 * drawn in the cell's target color. Emitted only when leftDetail is
 * "cells" (the Categories grouping); the Merchants grouping renders whole
 * group-colored bands instead. Band-major in cell order, so siblings tile
 * each source band edge to edge in the same order the cells leave the
 * middle — while the target slots tile each middle's incoming stack in
 * cell-major order (all incomes' slices of one cell adjacent), so each
 * color enters the middle as one contiguous block at exactly the thickness
 * it leaves it.
 */
export type GroupedLeftCellLayout = {
  /** Index into sources. */
  sourceIndex: number;
  /** Index into middles. */
  middleIndex: number;
  /** Index into linksRight: the downstream cell this slice funds. */
  rightLinkIndex: number;
  /** Index into targets: the downstream cell's destination. */
  targetIndex: number;
  sourceName: string;
  middleName: string;
  targetName: string;
  /** Funded cents in this slice (the cell's funded value times the income's share). */
  value: number;
  /** Source slice vertical span (left edge, within the income's band). */
  sy0: number;
  sy1: number;
  /** Target slice vertical span (right edge, within the cell's block). */
  ty0: number;
  ty1: number;
  x0: number;
  x1: number;
  /** Closed ribbon path from the source slice to the target slice. */
  d: string;
  /** Exact flat fill: the downstream cell's target color. */
  fill: string;
};

export type GroupedIncomeSankeyLayout = {
  incomeTotal: number;
  spendingTotal: number;
  /** Height-scale denominator: max(income, spending). */
  flowTotal: number;
  /**
   * Pixels per cent: the ONE linear scale of the whole chart. Every band
   * above the visibility floor draws at exactly value * pxPerCent on both
   * hops, so equal money always reads at equal thickness.
   */
  pxPerCent: number;
  /**
   * Effective band visibility floor in px (the minLinkHeight option): bands
   * below value * pxPerCent draw at this height instead. The only
   * distortion in the geometry, confined to hairline flows.
   */
  linkFloor: number;
  /**
   * Canvas height the layout needs (tallest column, or the Remaining lane
   * when it hangs lowest, plus padBottom). Callers size the SVG to
   * max(containerHeight, contentHeight): the layout never crushes bars to
   * fit — it reports how tall it is instead.
   */
  contentHeight: number;
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
   * Top y of the dedicated Remaining lane (one row gap below the last
   * middle bar), or null when no lane routing applies (no surplus, or no
   * middle column to bypass — with no middles the plug ribbon has nothing
   * to cross, so it stays a straight ribbon). Plug ribbons tile the lane
   * in source order via their ly0/ly1 spans.
   */
  remainingLaneY: number | null;
  /**
   * Pixels the Remaining lane pokes past the plot bottom (height minus
   * padBottom) — 0 in the common case, positive only when the middle
   * column hangs below the last spending target. The lane is transit-only
   * (no bar moves), so callers fit it by extending the CANVAS by this
   * amount while keeping the layout height: the plot is absolute-scale and
   * already full, so growing the layout height would just scale every bar
   * up with it and never open room. Same-layout re-call not needed.
   */
  remainingLaneOverflow: number;
  /**
   * Left ribbons: income → middle, fungible proportional allocation
   * (sourceIndex into sources, targetIndex into middles) — except the
   * Remaining ribbons, which carry the plug index (one past the last
   * middle) and run full-width from their income source to the Remaining
   * target through the dedicated lane below the middle column
   * (remainingLanePath): unspent money bypasses groups without crossing a
   * bar or a middle→target ribbon.
   */
  linksLeft: DirectSankeyLinkLayout[];
  /**
   * Right ribbons: middle → spending, exact rollup attribution, one ribbon
   * per cell (sourceIndex into middles, targetIndex into targets). Sorted
   * by (middle, target).
   */
  linksRight: GroupedRightLinkLayout[];
  /**
   * Left-hop sub-ribbons (see GroupedLeftCellLayout). Empty unless
   * leftDetail is "cells". Rendering draws these INSTEAD of the subdivided
   * whole bands; bands with no entry here (plug ribbons, degenerate bands)
   * render whole from linksLeft.
   */
  leftCells: GroupedLeftCellLayout[];
  /**
   * One fill gradient per source bar: hard-edged stops from the bar's
   * outgoing bands' colors (per-cell slices in "cells" mode, whole-band
   * group colors in "bands" mode), so every segment meets its ribbon
   * exactly. Rendering maps these stops to gradient elements verbatim.
   */
  sourceFills: SankeyGradientStop[][];
  /**
   * One fill gradient per middle bar: hard-edged stops from the bar's
   * outgoing cells' target colors, so every segment meets its ribbon
   * exactly. Rendering maps these stops to gradient elements verbatim.
   */
  middleFills: SankeyGradientStop[][];
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
 * unspent money bypasses groups through a dedicated lane below the middle
 * column, so those ribbons cross no bar and no middle→target ribbon.
 *
 * Math-first: this function computes the complete reproducible picture —
 * every node, band, and ribbon with exact y/height/color — and rendering
 * draws it verbatim with no layout logic of its own. The layout is
 * deterministic: equal inputs serialize to identical JSON.
 *
 * Geometry contract (covered by unit tests):
 * - ONE linear scale (pxPerCent) governs the whole chart: every band above
 *   the visibility floor draws at exactly value * pxPerCent on both hops,
 *   so equal money always reads at equal thickness anywhere. The only
 *   distortion is the band floor (linkFloor): bands below it draw at floor
 *   height instead of vanishing. Bars wrap their bands exactly — the floor
 *   only ever grows tiny bars and the canvas, never shrinks large ones:
 *   there is no stealing, so the largest flow always draws the largest bar.
 * - Right ribbon heights derive from cell values directly; Remaining bands
 *   the same. Each middle→target cell draws as ONE ribbon carrying the
 *   full cell value — no per-income subdivision, so no split lines inside
 *   a cell. Every ribbon has equal height at both ends (no taper): bands
 *   within a target run in middle order (source order for the Remaining
 *   plug), bands within a middle run in target order on the way out.
 * - Middle bars wrap their outgoing bands exactly; with no income there
 *   are no bands and every bar is zero-height (labels still show via the
 *   reserved pitch). Incoming bands tile the same drawn stack from the
 *   bar's top edge with no slack on either side.
 * - With leftDetail "cells", each income→middle band subdivides into one
 *   sub-ribbon per downstream cell (leftCells): siblings tile the source
 *   band edge to edge in cell order, while the target slots tile the
 *   middle's incoming stack in cell-major order — every income's slice of
 *   one cell adjacent — so each color enters the middle as one contiguous
 *   block at exactly the thickness it leaves it (flow conservation per
 *   color, in the same order both sides). Sub-ribbons have no taper.
 * - There is no unfunded segment in the geometry (unfundedH is always 0):
 *   the shortfall shows in tooltips and the header only. fundedValue and
 *   unfundedValue still report the funded/unfunded split in cents. Under a
 *   shortfall every column only fills its funded share.
 * - Every row reserves label pitch (SANKEY_MIN_PITCH) independent of its
 *   bar height, so adjacent two-line labels never touch no matter how thin
 *   the bars; labelY anchors each label. The canvas need is reported as
 *   contentHeight — callers size the SVG to max(container, contentHeight)
 *   instead of the layout crushing bars to fit.
 * - Remaining plug ribbons route through a dedicated lane one row gap below
 *   the last middle bar (remainingLaneY): each drops from its source band
 *   into its lane span (ly0/ly1, tiling the lane in source order with no
 *   taper), bridges under the middle bars, then traverses to its plug-bar
 *   band — crossing no bar and no middle→target ribbon (the traverse shares
 *   the right-hop x-range and curve family, so the crossing-freedom is
 *   exact, not approximate). Lane crossings with income→group ribbons in
 *   the left half remain: the endpoints straddle topologically, the same
 *   dense-bipartite crossings group ribbons make with each other. With no
 *   middles the plug ribbon stays a straight ribbon (nothing to bypass).
 * - The lane is transit-only: no bar moves for it. contentHeight includes
 *   the lane bottom, so callers fit it by sizing the canvas (not by
 *   re-laying out at a taller height, which would just rescale every bar).
 *   remainingLaneOverflow still reports how far the lane pokes past the
 *   plot bottom (height minus padBottom); 0 in the common case.
 * - Node `share` is value/flowTotal on all three columns.
 * - Degenerate input (no positive right-column values, or a non-positive
 *   dimension) yields no nodes — never NaN geometry.
 * - Non-positive groups/targets are dropped, and links into dropped rows
 *   are dropped with them.
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
    minLinkHeight = SANKEY_MIN_LINK_HEIGHT,
    leftDetail = "bands",
    padLeft = 8,
    padRight = 8,
    padTop = 8,
    padBottom = 8,
  } = opts;
  // minNodeHeight is a legacy-layout option; the grouped layout sizes bars
  // from bands (minLinkHeight) with label pitch from SANKEY_MIN_PITCH.
  void opts.minNodeHeight;
  const linkFloor = Math.max(0, minLinkHeight);

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
      pxPerCent: 0,
      linkFloor,
      contentHeight: Math.max(0, height),
      sources: [],
      middles: [],
      targets: [],
      remainingTargetIndex: null,
      remainingLaneY: null,
      remainingLaneOverflow: 0,
      linksLeft: [],
      linksRight: [],
      leftCells: [],
      sourceFills: [],
      middleFills: [],
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

  // ONE linear scale for the whole chart: every band above the visibility
  // floor draws at exactly value * pxPerCent on both hops. Nothing is ever
  // taken from large bands to fund small ones — no stealing, no crush, so
  // the largest flow always draws the largest bar.
  const pxPerCent = flowTotal > 0 && bandH > 0 ? bandH / flowTotal : 0;
  const flooredBand = (fundedValue: number): number =>
    fundedValue > 0 ? Math.max(fundedValue * pxPerCent, linkFloor) : 0;

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

  // Ribbon pixel heights derive from VALUES directly (never from bars, so
  // a floored bar can never stretch its bands and a crowded column can
  // never shrink them): each right-hop cell band and each Remaining plug
  // band draws at max(funded * scale, floor). Bars wrap the bands below.
  const linkRH = rightVals.map((cell) => flooredBand(cell.value));
  const linkLH = new Array<number>(left.links.length).fill(0);
  for (const k of remIn) {
    linkLH[k] = flooredBand(left.links[k]?.value ?? 0);
  }
  const rightUnfundedH: number[] = rightItems.map(() => 0);

  // Target bars wrap their incoming bands exactly: spending targets sum
  // their cells, the Remaining plug sums its plug bands. There is no
  // unfunded segment in the geometry — the shortfall shows in tooltips
  // and the header only.
  const rightH = rightItems.map((_t, j) => {
    if (remainingTargetIndex === j) {
      return remIn.reduce((s, k) => s + (linkLH[k] ?? 0), 0);
    }
    return (tgtIn[j] ?? []).reduce((s, k) => s + (linkRH[k] ?? 0), 0);
  });

  // Middle bars wrap their outgoing bands exactly. With no income there
  // are no bands and every bar is zero-height (labels still show via the
  // reserved pitch below).
  const outStack = grpItems.map((_, i) =>
    (midOut[i] ?? []).reduce((s, k) => s + (linkRH[k] ?? 0), 0)
  );
  const midH = [...outStack];
  const midFunded = grpItems.map((g) => g.value * coverage);
  const midUnfundedH = grpItems.map(() => 0);

  // Left group-ribbon heights subdivide each middle's outgoing stack in
  // proportion to their values: bands tile the stack from the bar's top
  // edge, so the incoming stack always equals the outgoing stack exactly —
  // no slack on either side, no stretching.
  for (let i = 0; i < grpItems.length; i++) {
    const stackH = outStack[i] ?? 0;
    const fj = midFunded[i] ?? 0;
    if (fj > 0) {
      for (const k of midIn[i] ?? []) {
        linkLH[k] = stackH * ((left.links[k]?.value ?? 0) / fj);
      }
    }
  }

  // Sources wrap their outgoing bands exactly (group ribbons plus any
  // full-width Remaining ribbons).
  const bandSum = srcItems.map((_, i) =>
    (srcOut[i] ?? []).reduce((s, k) => s + (linkLH[k] ?? 0), 0)
  );
  const leftH = [...bandSum];

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
    fill: SANKEY_INCOME_COLOR,
    labelY: 0, // placed by the stacking pass below
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
    fill: sankeyTargetColor({ name: g.name, bucket: g.bucket === true, isPlug: false }),
    labelY: 0, // placed by the stacking pass below
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
    fill: sankeyTargetColor({
      name: t.name,
      bucket: t.bucket === true,
      isPlug: remainingTargetIndex === j,
    }),
    labelY: 0, // placed by the stacking pass below
    fundedValue: rightFunded[j] ?? 0,
    unfundedValue: t.value - (rightFunded[j] ?? 0),
    unfundedH: rightUnfundedH[j] ?? 0,
  }));

  // Stack all columns top-down; bands accumulate from each bar's top edge.
  // Bar height and label pitch are decoupled: every row reserves at least
  // SANKEY_MIN_PITCH below its top edge, so hairline bars never pull their
  // labels onto each other. Labels anchor at labelY (bar center, or the
  // minimum offset for bars shorter than a label).
  const stackColumn = (nodes: SankeyNodeLayout[]): number => {
    let top = padTop;
    nodes.forEach((node, i) => {
      node.y = top;
      node.labelY = top + Math.max(node.h / 2, SANKEY_LABEL_CENTER_MIN);
      if (i < nodes.length - 1) top += Math.max(node.h + gap, SANKEY_MIN_PITCH);
    });
    return nodes.length === 0 ? padTop : top + (nodes[nodes.length - 1]?.h ?? 0);
  };
  const srcBottom = stackColumn(srcNodes);
  const midBottom = stackColumn(midNodes);
  const tgtBottom = stackColumn(tgtNodes);

  // Dedicated Remaining lane: one row gap below the last middle bar, so
  // plug ribbons bridge under the middle column instead of slashing
  // diagonally across its bars and the category ribbons. Lane spans tile in
  // remIn (source) order at the plug bands' own heights — no taper, and the
  // lane sums to the plug bar height exactly. No lane when there is no plug
  // or no middle column (with no middles the plug ribbon crosses nothing,
  // so it stays a straight ribbon).
  let remainingLaneY: number | null = null;
  let remainingLaneOverflow = 0;
  let laneBottom = midBottom;
  const laneBand = new Map<number, { ly0: number; ly1: number }>();
  const lastMid = midNodes[midNodes.length - 1];
  if (remainingTargetIndex != null && lastMid != null && remIn.length > 0) {
    const laneY = lastMid.y + lastMid.h + gap;
    remainingLaneY = laneY;
    let ly = laneY;
    for (const k of remIn) {
      const h = linkLH[k] ?? 0;
      laneBand.set(k, { ly0: ly, ly1: ly + h });
      ly += h;
    }
    laneBottom = ly;
    remainingLaneOverflow = Math.max(0, ly - (height - padBottom));
  }

  const linksLeft: DirectSankeyLinkLayout[] = left.links.map((l, k) => {
    // targetIndex keys into middles; the Remaining ribbons carry the plug
    // index (one past the last middle) and land on remainingTargetIndex.
    const isPlug = hasRemaining && l.targetIndex === plugIndex;
    const targetName = left.targets[l.targetIndex]?.name ?? "";
    const link: DirectSankeyLinkLayout = {
      name: targetName,
      value: l.value,
      mergedCount: 1,
      sourceIndex: l.sourceIndex,
      targetIndex: l.targetIndex,
      sourceName: srcItems[l.sourceIndex]?.name ?? "",
      targetName,
      fill:
        isPlug && remainingTargetIndex != null
          ? (tgtNodes[remainingTargetIndex]?.fill ?? REMAINING_COLOR)
          : (midNodes[l.targetIndex]?.fill ?? SANKEY_INCOME_COLOR),
      sy0: 0,
      sy1: 0,
      ty0: 0,
      ty1: 0,
      x0: linkLX0,
      x1: isPlug ? linkRX1 : midX,
      d: "",
    };
    // Lane-routed plug ribbons carry their lane span (keyed by left.links
    // index — remIn collects exactly the plug entries, in order).
    const band = isPlug ? laneBand.get(k) : undefined;
    if (band != null) {
      link.ly0 = band.ly0;
      link.ly1 = band.ly1;
    }
    return link;
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

  // One ribbon per cell: rightVals is (middle, target) sorted, so bands
  // run in target order within a middle (via midOut) and in middle order
  // within a target (via tgtIn). With no income there are no cells
  // (coverage is 0), so linksRight is empty — never a sourceless ribbon.
  // The bands render in the target's color (see the type docs); hovering
  // an income spotlights every downstream cell in full instead of tracing
  // one income's sliver through each cell.
  const linksRight: GroupedRightLinkLayout[] = rightVals.map((cell, k) => ({
    name: tgtItems[cell.targetIndex]?.name ?? "",
    value: cell.value,
    mergedCount: 1,
    sourceIndex: cell.middleIndex,
    targetIndex: cell.targetIndex,
    sourceName: grpItems[cell.middleIndex]?.name ?? "",
    targetName: tgtItems[cell.targetIndex]?.name ?? "",
    fill: tgtNodes[cell.targetIndex]?.fill ?? "#888",
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
    // Lane-routed plug ribbons dip under the middle column (bridging its
    // bar column [midX, linkRX0]); every other ribbon stays a straight
    // bar-to-bar bezier.
    l.d =
      l.ly0 != null && l.ly1 != null
        ? remainingLanePath(
            l.x0,
            midX,
            linkRX0,
            l.x1,
            l.sy0,
            l.sy1,
            l.ly0,
            l.ly1,
            l.ty0,
            l.ty1
          )
        : ribbonPath(l.x0, l.x1, l.sy0, l.sy1, l.ty0, l.ty1);
  }
  for (const l of linksRight) {
    l.d = ribbonPath(l.x0, l.x1, l.sy0, l.sy1, l.ty0, l.ty1);
  }

  // Left-hop subdivision (leftDetail "cells" only): each income→middle band
  // splits into one sub-ribbon per downstream cell, in the cell's target
  // color. Siblings tile the source band edge to edge in cell order (the
  // same order the cells leave the middle on the right), weighed by the
  // cells' DRAWN heights — minimum-floored cells included — so the split
  // matches the outgoing side exactly. The target slots instead tile each
  // middle's incoming stack in cell-major order (all incomes' slices of
  // one cell adjacent), so each color enters the middle as one contiguous
  // block at exactly the thickness it leaves it. Plug bands and degenerate
  // bands (no cells, no funded flow) stay whole: they have no entry here
  // and render from linksLeft.
  const leftCells: GroupedLeftCellLayout[] = [];
  if (leftDetail === "cells") {
    for (let m = 0; m < midNodes.length; m++) {
      const cells = midOut[m] ?? [];
      const ins = midIn[m] ?? [];
      const midTop = midNodes[m]!.y;
      const stackH = outStack[m] ?? 0;
      const fj = midFunded[m] ?? 0;
      if (cells.length === 0 || ins.length === 0 || !(stackH > 0) || !(fj > 0)) continue;
      const weights = cells.map((k) => linkRH[k] ?? 0);
      // Target slots: flat (cell, income) weights tile the incoming stack,
      // so each cell's block lands contiguously in outgoing cell order.
      const flat: number[] = [];
      for (const k of cells) {
        const h = linkRH[k] ?? 0;
        for (const lk of ins) {
          flat.push((h * (left.links[lk]?.value ?? 0)) / fj);
        }
      }
      const targetSpans = subdivideBandByValues([midTop, midTop + stackH], flat);
      if (targetSpans.length !== flat.length) continue;
      for (const lk of ins) {
        const band = linksLeft[lk]!;
        const sourceSpans = subdivideBandByValues([band.sy0, band.sy1], weights);
        if (sourceSpans.length !== cells.length) continue;
        const inPos = ins.indexOf(lk);
        cells.forEach((rk, c) => {
          const src = sourceSpans[c]!;
          const tgt = targetSpans[c * ins.length + inPos]!;
          const cell = rightVals[rk]!;
          const targetIndex = cell.targetIndex;
          leftCells.push({
            sourceIndex: band.sourceIndex,
            middleIndex: m,
            rightLinkIndex: rk,
            targetIndex,
            sourceName: band.sourceName,
            middleName: grpItems[m]?.name ?? "",
            targetName: tgtNodes[targetIndex]?.name ?? "",
            value: (cell.value * (left.links[lk]?.value ?? 0)) / fj,
            sy0: src.y0,
            sy1: src.y1,
            ty0: tgt.y0,
            ty1: tgt.y1,
            x0: band.x0,
            x1: band.x1,
            d: ribbonPath(band.x0, band.x1, src.y0, src.y1, tgt.y0, tgt.y1),
            fill: tgtNodes[targetIndex]?.fill ?? "#888",
          });
        });
      }
    }
  }

  // One fill gradient per source bar from its outgoing bands' colors: the
  // per-cell slices in "cells" mode (same subdivision as the sub-ribbons,
  // so every segment meets its ribbon exactly), whole-band group colors in
  // "bands" mode. A bar with no outgoing bands falls back to solid gray.
  const sourceFills = srcNodes.map((bar, i) => {
    const bands: SankeyIncomeBand[] = [];
    for (const k of srcOut[i] ?? []) {
      const band = linksLeft[k]!;
      if (band.targetIndex >= midNodes.length) {
        bands.push({ y0: band.sy0, y1: band.sy1, color: band.fill });
        continue;
      }
      const subs = leftCells.filter(
        (c) => c.sourceIndex === i && c.middleIndex === band.targetIndex
      );
      if (subs.length === 0) {
        bands.push({ y0: band.sy0, y1: band.sy1, color: band.fill });
      } else {
        for (const s of subs) bands.push({ y0: s.sy0, y1: s.sy1, color: s.fill });
      }
    }
    return sankeyIncomeGradientStops(bar.y, bar.y + bar.h, bands, bar.fill);
  });

  // One fill gradient per middle bar from its outgoing cells' target
  // colors, so every segment meets its ribbon exactly. A bar with no
  // outgoing bands falls back to its solid group color.
  const middleFills = midNodes.map((bar, i) => {
    const bands: SankeyIncomeBand[] = [];
    for (const k of midOut[i] ?? []) {
      const cell = linksRight[k]!;
      bands.push({ y0: cell.sy0, y1: cell.sy1, color: cell.fill });
    }
    return sankeyIncomeGradientStops(bar.y, bar.y + bar.h, bands, bar.fill);
  });

  const contentHeight =
    Math.max(srcBottom, midBottom, tgtBottom, laneBottom) + padBottom;

  return {
    incomeTotal,
    spendingTotal,
    flowTotal,
    pxPerCent,
    linkFloor,
    contentHeight,
    sources: srcNodes,
    middles: midNodes,
    targets: tgtNodes,
    remainingTargetIndex,
    remainingLaneY,
    remainingLaneOverflow,
    linksLeft,
    linksRight,
    leftCells,
    sourceFills,
    middleFills,
    sourceLabelX: padLeft - SANKEY_SOURCE_LABEL_GAP,
    middleLabelX: midX + nodeWidth + SANKEY_MIDDLE_LABEL_GAP,
    targetLabelX: nodeX + nodeWidth + 8,
  };
}
