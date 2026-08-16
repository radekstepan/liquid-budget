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
 *    tbb(month N) = income(N) - assigned(N) + surplusTBB(N-1)
 *    Where surplusTBB = max(0, tbb of prior month) — surpluses carry forward,
 *    deficits do not (over-budgeting in one month doesn't retroactively reduce
 *    a future month's income, it just shows as a negative TBB in that month).
 *    Income = sum of positive income transactions in the month.
 *    When tbb < 0 the user has "over-budgeted" (assigned more than earned).
 *
 * 3. CREDIT CARD BUFFER (YNAB4's signature feature)
 *    When you charge spending to a credit card, YNAB4 automatically transfers
 *    the spent amount from the budget category into the linked CC Payment
 *    category. This means the CC Payment category accumulates a "buffer"
 *    equal to how much you've charged — so you always have the money set aside
 *    to pay the bill. When you pay the card (transfer to the card), the buffer
 *    draws down accordingly.
 *
 * 4. OUTFLOW DISPLAY COLUMN
 *    The display outflow for a category is clamped to min(0, rawFlow) —
 *    refunds/credits in a category don't show as positive outflow.
 */

import type { Account, BudgetData, BudgetResult, CatRow, GroupRow, Transaction } from "./types.js";
import { num } from "./format.js";

// ---------------------------------------------------------------------------
// Income classification helper
// ---------------------------------------------------------------------------

export function isIncomeTransaction(
  t: Transaction,
  accountMap?: Map<number, Account> | Account[]
): boolean {
  if (t.isIncome !== undefined) {
    return t.isIncome === true;
  }
  if (t.categoryId != null) return false;
  if (t.transferAccountId != null) return false;
  if (t.parentId != null) return false;
  if (num(t.amount) <= 0) return false;
  if (accountMap) {
    const acc =
      accountMap instanceof Map
        ? accountMap.get(t.accountId)
        : accountMap.find((a) => a.id === t.accountId);
    if (acc && !acc.onBudget) return false;
  }
  return true;
}

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
  // Build split parent ID set so parent rows are skipped in all aggregations
  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const accountMap = new Map<number, Account>(data.accounts.map((a) => [a.id, a]));

  // 1. Determine the ordered list of months we need to walk through.
  const months = getMonthsWithData(data);

  // CC Payment groups and categories: Map<categoryId, linkedAccountId>
  const ccGroupIds = new Set(
    data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );
  const ccPayCatToAccount = new Map<number, number>();
  for (const c of data.categories) {
    if (ccGroupIds.has(c.groupId) && c.linkedAccountId != null) {
      ccPayCatToAccount.set(c.id, c.linkedAccountId);
    }
  }

  // Build cumulative carryover per category up to (but not including) `month`.
  const carryoverMap = buildCarryoverMap(data, months, month, splitParentIds, ccPayCatToAccount);

  // 2. Compute the current month's raw outflow per category.
  const outflowMap = buildOutflowMap(data, month, splitParentIds);

  // 3. CC buffer for this month: charges increase buffer, refunds & payments decrease buffer.
  const ccBufferMap = buildCCBufferMap(data, month, splitParentIds, ccPayCatToAccount);

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
  const priorSurplus = computePriorTBBSurplus(data, months, month, splitParentIds, accountMap);
  const totalIncome = computeMonthIncome(data, month, splitParentIds, accountMap);
  const totalAssigned = groups.reduce((s, g) => s + g.assigned, 0);
  const tbb = totalIncome - totalAssigned + priorSurplus;

  return {
    groups,
    tbb,
    totalIncome,
    priorSurplus,
    overBudgeted: tbb < 0,
    totalAssigned,
  };
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
  targetMonth: string,
  splitParentIds: Set<number>,
  ccPayCatToAccount: Map<number, number>
): Map<number, number> {
  // Seed: every category starts with its manual carryover value.
  const balance = new Map<number, number>(
    data.categories.map((c) => [c.id, num(c.carryover)])
  );

  const priorMonths = orderedMonths.filter((m) => m < targetMonth);

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
    if (splitParentIds.has(t.id)) continue;
    if (t.categoryId == null) continue;
    const mk = t.date.slice(0, 7);
    let m = outflowByMonth.get(mk);
    if (!m) {
      m = new Map();
      outflowByMonth.set(mk, m);
    }
    m.set(t.categoryId, (m.get(t.categoryId) ?? 0) + num(t.amount));
  }

  // spendByAccountMonth: month → Map<accountId, net CC buffer>
  const spendByAccountMonth = buildSpendByAccountMonth(data, splitParentIds);

  for (const month of priorMonths) {
    const aMap = assignedByMonth.get(month) ?? new Map<number, number>();
    const oMap = outflowByMonth.get(month) ?? new Map<number, number>();
    const spendByAcc = spendByAccountMonth.get(month) ?? new Map<number, number>();

    for (const c of data.categories) {
      const prev = balance.get(c.id) ?? 0;
      const assigned = aMap.get(c.id) ?? 0;
      const rawFlow = oMap.get(c.id) ?? 0;

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
function buildOutflowMap(
  data: BudgetData,
  month: string,
  splitParentIds: Set<number>
): Map<number, number> {
  const map = new Map<number, number>();
  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    if (t.categoryId == null) continue;
    if (!t.date.startsWith(month)) continue;
    map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + num(t.amount));
  }
  return map;
}

/**
 * Build the CC buffer map for a single target month.
 * For each CC payment category:
 *   - Categorised spend on linked credit card adds -amt (positive charges increase buffer, refunds decrease buffer).
 *   - Transfers to the linked credit card subtract the payment amount from the buffer.
 */
function buildCCBufferMap(
  data: BudgetData,
  month: string,
  splitParentIds: Set<number>,
  ccPayCatToAccount: Map<number, number>
): Map<number, number> {
  if (ccPayCatToAccount.size === 0) return new Map();

  const spendByAccount = new Map<number, number>();
  const linkedAccountSet = new Set(ccPayCatToAccount.values());

  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    if (!t.date.startsWith(month)) continue;

    const amt = num(t.amount);

    // 1. Categorised charges/refunds on the credit card account itself
    if (t.categoryId != null && linkedAccountSet.has(t.accountId)) {
      // Spending (amt < 0) adds positive credit (-amt); refund (amt > 0) reduces buffer (-amt)
      spendByAccount.set(t.accountId, (spendByAccount.get(t.accountId) ?? 0) + (-amt));
    }

    // 2. Payments to the card
    // Transfer from another account to the card: destination is linkedAccount
    if (t.transferAccountId != null && linkedAccountSet.has(t.transferAccountId)) {
      // Outflow on source (amt < 0): payment of |amt| draws down CC buffer
      const paymentAmount = Math.abs(amt);
      spendByAccount.set(
        t.transferAccountId,
        (spendByAccount.get(t.transferAccountId) ?? 0) - paymentAmount
      );
    }
    // Inflow transfer entered on the card account: source is linkedAccount with amt > 0
    if (t.transferAccountId != null && linkedAccountSet.has(t.accountId) && amt > 0) {
      spendByAccount.set(t.accountId, (spendByAccount.get(t.accountId) ?? 0) - amt);
    }
  }

  const result = new Map<number, number>();
  for (const [catId, accountId] of ccPayCatToAccount) {
    const buffer = spendByAccount.get(accountId) ?? 0;
    if (buffer !== 0) result.set(catId, buffer);
  }
  return result;
}

/**
 * Build month → Map<accountId, net CC buffer>.
 * Used for the carryover chain to apply CC buffers across prior months.
 */
function buildSpendByAccountMonth(
  data: BudgetData,
  splitParentIds: Set<number>
): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();

  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    const mk = t.date.slice(0, 7);
    const amt = num(t.amount);

    let m = result.get(mk);
    if (!m) {
      m = new Map();
      result.set(mk, m);
    }

    // 1. Categorised spending/refunds on the card
    if (t.categoryId != null) {
      m.set(t.accountId, (m.get(t.accountId) ?? 0) + (-amt));
    }

    // 2. Payments to the card
    if (t.transferAccountId != null) {
      // Outflow on source (amt < 0) to transferAccountId (card)
      const paymentAmount = Math.abs(amt);
      m.set(t.transferAccountId, (m.get(t.transferAccountId) ?? 0) - paymentAmount);
      // Inflow transfer on the card account itself
      if (amt > 0) {
        m.set(t.accountId, (m.get(t.accountId) ?? 0) - amt);
      }
    }
  }

  return result;
}

/**
 * Sum all positive income transactions in the month.
 */
function computeMonthIncome(
  data: BudgetData,
  month: string,
  splitParentIds: Set<number>,
  accountMap: Map<number, Account>
): number {
  return data.transactions
    .filter((t) => {
      if (!t.date.startsWith(month)) return false;
      if (splitParentIds.has(t.id)) return false;
      return isIncomeTransaction(t, accountMap);
    })
    .reduce((s, t) => s + num(t.amount), 0);
}

/**
 * Compute the cumulative TBB surplus from all prior months.
 * In YNAB4, a positive TBB from a previous month carries forward.
 * A negative TBB (over-budgeted) stays in that month.
 */
function computePriorTBBSurplus(
  data: BudgetData,
  orderedMonths: string[],
  targetMonth: string,
  splitParentIds: Set<number>,
  accountMap: Map<number, Account>
): number {
  const priorMonths = orderedMonths.filter((m) => m < targetMonth);
  if (priorMonths.length === 0) return 0;

  // Group assignments by month for fast lookup.
  const assignedByMonth = new Map<string, number>();
  for (const a of data.assignments) {
    assignedByMonth.set(a.month, (assignedByMonth.get(a.month) ?? 0) + num(a.amount));
  }

  let surplus = 0;
  for (const m of priorMonths) {
    const income = computeMonthIncome(data, m, splitParentIds, accountMap);
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
    return Math.max(0, Math.min(1, available / goal));
  }
  if (assigned > 0) {
    return Math.max(0, Math.min(1, available / assigned));
  }
  return available > 0 ? 1 : 0;
}
