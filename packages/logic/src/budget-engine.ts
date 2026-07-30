/**
 * budget-engine.ts
 *
 * Full YNAB4-faithful budget computation.
 *
 * Core rules (matching original YNAB4 behaviour):
 *
 * 1. CARRYOVER IS CUMULATIVE
 *    Each category accumulates its "available" balance month-by-month.
 *    available(month N) = available(month N-1) + assigned(N) + rawOutflow(N)
 *    The very first month seeds from `category.carryover` (a manually-entered
 *    starting balance).
 *
 * 2. TO BE BUDGETED (TBB) — cumulative
 *    tbb(month N) = income(N) - assigned(N, non-CC) + surplusTBB(N-1)
 *    Where surplusTBB = max(0, tbb of prior month) — surpluses carry forward,
 *    deficits do not (over-budgeting in one month doesn't retroactively reduce
 *    a future month's income, it just shows as a negative TBB in that month).
 *    Income = sum of uncategorised positive transactions in the month.
 *    When tbb < 0 the user has "over-budgeted" (assigned more than earned).
 *
 * 3. CREDIT CARD BUFFER (YNAB4's signature feature)
 *    When you charge spending to a credit card, YNAB4 automatically transfers
 *    the spent amount from the budget category into the linked CC Payment
 *    category.  This means the CC Payment category accumulates a "buffer"
 *    equal to how much you've charged — so you always have the money set aside
 *    to pay the bill.
 *
 *    Implementation:
 *    - For each CC Payment category linked to account A, sum all categorised
 *      negative transactions that posted to account A in the month.
 *    - Add that sum (as a positive credit) to the CC Payment category's
 *      available balance on top of carryover + assigned.
 *
 * 4. OUTFLOW DISPLAY COLUMN
 *    The display outflow for a category is clamped to min(0, rawFlow) —
 *    refunds/credits in a category don't show as positive outflow.
 */

import type { BudgetData, BudgetResult, CatRow, GroupRow } from "./types.js";
import { num } from "./format.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the full YNAB4 budget for a given month.
 *
 * @param data   Full budget dataset (all months of history).
 * @param month  ISO month key, e.g. "2025-07".
 * @returns      BudgetResult with groups, TBB, and meta-data.
 */
export function computeBudget(data: BudgetData, month: string): BudgetResult {
  // 1. Determine the ordered list of months we need to walk through.
  const months = getMonthsWithData(data);

  // Build cumulative carryover per category up to (but not including) `month`.
  const carryoverMap = buildCarryoverMap(data, months, month);

  // 2. Compute the current month's raw outflow per category.
  const outflowMap = buildOutflowMap(data, month);

  // 3. Identify credit-card groups and build CC buffer map.
  const ccGroupIds = new Set(
    data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );

  // CC Payment categories: Map<categoryId, linkedAccountId>
  const ccPayCatToAccount = new Map<number, number>();
  for (const c of data.categories) {
    if (ccGroupIds.has(c.groupId) && c.linkedAccountId != null) {
      ccPayCatToAccount.set(c.id, c.linkedAccountId);
    }
  }

  // CC buffer for this month: for each CC payment category, sum the
  // categorised negative transactions that hit the linked account.
  // This is the amount YNAB4 auto-transfers to the CC payment bucket.
  const ccBufferMap = buildCCBufferMap(data, month, ccPayCatToAccount);

  // 4. Assignments for the current month.
  const assignMap = new Map<number, number>();
  for (const a of data.assignments) {
    if (a.month === month) assignMap.set(a.categoryId, num(a.amount));
  }

  // 5. Build CatRow for every category.
  const catsByGroup = new Map<number, CatRow[]>();
  for (const c of data.categories) {
    const carryoverIn = carryoverMap.get(c.id) ?? 0;
    const assigned = assignMap.get(c.id) ?? 0;
    const rawFlow = outflowMap.get(c.id) ?? 0;
    const outflow = Math.min(0, rawFlow);

    // CC payment categories get an automatic buffer credit on top of their
    // carryover + assigned + rawFlow.
    const ccBuffer = ccBufferMap.get(c.id) ?? 0;
    const available = carryoverIn + assigned + rawFlow + ccBuffer;

    const fundedPct = computeFundedPct(c.goalTarget, assigned, available);

    const row: CatRow = {
      category: c,
      carryoverIn,
      assigned,
      outflow,
      available,
      ccBuffer,
      fundedPct,
    };

    const arr = catsByGroup.get(c.groupId) ?? [];
    arr.push(row);
    catsByGroup.set(c.groupId, arr);
  }

  // 6. Assemble GroupRow array, sorted by group.sort then category.sort.
  const groups: GroupRow[] = data.groups
    .slice()
    .sort((a, b) => a.sort - b.sort)
    .map((group) => {
      const rows = (catsByGroup.get(group.id) ?? []).sort(
        (a, b) => a.category.sort - b.category.sort
      );
      const assigned = rows.reduce((s, r) => s + r.assigned, 0);
      const outflow = rows.reduce((s, r) => s + r.outflow, 0);
      const available = rows.reduce((s, r) => s + r.available, 0);
      return { group, rows, assigned, outflow, available };
    });

  // 7. Compute cumulative TBB.
  // Prior months' surplus TBB carries forward into this month's available pool.
  const priorSurplus = computePriorTBBSurplus(data, months, month, ccGroupIds);
  const totalIncome = computeMonthIncome(data, month);
  const totalAssigned = groups
    .filter((g) => !ccGroupIds.has(g.group.id))
    .reduce((s, g) => s + g.assigned, 0);
  const tbb = totalIncome - totalAssigned + priorSurplus;

  return {
    groups,
    tbb,
    totalIncome,
    priorSurplus,
    overBudgeted: tbb < -0.004, // tiny epsilon to avoid floating-point false positives
    totalAssigned,
  };
}

/**
 * Compute To Be Budgeted for a given month without building the full group tree.
 * Includes prior months' surplus carryforward.
 */
export function computeTBB(data: BudgetData, month: string): number {
  const months = getMonthsWithData(data);
  const ccGroupIds = new Set(
    data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );
  const ccCatIds = new Set(
    data.categories.filter((c) => ccGroupIds.has(c.groupId)).map((c) => c.id)
  );
  const priorSurplus = computePriorTBBSurplus(data, months, month, ccGroupIds);
  const income = computeMonthIncome(data, month);
  const assigned = data.assignments
    .filter((a) => a.month === month && !ccCatIds.has(a.categoryId))
    .reduce((s, a) => s + num(a.amount), 0);
  return income - assigned + priorSurplus;
}

/**
 * Return an ascending-sorted unique list of all "YYYY-MM" keys that appear
 * in the dataset (from assignments or transactions).
 */
export function getMonthsWithData(data: BudgetData): string[] {
  const keys = new Set<string>();
  for (const a of data.assignments) keys.add(a.month);
  for (const t of data.transactions) keys.add(t.date.slice(0, 7));
  return [...keys].sort();
}

/**
 * Compute the cumulative carryover for a single category up to (but not
 * including) the target month.  Uses the chronological chain of prior months.
 */
export function computeCarryover(
  data: BudgetData,
  categoryId: number,
  upToMonth: string
): number {
  const months = getMonthsWithData(data);
  const priorMonths = months.filter((m) => m < upToMonth);
  const category = data.categories.find((c) => c.id === categoryId);
  if (!category) return 0;

  const ccGroupIds = new Set(
    data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );
  const ccPayCatToAccount = new Map<number, number>();
  for (const c of data.categories) {
    if (ccGroupIds.has(c.groupId) && c.linkedAccountId != null) {
      ccPayCatToAccount.set(c.id, c.linkedAccountId);
    }
  }

  let balance = num(category.carryover); // seed from manual starting balance

  for (const m of priorMonths) {
    const assigned = data.assignments
      .filter((a) => a.month === m && a.categoryId === categoryId)
      .reduce((s, a) => s + num(a.amount), 0);
    const rawFlow = data.transactions
      .filter((t) => t.date.startsWith(m) && t.categoryId === categoryId)
      .reduce((s, t) => s + num(t.amount), 0);
    const ccBuffer = ccPayCatToAccount.has(categoryId)
      ? computeCCBufferForMonth(data, m, categoryId, ccPayCatToAccount.get(categoryId)!)
      : 0;
    balance = balance + assigned + rawFlow + ccBuffer;
  }

  return balance;
}

// ---------------------------------------------------------------------------
// Helpers (internal)
// ---------------------------------------------------------------------------

/**
 * Build a Map<categoryId, carryoverIn> for the target month by walking all
 * prior months in chronological order.
 */
function buildCarryoverMap(
  data: BudgetData,
  orderedMonths: string[],
  targetMonth: string
): Map<number, number> {
  // Seed: every category starts with its manual carryover value.
  const balance = new Map<number, number>(
    data.categories.map((c) => [c.id, num(c.carryover)])
  );

  const priorMonths = orderedMonths.filter((m) => m < targetMonth);

  const ccGroupIds = new Set(
    data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );
  const ccPayCatToAccount = new Map<number, number>();
  for (const c of data.categories) {
    if (ccGroupIds.has(c.groupId) && c.linkedAccountId != null) {
      ccPayCatToAccount.set(c.id, c.linkedAccountId);
    }
  }

  // Build fast lookup structures for performance.
  // assignedByMonth: month → Map<catId, amount>
  const assignedByMonth = new Map<string, Map<number, number>>();
  for (const a of data.assignments) {
    let m = assignedByMonth.get(a.month);
    if (!m) {
      m = new Map();
      assignedByMonth.set(a.month, m);
    }
    m.set(a.categoryId, (m.get(a.categoryId) ?? 0) + num(a.amount));
  }

  // outflowByMonth: month → Map<catId, rawSum>
  const outflowByMonth = new Map<string, Map<number, number>>();
  for (const t of data.transactions) {
    if (t.categoryId == null) continue;
    const mk = t.date.slice(0, 7);
    let m = outflowByMonth.get(mk);
    if (!m) {
      m = new Map();
      outflowByMonth.set(mk, m);
    }
    m.set(t.categoryId, (m.get(t.categoryId) ?? 0) + num(t.amount));
  }

  // spendByAccountMonth: month → Map<accountId, total negative categorised spend>
  const spendByAccountMonth = buildSpendByAccountMonth(data);

  for (const month of priorMonths) {
    const aMap = assignedByMonth.get(month) ?? new Map<number, number>();
    const oMap = outflowByMonth.get(month) ?? new Map<number, number>();
    const spendByAcc = spendByAccountMonth.get(month) ?? new Map<number, number>();

    for (const c of data.categories) {
      const prev = balance.get(c.id) ?? 0;
      const assigned = aMap.get(c.id) ?? 0;
      const rawFlow = oMap.get(c.id) ?? 0;

      // CC buffer: if this is a CC payment category, credit the spending on the linked account
      let ccBuffer = 0;
      const linkedAcc = ccPayCatToAccount.get(c.id);
      if (linkedAcc != null) {
        ccBuffer = spendByAcc.get(linkedAcc) ?? 0;
      }

      balance.set(c.id, prev + assigned + rawFlow + ccBuffer);
    }
  }

  return balance;
}

/** Sum all outflow transactions for each category in the target month. */
function buildOutflowMap(data: BudgetData, month: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const t of data.transactions) {
    if (t.categoryId == null) continue;
    if (!t.date.startsWith(month)) continue;
    map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + num(t.amount));
  }
  return map;
}

/**
 * Build the CC buffer map for a single target month.
 * For each CC payment category, sum the categorised negative transactions
 * that posted to the linked credit account.
 */
function buildCCBufferMap(
  data: BudgetData,
  month: string,
  ccPayCatToAccount: Map<number, number>
): Map<number, number> {
  if (ccPayCatToAccount.size === 0) return new Map();

  // Sum negative categorised spend per account in this month.
  const spendByAccount = new Map<number, number>();
  for (const t of data.transactions) {
    if (!t.date.startsWith(month)) continue;
    if (t.categoryId == null) continue;
    const amt = num(t.amount);
    if (amt >= 0) continue; // only negative (spending) transactions
    spendByAccount.set(t.accountId, (spendByAccount.get(t.accountId) ?? 0) + (-amt));
  }

  const result = new Map<number, number>();
  for (const [catId, accountId] of ccPayCatToAccount) {
    const buffer = spendByAccount.get(accountId) ?? 0;
    if (buffer > 0) result.set(catId, buffer);
  }
  return result;
}

/** Helper to compute CC buffer for a single category+month (used by computeCarryover). */
function computeCCBufferForMonth(
  data: BudgetData,
  month: string,
  _categoryId: number,
  linkedAccountId: number
): number {
  return data.transactions
    .filter(
      (t) =>
        t.date.startsWith(month) &&
        t.accountId === linkedAccountId &&
        t.categoryId != null &&
        num(t.amount) < 0
    )
    .reduce((s, t) => s + -num(t.amount), 0);
}

/**
 * Build month → Map<accountId, totalNegativeCategorisedSpend>.
 * Used for the carryover chain to apply CC buffers across prior months.
 */
function buildSpendByAccountMonth(
  data: BudgetData
): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();
  for (const t of data.transactions) {
    if (t.categoryId == null) continue;
    const amt = num(t.amount);
    if (amt >= 0) continue;
    const mk = t.date.slice(0, 7);
    let m = result.get(mk);
    if (!m) { m = new Map(); result.set(mk, m); }
    m.set(t.accountId, (m.get(t.accountId) ?? 0) + (-amt));
  }
  return result;
}

/**
 * Sum all uncategorised positive transactions in the month — these are income.
 * In YNAB4, income transactions are entered against no category (or an
 * "Inflow: To Be Budgeted" category which is represented as null here).
 */
function computeMonthIncome(data: BudgetData, month: string): number {
  return data.transactions
    .filter(
      (t) => t.date.startsWith(month) && t.categoryId == null && num(t.amount) > 0
    )
    .reduce((s, t) => s + num(t.amount), 0);
}

/**
 * Compute the cumulative TBB surplus from all prior months.
 * In YNAB4, a positive TBB from a previous month carries forward (it's money
 * you earned but didn't assign yet). A negative TBB (over-budgeted) stays in
 * that month — it does not reduce a future month's pool.
 */
function computePriorTBBSurplus(
  data: BudgetData,
  orderedMonths: string[],
  targetMonth: string,
  ccGroupIds: Set<number>
): number {
  const priorMonths = orderedMonths.filter((m) => m < targetMonth);
  if (priorMonths.length === 0) return 0;

  const ccCatIds = new Set(
    data.categories.filter((c) => ccGroupIds.has(c.groupId)).map((c) => c.id)
  );

  // Group assignments by month for fast lookup.
  const assignedByMonth = new Map<string, number>();
  for (const a of data.assignments) {
    if (ccCatIds.has(a.categoryId)) continue; // exclude CC assignments from TBB
    assignedByMonth.set(a.month, (assignedByMonth.get(a.month) ?? 0) + num(a.amount));
  }

  let surplus = 0;
  for (const m of priorMonths) {
    const income = computeMonthIncome(data, m);
    const assigned = assignedByMonth.get(m) ?? 0;
    const tbb = income - assigned + surplus;
    // Only positive TBB carries forward; deficit stays in its own month.
    surplus = Math.max(0, tbb);
  }

  return surplus;
}

/** Compute funded percentage given a goal, assignment, and available balance. */
function computeFundedPct(
  goalTarget: string | null,
  assigned: number,
  available: number
): number {
  const goal = goalTarget ? num(goalTarget) : null;
  if (goal !== null && goal > 0) {
    // Funded relative to goal target.
    return Math.max(0, Math.min(1, available / goal));
  }
  if (assigned > 0) {
    return Math.max(0, Math.min(1, available / assigned));
  }
  return available > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Backward-compatible re-export (computeGroups keeps working)
// ---------------------------------------------------------------------------

/**
 * Legacy helper: compute groups for a month without TBB context.
 * Calls computeBudget internally so the math is identical.
 */
export function computeGroups(data: BudgetData, month: string): GroupRow[] {
  return computeBudget(data, month).groups;
}

/**
 * Summarize groups (exclude CC payments from assigned/outflow/available).
 */
export function summarize(groups: GroupRow[]) {
  const budgetGroups = groups.filter((g) => !g.group.isCreditCardPayments);
  const assigned = budgetGroups.reduce((s, g) => s + g.assigned, 0);
  const outflow = budgetGroups.reduce((s, g) => s + g.outflow, 0);
  const available = budgetGroups.reduce((s, g) => s + g.available, 0);
  const totalAvailable = groups.reduce((s, g) => s + g.available, 0);
  return { assigned, outflow, available, totalAvailable };
}
