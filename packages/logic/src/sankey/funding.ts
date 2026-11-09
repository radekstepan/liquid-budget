import type { MonthlySankeySeries, SpendingBreakdownItem, SpendingGroupFlow } from "./flow.js";
import type { MergedGroupFlowLink, MergedSpendingItem, SankeyTargetSort } from "./merge.js";
import { mergeBelowThreshold, mergeGroupFlow, partitionForMerge, sortMergedGroupFlow } from "./merge.js";

export type SankeyCellFunding = {
  /** Index into the income-source column. */
  sourceIndex: number;
  /** Index into the right-hop cell (link) column. */
  cellIndex: number;
  /** Funded cents (always >= SANKEY_FUNDING_EPSILON_CENTS — dust never ships). */
  value: number;
};

export type SankeyFundingResult = {
  /** One entry per funded (source, cell) pair, sorted by (cellIndex, sourceIndex). */
  funding: SankeyCellFunding[];
  /** Funded cents per cell (funding into the cell sums to this). */
  cellFunded: number[];
  /** Unfunded cents per cell (cell value minus funded). */
  cellUnfunded: number[];
  /** Surplus cents per source (income never spent). */
  remainingBySource: number[];
  incomeTotal: number;
  spendingTotal: number;
};

/**
 * Funding values below this many cents are float dust, not money: the
 * pool/backlog pro-rata loop multiplies fractions for a hundred-plus
 * months, so fully-spent sources leave e-13 pool residuals that fund e-53
 * "slices". Anything under a millionth of a cent draws no pixel and rounds
 * to no cent, but an unpruned dust slice still joins hover sets and gradient
 * stops — so allocation drops funding under this cutoff (the dust absorbs
 * into the cell shortfall / source surplus it came from, keeping both
 * conservation identities exact to the cutoff).
 */
export const SANKEY_FUNDING_EPSILON_CENTS = 1e-6;

/**
 * Fund every spending cell from the income pool, chronologically: each
 * month's income joins a per-source pool, each month's cell demands (plus
 * any backlog of still-unfunded earlier demands) draw from that pool
 * pro-rata to its composition, and whatever the pool cannot cover waits as
 * backlog for later income. The pool remainder at the end is the surplus
 * (per source); the demand remainder is the shortfall (per cell).
 *
 * This is the time-aware replacement for the report-wide fungible pro-rata
 * split (computeDirectFlowLinks): income can only fund demands once it has
 * arrived, so a fully-spent early income can never fund late spending —
 * while genuine savings still carry forward (a pool that never empties
 * funds later demands) and arrears still resolve (early demands wait for
 * late income instead of inventing a simultaneous over-and-under).
 *
 * Within a month money stays fungible (pro-rata across sources and cells);
 * only the month boundary is causal. On a single-month range this collapses
 * exactly to the legacy proportional split.
 *
 * Conservation: funding out of a source plus its surplus equals its income;
 * funding into a cell plus its shortfall equals its spending.
 */
export function allocateCellFunding(
  incomeByMonth: number[][],
  cellByMonth: number[][]
): SankeyFundingResult {
  const monthCount = Math.max(incomeByMonth.length, cellByMonth.length);
  const sourceCount = incomeByMonth.reduce((m, row) => Math.max(m, row.length), 0);
  const cellCount = cellByMonth.reduce((m, row) => Math.max(m, row.length), 0);

  const funded: number[][] = Array.from({ length: cellCount }, () =>
    new Array<number>(sourceCount).fill(0)
  );
  const pool = new Array<number>(sourceCount).fill(0);
  const backlog = new Array<number>(cellCount).fill(0);

  // pool/backlog/demand/funded and the total arrays below are dense and
  // indexed in range by construction; only the caller-owned matrix rows
  // (ragged or short months) read through `??` fallbacks.
  for (let m = 0; m < monthCount; m++) {
    const inc = incomeByMonth[m] ?? [];
    for (let s = 0; s < sourceCount; s++) {
      pool[s] = pool[s]! + (inc[s] ?? 0);
    }
    const spend = cellByMonth[m] ?? [];
    const demand = new Array<number>(cellCount).fill(0);
    let dTotal = 0;
    for (let c = 0; c < cellCount; c++) {
      demand[c] = backlog[c]! + (spend[c] ?? 0);
      dTotal += demand[c]!;
    }
    let pTotal = 0;
    for (let s = 0; s < sourceCount; s++) pTotal += pool[s]!;
    const fTotal = Math.min(pTotal, dTotal);
    // A positive minimum implies positive pool AND demand, so both
    // divisions below are safe.
    if (fTotal > 0) {
      for (let s = 0; s < sourceCount; s++) {
        const fromSource = fTotal * (pool[s]! / pTotal);
        pool[s] = pool[s]! - fromSource;
        for (let c = 0; c < cellCount; c++) {
          funded[c]![s] = funded[c]![s]! + fromSource * (demand[c]! / dTotal);
        }
      }
      for (let c = 0; c < cellCount; c++) {
        backlog[c] = demand[c]! - fTotal * (demand[c]! / dTotal);
      }
    } else {
      for (let c = 0; c < cellCount; c++) backlog[c] = demand[c]!;
    }
  }

  const cellTotals = new Array<number>(cellCount).fill(0);
  for (const row of cellByMonth) {
    row.forEach((v, c) => {
      cellTotals[c] = cellTotals[c]! + v;
    });
  }
  const incomeTotals = new Array<number>(sourceCount).fill(0);
  for (const row of incomeByMonth) {
    row.forEach((v, s) => {
      incomeTotals[s] = incomeTotals[s]! + v;
    });
  }

  const snap = (v: number): number => (Math.abs(v) < SANKEY_FUNDING_EPSILON_CENTS ? 0 : v);
  const funding: SankeyCellFunding[] = [];
  const cellFunded = new Array<number>(cellCount).fill(0);
  const sourceOut = new Array<number>(sourceCount).fill(0);
  for (let c = 0; c < cellCount; c++) {
    for (let s = 0; s < sourceCount; s++) {
      const v = funded[c]![s]!;
      // Dust never becomes a slice: only real funding draws ribbons and
      // joins hover sets. Dropped dust absorbs into the shortfall/surplus
      // below, so conservation holds to the cutoff.
      if (!(v >= SANKEY_FUNDING_EPSILON_CENTS)) continue;
      cellFunded[c] = cellFunded[c]! + v;
      sourceOut[s] = sourceOut[s]! + v;
      funding.push({ sourceIndex: s, cellIndex: c, value: v });
    }
  }
  funding.sort((a, b) => a.cellIndex - b.cellIndex || a.sourceIndex - b.sourceIndex);

  const cellUnfunded = cellTotals.map((t, c) => snap(t - cellFunded[c]!));
  const remainingBySource = incomeTotals.map((t, s) => snap(t - sourceOut[s]!));
  const incomeTotal = incomeTotals.reduce((s, v) => s + v, 0);
  const spendingTotal = cellTotals.reduce((s, v) => s + v, 0);
  return { funding, cellFunded, cellUnfunded, remainingBySource, incomeTotal, spendingTotal };
}

export type SankeyLeftHopCell = {
  /** Index into the view-model's income sources. */
  sourceIndex: number;
  /** Index into the view-model's right-hop links. */
  rightLinkIndex: number;
  /** Funded cents (always >= SANKEY_FUNDING_EPSILON_CENTS — dust never ships). */
  value: number;
};

export type SankeyLeftHopModel = {
  /**
   * Per-(source, right-hop cell) funded cents. The layout aggregates these
   * into income→middle bands and subdivides each band back into these exact
   * slices — no proportional re-derivation, so a zero here draws nothing.
   */
  cells: SankeyLeftHopCell[];
  /** Surplus cents per income source (index-aligned with the sources). */
  remainingBySource: number[];
  incomeTotal: number;
  spendingTotal: number;
};

export type SankeyViewModel = {
  /** Income column: identical to mergeBelowThreshold output for the inputs. */
  sources: MergedSpendingItem[];
  /** Middle column: identical to sortMergedGroupFlow output for the inputs. */
  groups: MergedSpendingItem[];
  /** Right column: identical to sortMergedGroupFlow output for the inputs. */
  targets: MergedSpendingItem[];
  /** Right-hop cells, in the same order as the sorted flow's links. */
  links: MergedGroupFlowLink[];
  /** Time-aware funding of those cells (indices key into sources/links). */
  left: SankeyLeftHopModel;
};

/**
 * The Sankey's complete data model: merged + sorted columns (via the same
 * mergeGroupFlow/mergeBelowThreshold/sortMergedGroupFlow calls the Bars
 * view uses, so the two views can never disagree) plus the time-aware
 * funding of each right-hop cell from the monthly series.
 *
 * `series` must come from computeMonthlySankeySeries over the same
 * (data, range, dimension) as `flow`/`income` — its matrices are
 * index-aligned with flow.links and the income array. Merging aggregates
 * the monthly series through the same partitions as the columns; sorting
 * carries each cell's funding with it (matched by endpoint identity, never
 * by position).
 */
export function computeSankeyViewModel(
  flow: SpendingGroupFlow,
  income: SpendingBreakdownItem[],
  series: MonthlySankeySeries,
  opts: {
    thresholdCents: number;
    groupOrder?: readonly string[];
    sort?: SankeyTargetSort;
    categoryOrder?: readonly string[];
  }
): SankeyViewModel {
  const { thresholdCents } = opts;
  const merged = mergeGroupFlow(flow.groups, flow.targets, flow.links, thresholdCents);
  const mergedIncome = mergeBelowThreshold(income, thresholdCents);
  const sorted = sortMergedGroupFlow(
    merged,
    opts.groupOrder ?? [],
    opts.sort ?? "amount",
    opts.categoryOrder ?? []
  );

  const gRemap = partitionForMerge(flow.groups, thresholdCents).remap;
  const tRemap = partitionForMerge(flow.targets, thresholdCents).remap;
  const iRemap = partitionForMerge(income, thresholdCents).remap;

  const mergedIncomeCount = mergedIncome.items.length;
  const mergedIncomeByMonth = series.months.map(() => new Array<number>(mergedIncomeCount).fill(0));
  series.incomeByMonth.forEach((row, m) => {
    row.forEach((v, s) => {
      if (!(v > 0)) return;
      // A misaligned caller series lands here; well-formed rows always hit.
      const mi = iRemap[s] ?? -1;
      if (mi < 0) return;
      mergedIncomeByMonth[m]![mi] = mergedIncomeByMonth[m]![mi]! + v;
    });
  });

  // Merged cells keyed exactly like mergeGroupFlow's re-aggregation.
  const mergedKeyOf = (mg: number, mt: number) => `${mg}:${mt}`;
  const mergedLinkIndex = new Map<string, number>();
  merged.links.forEach((l, k) => mergedLinkIndex.set(mergedKeyOf(l.groupIndex, l.targetIndex), k));
  const mergedCellByMonth = series.months.map(() => new Array<number>(merged.links.length).fill(0));
  series.cellByMonth.forEach((row, m) => {
    row.forEach((v, k) => {
      if (!(v > 0)) return;
      // Misaligned caller rows land in these guards; well-formed rows hit.
      const link = flow.links[k];
      if (!link) return;
      const mg = gRemap[link.groupIndex] ?? -1;
      const mt = tRemap[link.targetIndex] ?? -1;
      const mk = mergedLinkIndex.get(mergedKeyOf(mg, mt));
      if (mk == null) return;
      mergedCellByMonth[m]![mk] = mergedCellByMonth[m]![mk]! + v;
    });
  });

  const funding = allocateCellFunding(mergedIncomeByMonth, mergedCellByMonth);

  // Sorting permutes the links: carry each cell's funding along by endpoint
  // identity (name + bucket flag — a literal "Other" row and the merged
  // Other bucket share a name but never an identity; the NUL joiner keeps
  // even adversarial names unambiguous).
  const identOf = (item: MergedSpendingItem) => `${item.bucket === true ? "b" : "r"}:${item.name}`;
  const sortedLinkIndex = new Map<string, number>();
  // Merge and sort only ever emit valid endpoint indices, and sorting is a
  // permutation — so every merged link has exactly one sorted counterpart.
  sorted.links.forEach((l, j) => {
    const g = sorted.groups[l.groupIndex]!;
    const t = sorted.targets[l.targetIndex]!;
    sortedLinkIndex.set(`${identOf(g)}\u0000${identOf(t)}`, j);
  });
  const mergedToSorted = merged.links.map((l) => {
    const g = merged.groups[l.groupIndex]!;
    const t = merged.targets[l.targetIndex]!;
    return sortedLinkIndex.get(`${identOf(g)}\u0000${identOf(t)}`)!;
  });

  const cells: SankeyLeftHopCell[] = [];
  for (const f of funding.funding) {
    const j = mergedToSorted[f.cellIndex]!;
    cells.push({ sourceIndex: f.sourceIndex, rightLinkIndex: j, value: f.value });
  }
  cells.sort((a, b) => a.rightLinkIndex - b.rightLinkIndex || a.sourceIndex - b.sourceIndex);

  return {
    sources: mergedIncome.items,
    groups: sorted.groups,
    targets: sorted.targets,
    links: sorted.links,
    left: {
      cells,
      remainingBySource: funding.remainingBySource,
      incomeTotal: funding.incomeTotal,
      spendingTotal: funding.spendingTotal,
    },
  };
}

/**
 * Canonical "Under" threshold stops in whole dollars. The slider walks these
 * positions (0 = off) instead of raw dollars, so the first steps merge in
 * small increments ($10, $25, $50…) where rows are dense and later steps
 * jump in thousands where only the long tail is left. Gaps grow down the
 * list; sankeyThresholdStops doubles past the last stop for huge datasets.
 */
