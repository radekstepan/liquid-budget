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
 *    tbb(month N) = income(N) - assigned(N) + surplusTBB(N-1) - overspent(N-1)
 *    Where assigned(N) sums all category assignments across all groups (including
 *    explicit debt paydown assignments in CC Payment categories).
 *    surplusTBB carries forward prior rolling balances.
 *    Income = sum of positive income transactions in the month (including deferred income).
 *    When tbb < 0 the user has "over-budgeted" (assigned more than earned).
 *
 *    Cash overspending: negative available in non-CC categories is clamped to
 *    zero during carryover, and the overspent amount is deducted from the next
 *    month's TBB (matching YNAB4 Rule 3: "Roll with the Punches").
 *
 * 3. CREDIT CARD BUFFER (YNAB4's signature feature)
 *    When you charge spending to a credit card, YNAB4 automatically transfers
 *    the spent amount from the budget category into the linked CC Payment
 *    category. This means the CC Payment category accumulates a "buffer"
 *    equal to how much you've charged — so you always have the money set aside
 *    to pay the bill. When you pay the card (transfer to the card), the buffer
 *    draws down accordingly.
 *
 *    Credit card overspending (negative available in CC payment categories)
 *    persists as debt and is NOT deducted from next month's TBB.
 *
 * 4. OUTFLOW DISPLAY COLUMN
 *    The display outflow for a category is clamped to min(0, rawFlow) —
 *    refunds/credits in a category don't show as positive outflow.
 */

import type {
  Account,
  BudgetData,
  BudgetResult,
  CatRow,
  GroupRow,
  SerializedBudgetIndex,
  Transaction,
} from "./types.js";
import { num } from "./format.js";

// ---------------------------------------------------------------------------
// Income classification helper
// ---------------------------------------------------------------------------

export function isIncomeTransaction(
  t: Transaction,
  accountMap?: Map<number, Account> | Account[]
): boolean {
  if (t.categoryId != null) return false;

  if (accountMap) {
    const accA =
      accountMap instanceof Map
        ? accountMap.get(t.accountId)
        : accountMap.find((a) => a.id === t.accountId);
    const onA = accA ? accA.onBudget : true;

    if (t.transferAccountId != null) {
      const accB =
        accountMap instanceof Map
          ? accountMap.get(t.transferAccountId)
          : accountMap.find((a) => a.id === t.transferAccountId);
      const onB = accB ? accB.onBudget : true;

      // Internal transfer between same budget boundary: never income
      if (onA === onB) return false;

      // Net change to on-budget balances from this transfer:
      const netOnBudgetDelta = (onA ? num(t.amount) : 0) + (onB ? -num(t.amount) : 0);
      if (netOnBudgetDelta <= 0) return false;

      // Inbound boundary transfer with categoryId == null is always income to TBB
      return true;
    }

    // Regular transaction
    if (!onA) return false;
    if (num(t.amount) <= 0) return false;
    if (t.isIncome !== undefined) {
      return t.isIncome === true;
    }
    if (t.parentId != null) return false;
    return true;
  }

  // Fallback when accountMap is not provided
  if (t.transferAccountId != null) {
    if (t.isIncome !== undefined) {
      return t.isIncome === true;
    }
    return false;
  }
  if (num(t.amount) <= 0) return false;
  if (t.isIncome !== undefined) {
    return t.isIncome === true;
  }
  if (t.parentId != null) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Indexing & Memoization Cache for High Performance
// ---------------------------------------------------------------------------

type IndexedBudgetData = {
  assignedByMonth: Map<string, Map<number, number>>;
  assignedTotalByMonth: Map<string, number>;
  outflowByMonth: Map<string, Map<number, number>>;
  spendByAccountMonth: Map<string, Map<number, number>>;
  incomeByMonth: Map<string, number>;
  carryoverByMonth: Map<string, Map<number, number>>;
  overspentByMonth: Map<string, number>;
  surplusByMonth: Map<string, number>;
};

const budgetDataIndexCache = new WeakMap<BudgetData, IndexedBudgetData>();

function hydrateBudgetIndex(idx: SerializedBudgetIndex): IndexedBudgetData {
  const assignedByMonth = new Map<string, Map<number, number>>();
  for (const [m, catMap] of Object.entries(idx.assignedByMonth)) {
    const inner = new Map<number, number>();
    for (const [catId, val] of Object.entries(catMap)) {
      inner.set(Number(catId), val);
    }
    assignedByMonth.set(m, inner);
  }
  const assignedTotalByMonth = new Map<string, number>(
    Object.entries(idx.assignedTotalByMonth).map(([k, v]) => [k, Number(v)])
  );
  const outflowByMonth = new Map<string, Map<number, number>>();
  for (const [m, catMap] of Object.entries(idx.outflowByMonth)) {
    const inner = new Map<number, number>();
    for (const [catId, val] of Object.entries(catMap)) {
      inner.set(Number(catId), val);
    }
    outflowByMonth.set(m, inner);
  }
  const spendByAccountMonth = new Map<string, Map<number, number>>();
  for (const [m, accMap] of Object.entries(idx.spendByAccountMonth)) {
    const inner = new Map<number, number>();
    for (const [accId, val] of Object.entries(accMap)) {
      inner.set(Number(accId), val);
    }
    spendByAccountMonth.set(m, inner);
  }
  const incomeByMonth = new Map<string, number>(
    Object.entries(idx.incomeByMonth).map(([k, v]) => [k, Number(v)])
  );
  const carryoverByMonth = new Map<string, Map<number, number>>();
  for (const [m, catMap] of Object.entries(idx.carryoverByMonth)) {
    const inner = new Map<number, number>();
    for (const [catId, val] of Object.entries(catMap)) {
      inner.set(Number(catId), val);
    }
    carryoverByMonth.set(m, inner);
  }
  const overspentByMonth = new Map<string, number>(
    Object.entries(idx.overspentByMonth).map(([k, v]) => [k, Number(v)])
  );
  const surplusByMonth = new Map<string, number>(
    Object.entries(idx.surplusByMonth).map(([k, v]) => [k, Number(v)])
  );

  return {
    assignedByMonth,
    assignedTotalByMonth,
    outflowByMonth,
    spendByAccountMonth,
    incomeByMonth,
    carryoverByMonth,
    overspentByMonth,
    surplusByMonth,
  };
}

function buildRawIndex(
  data: BudgetData,
  splitParentIds: Set<number>,
  accountMap: Map<number, Account>
): IndexedBudgetData {
  const assignedByMonth = new Map<string, Map<number, number>>();
  const assignedTotalByMonth = new Map<string, number>();

  for (const a of data.assignments) {
    const amt = num(a.amount);
    let m = assignedByMonth.get(a.month);
    if (!m) {
      m = new Map();
      assignedByMonth.set(a.month, m);
    }
    m.set(a.categoryId, Math.round((m.get(a.categoryId) ?? 0) + amt));
    assignedTotalByMonth.set(
      a.month,
      Math.round((assignedTotalByMonth.get(a.month) ?? 0) + amt)
    );
  }

  const outflowByMonth = new Map<string, Map<number, number>>();
  const spendByAccountMonth = new Map<string, Map<number, number>>();
  const incomeByMonth = new Map<string, number>();

  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    const mk = t.date.slice(0, 7);
    const amt = num(t.amount);
    const accA = accountMap.get(t.accountId);
    const onA = accA ? accA.onBudget : true;

    let netOnBudgetDelta: number;
    let isInternalTransfer = false;
    if (t.transferAccountId != null) {
      const accB = accountMap.get(t.transferAccountId);
      const onB = accB ? accB.onBudget : true;
      netOnBudgetDelta = (onA ? amt : 0) + (onB ? -amt : 0);
      isInternalTransfer = onA && onB;
    } else {
      netOnBudgetDelta = onA ? amt : 0;
    }

    if (t.categoryId != null && !isInternalTransfer && netOnBudgetDelta !== 0) {
      let m = outflowByMonth.get(mk);
      if (!m) {
        m = new Map();
        outflowByMonth.set(mk, m);
      }
      m.set(t.categoryId, Math.round((m.get(t.categoryId) ?? 0) + netOnBudgetDelta));
    }

    if (isIncomeTransaction(t, accountMap)) {
      const incMonth = t.incomeMonth || mk;
      const incomeAmt = netOnBudgetDelta > 0 ? netOnBudgetDelta : amt;
      incomeByMonth.set(incMonth, Math.round((incomeByMonth.get(incMonth) ?? 0) + incomeAmt));
    }

    // 1. Categorised spending/refunds on credit card accounts
    if (t.categoryId != null && onA) {
      let s = spendByAccountMonth.get(mk);
      if (!s) {
        s = new Map();
        spendByAccountMonth.set(mk, s);
      }
      s.set(t.accountId, Math.round((s.get(t.accountId) ?? 0) + -amt));
    }

    // 2. Payments to credit cards
    if (t.transferAccountId != null) {
      let s = spendByAccountMonth.get(mk);
      if (!s) {
        s = new Map();
        spendByAccountMonth.set(mk, s);
      }
      const receiving = amt < 0 ? t.transferAccountId : t.accountId;
      const paymentAmount = Math.abs(amt);
      s.set(
        receiving,
        Math.round((s.get(receiving) ?? 0) - paymentAmount)
      );
    }
  }

  return {
    assignedByMonth,
    assignedTotalByMonth,
    outflowByMonth,
    spendByAccountMonth,
    incomeByMonth,
    carryoverByMonth: new Map(),
    overspentByMonth: new Map(),
    surplusByMonth: new Map(),
  };
}

export function buildBudgetIndex(data: BudgetData): SerializedBudgetIndex {
  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }
  const accountMap = new Map<number, Account>(data.accounts.map((a) => [a.id, a]));

  const index = buildRawIndex(data, splitParentIds, accountMap);

  const months = getMonthsWithData(data);
  const ccGroupIds = new Set(
    data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );
  const ccPayCatToAccount = new Map<number, number>();
  for (const c of data.categories) {
    if (ccGroupIds.has(c.groupId) && c.linkedAccountId != null) {
      ccPayCatToAccount.set(c.id, c.linkedAccountId);
    }
  }

  for (const m of months) {
    buildCarryoverMap(data, index, months, m, ccPayCatToAccount, ccGroupIds);
    computePriorTBBSurplus(index, months, m);
  }

  const serializedAssigned: Record<string, Record<string | number, number>> = {};
  for (const [m, map] of index.assignedByMonth) {
    serializedAssigned[m] = Object.fromEntries(map);
  }
  const serializedOutflow: Record<string, Record<string | number, number>> = {};
  for (const [m, map] of index.outflowByMonth) {
    serializedOutflow[m] = Object.fromEntries(map);
  }
  const serializedSpend: Record<string, Record<string | number, number>> = {};
  for (const [m, map] of index.spendByAccountMonth) {
    serializedSpend[m] = Object.fromEntries(map);
  }
  const serializedCarryover: Record<string, Record<string | number, number>> = {};
  for (const [m, map] of index.carryoverByMonth) {
    serializedCarryover[m] = Object.fromEntries(map);
  }

  return {
    assignedByMonth: serializedAssigned,
    assignedTotalByMonth: Object.fromEntries(index.assignedTotalByMonth),
    outflowByMonth: serializedOutflow,
    spendByAccountMonth: serializedSpend,
    incomeByMonth: Object.fromEntries(index.incomeByMonth),
    carryoverByMonth: serializedCarryover,
    overspentByMonth: Object.fromEntries(index.overspentByMonth),
    surplusByMonth: Object.fromEntries(index.surplusByMonth),
  };
}

function getOrBuildIndex(
  data: BudgetData,
  splitParentIds: Set<number>,
  accountMap: Map<number, Account>
): IndexedBudgetData {
  let cached = budgetDataIndexCache.get(data);
  if (cached) return cached;

  if (data.budgetIndex) {
    cached = hydrateBudgetIndex(data.budgetIndex);
    budgetDataIndexCache.set(data, cached);
    return cached;
  }

  cached = buildRawIndex(data, splitParentIds, accountMap);
  budgetDataIndexCache.set(data, cached);
  return cached;
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
  const index = getOrBuildIndex(data, splitParentIds, accountMap);

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
  const { carryoverMap, overspentPrevious } = buildCarryoverMap(
    data,
    index,
    months,
    month,
    ccPayCatToAccount,
    ccGroupIds
  );

  // 2. Compute the current month's raw outflow per category.
  const outflowMap = index.outflowByMonth.get(month) ?? new Map<number, number>();

  // 3. CC buffer for this month.
  const ccBufferMap = buildCCBufferMap(index, month, ccPayCatToAccount);

  // 4. Assignments for the current month.
  const assignMap = index.assignedByMonth.get(month) ?? new Map<number, number>();

  // 5. Build CatRow for every category.
  const catsByGroup = new Map<number, CatRow[]>();
  for (const c of data.categories) {
    const carryoverIn = carryoverMap.get(c.id) ?? 0;
    const assigned = assignMap.get(c.id) ?? 0;
    const rawFlow = outflowMap.get(c.id) ?? 0;
    const outflow = Math.min(0, rawFlow);

    const ccBuffer = ccBufferMap.get(c.id) ?? 0;
    const available = Math.round(carryoverIn + assigned + rawFlow + ccBuffer);

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
      const assigned = Math.round(rows.reduce((s, r) => s + r.assigned, 0));
      const outflow = Math.round(rows.reduce((s, r) => s + r.outflow, 0));
      const available = Math.round(rows.reduce((s, r) => s + r.available, 0));
      return { group, rows, assigned, outflow, available };
    });

  // 7. Compute cumulative TBB.
  // Prior months' surplus TBB carries forward into this month's available pool.
  // Cash overspending from prior months is factored directly into priorSurplus.
  const priorSurplus = computePriorTBBSurplus(index, months, month);
  const totalIncome = index.incomeByMonth.get(month) ?? 0;
  const totalAssigned = Math.round(groups.reduce((s, g) => s + g.assigned, 0));
  const tbb = Math.round(totalIncome - totalAssigned + priorSurplus);

  return {
    groups,
    tbb,
    totalIncome,
    priorSurplus,
    overBudgeted: tbb < 0,
    totalAssigned,
    overspentPrevious,
  };
}

/**
 * Return an ascending-sorted unique list of all "YYYY-MM" keys that appear
 * in the dataset (from assignments or transactions).
 */
export function getMonthsWithData(data: BudgetData): string[] {
  const keys = new Set<string>();
  for (const a of data.assignments) keys.add(a.month);
  for (const t of data.transactions) {
    keys.add(t.date.slice(0, 7));
    if (t.incomeMonth) keys.add(t.incomeMonth);
  }
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// Helpers (internal)
// ---------------------------------------------------------------------------

function getPreviousCalendarMonth(month: string): string {
  const parts = month.split("-");
  const year = parseInt(parts[0] ?? "0", 10);
  const m = parseInt(parts[1] ?? "1", 10);
  if (m === 1) {
    return `${year - 1}-12`;
  }
  return `${year}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * Build a Map<categoryId, carryoverIn> for the target month by walking all
 * prior months in chronological order with memoization.
 *
 * Non-CC categories are clamped to zero — negative available from cash
 * overspending does not carry forward within the category. Instead, the
 * overspent amount is returned so it can be deducted from next month's TBB.
 *
 * CC payment categories are NOT clamped — credit overspending persists as
 * debt within the category.
 */
function buildCarryoverMap(
  data: BudgetData,
  index: IndexedBudgetData,
  orderedMonths: string[],
  targetMonth: string,
  ccPayCatToAccount: Map<number, number>,
  ccGroupIds: Set<number>
): { carryoverMap: Map<number, number>; overspentPrevious: number } {
  const prevCalendarMonth = getPreviousCalendarMonth(targetMonth);
  const cached = index.carryoverByMonth.get(targetMonth);
  if (cached) {
    const priorMonths = orderedMonths.filter((m) => m < targetMonth);
    const mostRecentPrior = priorMonths.length > 0 ? priorMonths[priorMonths.length - 1] : null;
    const overspentPrevious =
      mostRecentPrior === prevCalendarMonth
        ? (index.overspentByMonth.get(mostRecentPrior) ?? 0)
        : 0;
    return { carryoverMap: cached, overspentPrevious };
  }

  // Seed: every category starts with its manual carryover value.
  let currentBalance = new Map<number, number>(
    data.categories.map((c) => [c.id, num(c.carryover)])
  );

  const priorMonths = orderedMonths.filter((m) => m < targetMonth);
  const mostRecentPrior = priorMonths.length > 0 ? priorMonths[priorMonths.length - 1] : null;
  let overspentPrevious = 0;

  for (const month of priorMonths) {
    const monthCached = index.carryoverByMonth.get(month);
    if (monthCached) {
      currentBalance = new Map(monthCached);
    }

    const aMap = index.assignedByMonth.get(month) ?? new Map<number, number>();
    const oMap = index.outflowByMonth.get(month) ?? new Map<number, number>();
    const spendByAcc = index.spendByAccountMonth.get(month) ?? new Map<number, number>();

    let monthOverspent = 0;
    const nextBalance = new Map<number, number>();
    for (const c of data.categories) {
      const prev = currentBalance.get(c.id) ?? 0;
      const assigned = aMap.get(c.id) ?? 0;
      const rawFlow = oMap.get(c.id) ?? 0;

      let ccBuffer = 0;
      const linkedAcc = ccPayCatToAccount.get(c.id);
      if (linkedAcc != null) {
        ccBuffer = spendByAcc.get(linkedAcc) ?? 0;
      }

      const next = Math.round(prev + assigned + rawFlow + ccBuffer);

      // Clamp non-CC categories to 0 — cash overspending is deducted from
      // next month's TBB, not carried within the category, UNLESS "Red Arrow to the Right"
      // (overspendCarriesOver === true) is enabled on the category.
      // CC payment categories are NOT clamped — credit overspending persists as debt.
      const carriesOver = Boolean(c.overspendCarriesOver);
      if (!ccGroupIds.has(c.groupId)) {
        if (next < 0) {
          if (carriesOver) {
            // Negative balance rolls over to next month's starting available balance
            // and is NOT deducted from next month's TBB.
            nextBalance.set(c.id, next);
          } else {
            monthOverspent += -next;
            nextBalance.set(c.id, 0);
          }
        } else {
          nextBalance.set(c.id, next);
        }
      } else {
        nextBalance.set(c.id, next);
      }
    }

    index.overspentByMonth.set(month, monthOverspent);

    if (month === mostRecentPrior && month === prevCalendarMonth) {
      overspentPrevious = monthOverspent;
    }

    currentBalance = nextBalance;
  }

  index.carryoverByMonth.set(targetMonth, currentBalance);
  return { carryoverMap: currentBalance, overspentPrevious };
}

/**
 * Compute the overspent amount for a specific month by utilizing the memoized
 * carryover map, then calculating which non-CC categories went negative.
 */
function computeOverspentForMonth(
  data: BudgetData,
  index: IndexedBudgetData,
  targetMonth: string,
  ccPayCatToAccount: Map<number, number>,
  ccGroupIds: Set<number>,
  orderedMonths: string[]
): number {
  const cached = index.overspentByMonth.get(targetMonth);
  if (cached !== undefined) return cached;

  const { carryoverMap } = buildCarryoverMap(
    data,
    index,
    orderedMonths,
    targetMonth,
    ccPayCatToAccount,
    ccGroupIds
  );

  const aMap = index.assignedByMonth.get(targetMonth) ?? new Map<number, number>();
  const oMap = index.outflowByMonth.get(targetMonth) ?? new Map<number, number>();
  const spendByAcc = index.spendByAccountMonth.get(targetMonth) ?? new Map<number, number>();

  let overspent = 0;
  for (const c of data.categories) {
    if (ccGroupIds.has(c.groupId)) continue;
    if (c.overspendCarriesOver) continue; // Red Arrow: balance rolls over, does not deduct from TBB

    const prev = carryoverMap.get(c.id) ?? 0;
    const assigned = aMap.get(c.id) ?? 0;
    const rawFlow = oMap.get(c.id) ?? 0;

    let ccBuffer = 0;
    const linkedAcc = ccPayCatToAccount.get(c.id);
    if (linkedAcc != null) {
      ccBuffer = spendByAcc.get(linkedAcc) ?? 0;
    }

    const available = Math.round(prev + assigned + rawFlow + ccBuffer);
    if (available < 0) {
      overspent += -available;
    }
  }

  index.overspentByMonth.set(targetMonth, overspent);
  return overspent;
}

/**
 * Build the CC buffer map for a single target month from pre-indexed spend.
 */
function buildCCBufferMap(
  index: IndexedBudgetData,
  month: string,
  ccPayCatToAccount: Map<number, number>
): Map<number, number> {
  if (ccPayCatToAccount.size === 0) return new Map();

  const spendByAccount = index.spendByAccountMonth.get(month) ?? new Map<number, number>();
  const result = new Map<number, number>();

  for (const [catId, accountId] of ccPayCatToAccount) {
    const buffer = spendByAccount.get(accountId) ?? 0;
    if (buffer !== 0) result.set(catId, buffer);
  }
  return result;
}

/**
 * Compute the cumulative TBB surplus from all prior months with memoization.
 */
function computePriorTBBSurplus(
  index: IndexedBudgetData,
  orderedMonths: string[],
  targetMonth: string
): number {
  const cached = index.surplusByMonth.get(targetMonth);
  if (cached !== undefined) return cached;

  const priorMonths = orderedMonths.filter((m) => m < targetMonth);
  if (priorMonths.length === 0) {
    index.surplusByMonth.set(targetMonth, 0);
    return 0;
  }

  let surplus = 0;
  for (const m of priorMonths) {
    const income = index.incomeByMonth.get(m) ?? 0;
    const assigned = index.assignedTotalByMonth.get(m) ?? 0;
    const overspent = index.overspentByMonth.get(m) ?? 0;
    const tbb = Math.round(income - assigned + surplus - overspent);
    // Cumulative surplus carries forward (or deficit if overspent/over-assigned)
    surplus = tbb;
  }

  index.surplusByMonth.set(targetMonth, surplus);
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
