import type { MonthlySankeySeries, SpendingBreakdownItem, SpendingGroupFlow, SpendingGroupFlowLink } from "./flow.js";
import { STILL_HELD_GROUP_LABEL } from "./flow.js";

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

export type MergePartition = {
  merged: MergedSpendingItem[];
  /** Input position -> merged position (the trailing Other slot for folded rows). */
  remap: number[];
  otherCount: number;
  otherValue: number;
};

/**
 * Single-column merge partition behind mergeBelowThreshold and
 * mergeGroupFlow (kept rows stay in input order, "Other" sorts last), plus
 * the input->merged index remap the monthly series aggregation reuses — one
 * implementation, so the merged columns and the merged series can never
 * assign a row differently.
 */
export function partitionForMerge(
  items: SpendingBreakdownItem[],
  thresholdCents: number
): MergePartition {
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
  return { merged, remap, otherCount, otherValue };
}

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
  const p = partitionForMerge(items, thresholdCents);
  return { items: p.merged, otherCount: p.otherCount, otherValue: p.otherValue };
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
  const g = partitionForMerge(groups, thresholdCents);
  const t = partitionForMerge(targets, thresholdCents);

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
 * - Names missing from `groupOrder` (the Uncategorized and Still-held
 *   pseudo-groups, the "—" fallback) sort after the known groups, keeping
 *   current order.
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
 * Exclude still-held money from a spending flow and its monthly series: the
 * logic-level transform behind the Spending Sankey's Still-held toggle.
 * Drops every cell routed through the STILL_HELD_GROUP_LABEL pseudo-group —
 * the Still-held middle-group bar, the held target rows, and (via the
 * dropped series columns) their right-hop ribbons and left-hop funding
 * sub-ribbons — and hands the surviving pair to the usual merge / sort /
 * view-model pipeline, so the hidden held total refolds into the Remaining
 * surplus plug through the existing allocator: income = spending + remaining
 * still reconciles and no new plug or shortfall state exists.
 *
 * Semantics:
 * - Kept rows hold their input positions (targets shrink in place, never
 *   re-sort), so toggling only removes held rows — nothing jumps. The
 *   (groupIndex, targetIndex) link sort survives because both index remaps
 *   are order-preserving.
 * - A target sharing its name with a held account (a merchant or category
 *   named like the account — the accepted shared-name edge) SHRINKS by its
 *   Still-held leg instead of vanishing: only pure-held targets drop.
 * - Group values re-derive from the kept links (like
 *   buildSpendingGroupFlowFromCells), so group values always agree with the
 *   drawn ribbons; a real category group literally named "Still held" would
 *   merge with held cells at collection already, so it excludes with them —
 *   the same accepted edge the "Uncategorized" pseudo-group has.
 * - The series keeps its months, income names, and income matrix untouched;
 *   group/target names rebuild from the stripped flow and the cell matrix
 *   drops exactly the excluded links' columns, so the pair stays
 *   index-aligned for computeSankeyViewModel. A missing series (the legacy
 *   no-series path) stays missing.
 * - No Still-held group, no-op: returns the inputs' own references, so the
 *   shown toggle state costs nothing and shares nothing.
 */
export function excludeHeldCells(
  flow: SpendingGroupFlow,
  series?: MonthlySankeySeries
): { flow: SpendingGroupFlow; series: MonthlySankeySeries | undefined } {
  const heldGroups = new Set<number>();
  flow.groups.forEach((g, i) => {
    if (g.name === STILL_HELD_GROUP_LABEL) heldGroups.add(i);
  });
  if (heldGroups.size === 0) return { flow, series };

  const keptPositions: number[] = [];
  const droppedByTarget = new Map<number, number>();
  flow.links.forEach((l, k) => {
    if (heldGroups.has(l.groupIndex)) {
      droppedByTarget.set(l.targetIndex, (droppedByTarget.get(l.targetIndex) ?? 0) + l.value);
    } else {
      keptPositions.push(k);
    }
  });

  const targetRemap = new Map<number, number>();
  const targets: SpendingBreakdownItem[] = [];
  flow.targets.forEach((t, i) => {
    const value = t.value - (droppedByTarget.get(i) ?? 0);
    if (!(value > 0)) return;
    targetRemap.set(i, targets.length);
    targets.push({ name: t.name, value });
  });

  const groupRemap = new Map<number, number>();
  const groupNames: string[] = [];
  flow.groups.forEach((g, i) => {
    if (heldGroups.has(i)) return;
    groupRemap.set(i, groupNames.length);
    groupNames.push(g.name);
  });

  // (original position, new group, new target, value) for each surviving
  // cell — the position keys the series column below, so the matrices can
  // never misalign with the links, even on defensive drops.
  const kept: { pos: number; g: number; t: number; value: number }[] = [];
  for (const pos of keptPositions) {
    const l = flow.links[pos]!;
    const g = groupRemap.get(l.groupIndex) ?? -1;
    const t = targetRemap.get(l.targetIndex) ?? -1;
    if (g < 0 || t < 0 || !(l.value > 0)) continue;
    kept.push({ pos, g, t, value: l.value });
  }

  // Groups re-derive from the kept links; a group left with no link drops
  // (defensive: a kept link's target always survives, since its non-held
  // legs alone keep it positive — well-formed flows never trigger this).
  const groupTotals = new Map<number, number>();
  for (const k of kept) {
    groupTotals.set(k.g, (groupTotals.get(k.g) ?? 0) + k.value);
  }
  const finalRemap = new Map<number, number>();
  const groups: SpendingBreakdownItem[] = [];
  groupNames.forEach((name, g) => {
    const value = groupTotals.get(g) ?? 0;
    if (!(value > 0)) return;
    finalRemap.set(g, groups.length);
    groups.push({ name, value });
  });

  const links: SpendingGroupFlowLink[] = [];
  const linkPositions: number[] = [];
  for (const k of kept) {
    const g = finalRemap.get(k.g) ?? -1;
    if (g < 0) continue;
    links.push({ groupIndex: g, targetIndex: k.t, value: k.value });
    linkPositions.push(k.pos);
  }

  const outSeries =
    series == null
      ? undefined
      : {
          months: series.months,
          incomeNames: series.incomeNames,
          groupNames: groups.map((g) => g.name),
          targetNames: targets.map((t) => t.name),
          incomeByMonth: series.incomeByMonth,
          cellByMonth: series.cellByMonth.map((row) =>
            linkPositions.map((pos) => row[pos] ?? 0)
          ),
        };
  return { flow: { groups, targets, links }, series: outSeries };
}
