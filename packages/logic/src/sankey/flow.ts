import type { BudgetData, Transaction } from "../types.js";
import { nextMonthKey, num } from "../format.js";
import { isIncomeTransaction } from "../budget-engine.js";
import { isInternalTransfer, isOffBudgetTransfer } from "../transfers.js";
import type { MergedSpendingItem } from "./merge.js";

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

/**
 * Pseudo-group routing every still-held account's cell (mirrors the
 * "Uncategorized" pseudo-group precedent: a middle-column group with no
 * Budget position, so the "group" sort parks it last). Each qualifying
 * account — on-budget savings like EQ Bank just like off-budget RRSP/TFSA
 * pools — draws its own right-column target row under this group in both
 * dimensions: first-class destinations like categories, named by the
 * account. Exported so views and tests agree.
 */
export const STILL_HELD_GROUP_LABEL = "Still held";

/**
 * The app's reserved payee for stock-recognition rows (account openings,
 * appraisals — see server/queries/accounts.ts): such rows move no money in
 * the report range, so the income, spending, and held collectors all skip
 * them. Matching this string is domain logic, not a hack.
 */
export const STARTING_BALANCE_PAYEE = "Starting Balance";

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
 * Every month key in [startMonth, endMonth] (inclusive, ascending). Both ends
 * swap when reversed, matching the range functions below.
 */
function enumerateMonthsInRange(startMonth: string, endMonth: string): string[] {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;
  const months: string[] = [];
  // Bounded well past any real budget (a century of months): malformed
  // keys must truncate, never hang the report.
  for (let mk = actualStart, guard = 0; mk <= actualEnd && guard <= 1200; mk = nextMonthKey(mk), guard++) {
    months.push(mk);
  }
  return months;
}

/**
 * Monthly spending cells: target name -> group name -> per-month SIGNED net
 * outflow cents (parallel to `months`). One pass over the transactions with
 * the exact row semantics of computeSpendingGroupFlow (see that function) —
 * the range flow sums these months, and the time-aware series keeps them, so
 * both outputs agree by construction.
 */
function collectSpendMonths(
  data: BudgetData,
  startMonth: string,
  endMonth: string,
  dimension: SpendingDimension
): { months: string[]; cells: Map<string, Map<string, number[]>> } {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;
  const months = enumerateMonthsInRange(actualStart, actualEnd);
  const monthIndex = new Map(months.map((mk, i) => [mk, i]));

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

  const cells = new Map<string, Map<string, number[]>>();
  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    // Stock recognitions, never flows: "Starting Balance" rows (account
    // openings, appraisals) are excluded from spending in both dimensions.
    if (t.payee.trim() === STARTING_BALANCE_PAYEE) continue;
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
    let series = row.get(group);
    if (!series) {
      series = new Array<number>(months.length).fill(0);
      row.set(group, series);
    }
    // Amount < 0 is outflow (+ netOutflow); amount > 0 is a refund (- netOutflow).
    // mk passed the range check above, so its month index always exists.
    const mi = monthIndex.get(mk)!;
    series[mi] = series[mi]! - num(t.amount);
  }
  return { months, cells };
}

/**
 * Monthly income cells: source name -> per-month income cents (parallel to
 * `months`; every entry >= 0). Same relationship to computeIncomeBreakdown as
 * collectSpendMonths has to computeSpendingGroupFlow.
 */
function collectIncomeMonths(
  data: BudgetData,
  startMonth: string,
  endMonth: string
): { months: string[]; sources: Map<string, number[]> } {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;
  const months = enumerateMonthsInRange(actualStart, actualEnd);
  const monthIndex = new Map(months.map((mk, i) => [mk, i]));

  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));

  const sources = new Map<string, number[]>();
  const add = (name: string, mk: string, cents: number) => {
    let series = sources.get(name);
    if (!series) {
      series = new Array<number>(months.length).fill(0);
      sources.set(name, series);
    }
    // mk passed the range check, so its month index always exists.
    const i = monthIndex.get(mk)!;
    series[i] = series[i]! + cents;
  };
  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    // Stock recognitions, never flows: "Starting Balance" rows (account
    // openings, appraisals) are excluded from income.
    if (t.payee.trim() === STARTING_BALANCE_PAYEE) continue;
    const mk = t.date.slice(0, 7);
    if (mk < actualStart || mk > actualEnd) continue;

    if (t.transferAccountId == null && isIncomeTransaction(t, accountMap)) {
      const payee = t.payee.trim();
      const name = payee === "" ? "—" : payee;
      add(name, mk, num(t.amount));
    } else if (
      t.transferAccountId == null &&
      t.categoryId == null &&
      num(t.amount) > 0 &&
      (accountMap.get(t.accountId)?.onBudget ?? true) === false
    ) {
      // External profit in an off-budget account, grouped under the
      // account's own name (the account is the source). The isIncome flag is
      // deliberately NOT consulted here: the YNAB4 import sets isIncome=false
      // for every off-budget regular row, and the budget engine ignores the
      // flag off-budget too (isIncomeTransaction returns false before ever
      // reading it) — so a guard on the flag would exclude ALL genuine
      // interest/dividend/market-gain rows on imported data.
      const raw = accountMap.get(t.accountId)?.name.trim() ?? "";
      const name = raw === "" ? "—" : raw;
      add(name, mk, num(t.amount));
    }
  }
  return { months, sources };
}

/**
 * Monthly still-held cells: account name -> per-month SIGNED net-change cents
 * (parallel to `months`) for EVERY account — on- or off-budget — that still
 * holds money over the range. Pure balance accounting (+amount where the
 * account is the row's accountId, −amount where it is the transferAccountId),
 * with no income/spending classification: salary and contributions and
 * external profit in, purchases and withdrawals and transfers out. Split
 * parents are excluded (only split children move money) and "Starting
 * Balance" rows are excluded (stock recognitions, not flows).
 *
 * An account qualifies only when its range net change is POSITIVE and its
 * range-end balance is POSITIVE (range-end = the stored current balance
 * minus the signed post-range nets — post-range nets count every balance
 * effect including later "Starting Balance" rows, because the range-end
 * stock is a true balance, not a flow). The balance guard keeps liability
 * reduction out: excluding opening rows exposes debt paydown as a positive
 * range net, but a mortgage account — or a credit card carrying a balance —
 * still holds a negative balance, so it is never "held". Fully-cycled,
 * zero, and drawn-down accounts stay excluded by the same clamp-at-zero
 * philosophy as off-budget profit.
 *
 * Internal on→on transfers net across accounts by construction (chequing
 * −$1k / savings +$1k for one move), so a round-trip nets zero per account
 * and creates no rows, while a one-way move shifts held money between rows
 * without creating any. Conservation (pinned by unit tests): income −
 * spending = Σ signed on-nets + Σ signed off-nets over the included row
 * set — so with positive-only held rows on both sides the Remaining plug
 * is ≤ 0 and normally never renders: the plug DISSOLVES into per-account
 * cash rows, surviving only as a safety net on positive breaks
 * (missing-account legs, dust).
 */
function collectHeldMonths(
  data: BudgetData,
  startMonth: string,
  endMonth: string
): { months: string[]; cells: Map<string, number[]> } {
  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;
  const months = enumerateMonthsInRange(actualStart, actualEnd);
  const monthIndex = new Map(months.map((mk, i) => [mk, i]));

  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const tracked = new Map<number, { name: string; balance: number }>();
  for (const a of data.accounts) {
    const name = a.name.trim();
    tracked.set(a.id, { name: name === "" ? "—" : name, balance: num(a.balance) });
  }

  const inNets = new Map<number, number[]>();
  const postNets = new Map<number, number>();
  // The signed balance effects of one row on its account side(s): +amount
  // where the account holds the row, −amount where it is the transfer leg.
  // Legs naming accounts absent from the data drop out (missing-account
  // legs): their unmatched side is exactly the positive break the Remaining
  // plug survives to cover.
  const effectsOf = (t: Transaction): [number, number][] => {
    const amt = num(t.amount);
    const out: [number, number][] = [];
    if (tracked.has(t.accountId)) out.push([t.accountId, amt]);
    if (t.transferAccountId != null && tracked.has(t.transferAccountId)) {
      out.push([t.transferAccountId, -amt]);
    }
    return out;
  };
  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    const mk = t.date.slice(0, 7);
    if (mk >= actualStart && mk <= actualEnd) {
      // In-range flows exclude stock recognitions; mk passed the range
      // check, so its month index always exists.
      if (t.payee.trim() === STARTING_BALANCE_PAYEE) continue;
      const mi = monthIndex.get(mk)!;
      for (const [id, delta] of effectsOf(t)) {
        let series = inNets.get(id);
        if (!series) {
          series = new Array<number>(months.length).fill(0);
          inNets.set(id, series);
        }
        series[mi] = series[mi]! + delta;
      }
    } else if (mk > actualEnd) {
      // Post-range nets feed the range-end STOCK guard, so they count every
      // balance effect — including a later "Starting Balance" row (an
      // account opened after the range held nothing at range end). Pre-range
      // rows are irrelevant: range-end derives from the stored balance minus
      // post-range effects.
      for (const [id, delta] of effectsOf(t)) {
        postNets.set(id, (postNets.get(id) ?? 0) + delta);
      }
    }
  }

  const cells = new Map<string, number[]>();
  for (const [id, series] of inNets) {
    const net = series.reduce((s, v) => s + v, 0);
    if (!(net > 0)) continue;
    // Nets keys are only ever set under a tracked.has guard, so every
    // lookup hits.
    const acct = tracked.get(id)!;
    if (!(acct.balance - (postNets.get(id) ?? 0) > 0)) continue;
    // Same-named accounts merge under one row (sums the months); held rows
    // otherwise keep their own account name.
    const prev = cells.get(acct.name);
    if (prev) {
      for (let m = 0; m < months.length; m++) prev[m] = prev[m]! + series[m]!;
    } else {
      cells.set(acct.name, [...series]);
    }
  }
  return { months, cells };
}

/**
 * Combined monthly cells behind a SpendingGroupFlow: the spending cells
 * (collectSpendMonths) plus one STILL_HELD_GROUP_LABEL cell per still-held
 * account, on- or off-budget (collectHeldMonths), keyed by account name in
 * both dimensions. The range flow sums these months and the time-aware
 * series keeps them, so both outputs agree by construction — and held
 * demands compete with spending demands chronologically in the same
 * allocator.
 *
 * A held account sharing its name with a spending target (a merchant named
 * like the account, a category of the same name) merges into that target as
 * one more group leg — the merchant-split precedent: the target row shows
 * the total flow to that name, and the identity still reconciles cell-wise.
 * (A real category group named "Still held" would merge the same way — the
 * accepted shared-name edge the "Uncategorized" pseudo-group already has.)
 */
function collectFlowMonths(
  data: BudgetData,
  startMonth: string,
  endMonth: string,
  dimension: SpendingDimension
): { months: string[]; cells: Map<string, Map<string, number[]>> } {
  const spend = collectSpendMonths(data, startMonth, endMonth, dimension);
  const held = collectHeldMonths(data, startMonth, endMonth);
  for (const [name, nets] of held.cells) {
    let row = spend.cells.get(name);
    if (!row) {
      row = new Map();
      spend.cells.set(name, row);
    }
    const prev = row.get(STILL_HELD_GROUP_LABEL);
    if (prev) {
      for (let m = 0; m < spend.months.length; m++) prev[m] = prev[m]! + (nets[m] ?? 0);
    } else {
      row.set(STILL_HELD_GROUP_LABEL, [...nets]);
    }
  }
  return spend;
}

/**
 * Attribute range-netted spending cells (target -> group -> net outflow
 * cents) into the two-level group flow. Shared by computeSpendingGroupFlow
 * and computeMonthlySankeySeries so the range flow and the monthly series
 * attribute identically; see computeSpendingGroupFlow for the semantics.
 */
function buildSpendingGroupFlowFromCells(
  cells: Map<string, Map<string, number>>
): SpendingGroupFlow {
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
 *   by the time-aware fungible left-hop allocation; an off-budget account
 *   appears as income only for its external profit (see
 *   computeIncomeBreakdown).
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
 * Still-held accounts as chart rows: every account — on-budget savings
 * like EQ Bank just like off-budget RRSP/TFSA pools — that still holds
 * money over the range (see collectHeldMonths: positive range net AND
 * positive range-end balance) draws its own right-column target row named
 * by the account, routed through the STILL_HELD_GROUP_LABEL pseudo-group —
 * in BOTH dimensions, first-class destinations like categories. Full
 * partitioning dissolves the Remaining plug: income − spending − held ≤ 0
 * normally, so the plug renders only on positive breaks (missing-account
 * legs, dust) as a safety net — kept, never removed. The identity
 * income = spending + held + remaining holds everywhere (with "spending"
 * the non-held targets and "held" the Still-held cells).
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
  const { cells } = collectFlowMonths(data, startMonth, endMonth, dimension);
  const range = new Map<string, Map<string, number>>();
  for (const [target, row] of cells) {
    const out = new Map<string, number>();
    for (const [group, series] of row) {
      out.set(group, series.reduce((s, v) => s + v, 0));
    }
    range.set(target, out);
  }
  return buildSpendingGroupFlowFromCells(range);
}

export type MonthlySankeySeries = {
  /** Every month key in the range, ascending. Both matrices run parallel to this. */
  months: string[];
  /** Income source names, in computeIncomeBreakdown order for the same range. */
  incomeNames: string[];
  /** Group names, in flow.groups order. */
  groupNames: string[];
  /** Target names, in flow.targets order. */
  targetNames: string[];
  /**
   * Income cents per (month, source). Every entry is >= 0 and each source
   * column sums exactly to that source's range total.
   */
  incomeByMonth: number[][];
  /**
   * Spending cents per (month, range-flow link), in flow.links order. Every
   * entry is >= 0 and each link column sums exactly to that link's range
   * value — the scale target for time-aware funding.
   */
  cellByMonth: number[][];
};

/**
 * Monthly spending and income series behind a SpendingGroupFlow: the same
 * range-aggregated cells as computeSpendingGroupFlow/computeIncomeBreakdown,
 * kept per month so the left hop can fund spending chronologically instead
 * of spreading every income across the whole range (task-47: a 2015 income
 * fully spent in 2015 must not fund 2020 spending just because both sit in
 * the same report range).
 *
 * Monthly spending per link keeps the range link's value but follows the
 * link's own months: each month takes its positive net's share of the
 * range-attributed link value (scaled positive parts). Refund TIMING is
 * deliberately washed out — a refund nets against the link's range value and
 * the surviving spending keeps its months — while causality holds exactly:
 * a month with no positive activity contributes no slice. Dropped
 * (net <= 0) links contribute nothing, matching the range flow.
 *
 * Still-held cells keep months by the same rule: withdrawals and direct
 * spending wash out of the held value, and the surviving held money keeps
 * its months — so held demands compete with spending demands chronologically
 * in the same allocator.
 *
 * Monthly income needs no scaling: every income row is positive by
 * definition, so each source column sums to its range total exactly.
 */
export function computeMonthlySankeySeries(
  data: BudgetData,
  startMonth: string,
  endMonth: string,
  dimension: SpendingDimension
): MonthlySankeySeries {
  const spend = collectFlowMonths(data, startMonth, endMonth, dimension);
  const income = collectIncomeMonths(data, startMonth, endMonth);
  const range = new Map<string, Map<string, number>>();
  for (const [target, row] of spend.cells) {
    const out = new Map<string, number>();
    for (const [group, series] of row) {
      out.set(group, series.reduce((s, v) => s + v, 0));
    }
    range.set(target, out);
  }
  const flow = buildSpendingGroupFlowFromCells(range);

  const months = spend.months;
  const incomeNames = [...income.sources.entries()]
    .map(([name, series]) => ({ name, value: series.reduce((s, v) => s + v, 0) }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((s) => s.name);
  const incomeByMonth = months.map((_, m) =>
    // Names come straight from the map's keys, so every lookup hits.
    incomeNames.map((name) => income.sources.get(name)![m]!)
  );

  const cellByMonth = months.map((_, m) =>
    flow.links.map((link) => {
      // Every link was attributed from these same cells, so its endpoint
      // names and indices always resolve.
      const target = flow.targets[link.targetIndex]!.name;
      const group = flow.groups[link.groupIndex]!.name;
      const nets = spend.cells.get(target)!.get(group)!;
      let positives = 0;
      for (const v of nets) {
        if (v > 0) positives += v;
      }
      if (!(positives > 0)) return 0;
      const pm = nets[m]!;
      return pm > 0 ? (pm * link.value) / positives : 0;
    })
  );

  return {
    months,
    incomeNames,
    groupNames: flow.groups.map((g) => g.name),
    targetNames: flow.targets.map((t) => t.name),
    incomeByMonth,
    cellByMonth,
  };
}

/**
 * Aggregate net outflows over a contiguous month range (inclusive), grouped
 * by category name or merchant (payee) name — plus one row per still-held
 * account, on- or off-budget, named by the account. Returns items sorted by
 * value descending. This is the right-column half of computeSpendingGroupFlow —
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
 * as income. "Starting Balance" rows are excluded (stock recognitions, not
 * flows). The `isIncome` flag is NOT consulted for off-budget rows: the
 * YNAB4 import sets isIncome=false for every off-budget regular row, and
 * the budget engine ignores the flag off-budget (isIncomeTransaction
 * returns false before ever reading it) — matching the engine keeps
 * genuine interest/dividend/market-gain rows counted on imported data.
 *
 * Returns items sorted by value descending.
 */
export function computeIncomeBreakdown(
  data: BudgetData,
  startMonth: string,
  endMonth: string
): SpendingBreakdownItem[] {
  const { sources } = collectIncomeMonths(data, startMonth, endMonth);
  return [...sources.entries()]
    .map(([name, series]) => ({ name, value: series.reduce((s, v) => s + v, 0) }))
    .filter((s) => s.value > 0)
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
