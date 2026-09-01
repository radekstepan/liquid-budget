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
 * 3. CREDIT CARD BUFFER & OVERSPENDING (YNAB4's signature feature)
 *    When you charge spending to a credit card, YNAB4 automatically transfers
 *    the funded portion of the spent amount from the budget category into the
 *    linked CC Payment category. This means the CC Payment category accumulates
 *    a "buffer" backed by cash set aside to pay the bill. When you pay the card
 *    (transfer to the card), the buffer draws down accordingly.
 *
 *    Unfunded credit card spending adds to the credit card debt on the card,
 *    does not move phantom cash to the CC payment category, and is NOT
 *    deducted from next month's cash TBB.
 *
 *    Cash overspending (from checking/liquid accounts) is deducted from next
 *    month's TBB (unless Red Arrow is enabled).
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
import { classifyBoundaryTransfer } from "./transfers.js";

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

      const classification = classifyBoundaryTransfer({
        srcOnBudget: onA,
        destOnBudget: onB,
        amount: num(t.amount),
        categoryId: t.categoryId,
        incomeMonth: t.incomeMonth,
        allowMissingOutflowCategory: true,
      });
      return classification.isIncome;
    }

    // Regular transaction
    if (!onA) return false;
    if (num(t.amount) <= 0) return false;
    if (t.isIncome !== undefined) {
      return t.isIncome === true;
    }
    if (accA && accA.kind === "credit") return false;
    // Uncategorized positive rows are income, including split children that
    // omit `isIncome` (matches createSplitWithChildren semantics:
    // categoryId == null && amount > 0). An explicit `isIncome` value above
    // always wins.
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
  return true;
}

// ---------------------------------------------------------------------------
// Indexing & Memoization Cache for High Performance
// ---------------------------------------------------------------------------

type CategoryTxEntry = {
  id: number;
  accountId: number;
  date: string;
  amount: number;
  isCC: boolean;
};

type RawIndexData = {
  assignedByMonth: Map<string, Map<number, number>>;
  assignedTotalByMonth: Map<string, number>;
  outflowByMonth: Map<string, Map<number, number>>;
  incomeByMonth: Map<string, number>;
  incomeFromFutureByMonth: Map<string, number>;
  incomeFromPastByMonth: Map<string, number>;
  incomeDeferredToFutureByMonth: Map<string, number>;
  incomeDeferredToPastByMonth: Map<string, number>;
  cardPaymentsByAccountMonth: Map<string, Map<number, number>>;
  categoryTransactionsByMonth: Map<string, Map<number, CategoryTxEntry[]>>;
};

type IndexedBudgetData = {
  assignedByMonth: Map<string, Map<number, number>>;
  assignedTotalByMonth: Map<string, number>;
  outflowByMonth: Map<string, Map<number, number>>;
  spendByAccountMonth: Map<string, Map<number, number>>;
  incomeByMonth: Map<string, number>;
  incomeFromFutureByMonth?: Map<string, number>;
  incomeFromPastByMonth?: Map<string, number>;
  incomeDeferredToFutureByMonth?: Map<string, number>;
  incomeDeferredToPastByMonth?: Map<string, number>;
  carryoverByMonth: Map<string, Map<number, number>>;
  endingBalanceByMonth: Map<string, Map<number, number>>;
  overspentByMonth: Map<string, number>;
  surplusByMonth: Map<string, number>;
  unfundedPaydownByMonth?: Map<string, Map<number, number>>;
};

export const BUDGET_INDEX_VERSION = 1;

let globalCacheEpoch = 1;
let budgetDataIndexCache = new WeakMap<BudgetData, IndexedBudgetData>();
let normalizedDataCache = new WeakMap<BudgetData, BudgetData>();
const serializedIndexEpochs = new WeakMap<SerializedBudgetIndex, number>();

/**
 * Ensures that every on-budget credit card account maps to a valid payment category
 * within a Credit Card Payments group, preventing funded CC spending from disappearing.
 */
export function normalizeBudgetData(data: BudgetData): BudgetData {
  if (!data || !data.accounts || !data.groups || !data.categories) {
    return data;
  }

  const cached = normalizedDataCache.get(data);
  if (cached) return cached;

  const ccAccounts = data.accounts.filter(
    (a) => a.kind === "credit" && a.onBudget !== false
  );

  const ccGroupIds = new Set(
    data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );

  // Invariant: at most one category linked per credit account, and it must belong
  // to a Credit Card Payments group.
  const validLinkedAccountIds = new Set<number>();
  let hasDuplicateLinks = false;
  let hasInvalidLinks = false;
  for (const c of data.categories) {
    if (c.linkedAccountId != null) {
      if (!ccGroupIds.has(c.groupId)) {
        hasInvalidLinks = true;
      } else if (validLinkedAccountIds.has(c.linkedAccountId)) {
        hasDuplicateLinks = true;
      } else {
        validLinkedAccountIds.add(c.linkedAccountId);
      }
    }
  }

  const missingAccounts = ccAccounts.filter((a) => !validLinkedAccountIds.has(a.id));

  if (missingAccounts.length === 0 && !hasDuplicateLinks && !hasInvalidLinks) {
    normalizedDataCache.set(data, data);
    return data;
  }

  const groups = [...data.groups];
  let ccGroup = groups.find((g) => g.isCreditCardPayments);
  if (!ccGroup) {
    let nextSynthGroupId = -1;
    for (const g of groups) {
      if (g.id <= nextSynthGroupId) {
        nextSynthGroupId = g.id - 1;
      }
    }
    const maxGroupSort = groups.reduce((max, g) => Math.max(max, g.sort), -1);
    ccGroup = {
      id: nextSynthGroupId,
      name: "Credit Card Payments",
      sort: maxGroupSort + 1,
      isCreditCardPayments: true,
    };
    groups.push(ccGroup);
  }

  // Deduplicate linked categories so only the first category within a CC Payments group
  // keeps the link; clear links on categories outside CC Payments groups.
  const seenLinks = new Set<number>();
  const categories = data.categories.map((c) => {
    if (c.linkedAccountId != null) {
      if (!ccGroupIds.has(c.groupId) || seenLinks.has(c.linkedAccountId)) {
        return { ...c, linkedAccountId: null };
      }
      seenLinks.add(c.linkedAccountId);
    }
    return c;
  });

  let nextSynthCatId = -1;
  for (const c of categories) {
    if (c.id <= nextSynthCatId) {
      nextSynthCatId = c.id - 1;
    }
  }
  let maxCatSort = categories
    .filter((c) => c.groupId === ccGroup!.id)
    .reduce((max, c) => Math.max(max, c.sort), -1);

  for (const acc of missingAccounts) {
    maxCatSort++;
    categories.push({
      id: nextSynthCatId--,
      groupId: ccGroup.id,
      name: acc.name,
      sort: maxCatSort,
      carryover: "0",
      goalTarget: null,
      linkedAccountId: acc.id,
      overspendCarriesOver: false,
    });
  }

  const normalized: BudgetData = {
    ...data,
    groups,
    categories,
  };

  normalizedDataCache.set(data, normalized);
  normalizedDataCache.set(normalized, normalized);
  return normalized;
}

/**
 * Invalidate the cached budget index for a BudgetData object (or all cached data if no object is provided).
 * Also clears the optional hydrated `data.budgetIndex` reference if data is provided, or advances the global
 * cache epoch so any attached serialized indexes from previous epochs are rejected.
 */
export function invalidateBudgetIndex(data?: BudgetData): void {
  if (data) {
    budgetDataIndexCache.delete(data);
    data.budgetIndex = undefined;
    const normalized = normalizedDataCache.get(data);
    if (normalized && normalized !== data) {
      budgetDataIndexCache.delete(normalized);
      normalized.budgetIndex = undefined;
    }
    normalizedDataCache.delete(data);
  } else {
    budgetDataIndexCache = new WeakMap<BudgetData, IndexedBudgetData>();
    normalizedDataCache = new WeakMap<BudgetData, BudgetData>();
    globalCacheEpoch++;
  }
}

function getCCAccountIds(data: BudgetData): Set<number> {
  const ccAccountIds = new Set<number>();
  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));
  for (const a of data.accounts) {
    if (a.kind === "credit" && a.onBudget !== false) {
      ccAccountIds.add(a.id);
    }
  }
  const ccGroupIds = new Set(
    data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );
  const seenLinked = new Set<number>();
  for (const c of data.categories) {
    if (ccGroupIds.has(c.groupId) && c.linkedAccountId != null) {
      if (seenLinked.has(c.linkedAccountId)) continue;
      seenLinked.add(c.linkedAccountId);
      const acc = accountMap.get(c.linkedAccountId);
      if (!acc || (acc.kind === "credit" && acc.onBudget !== false)) {
        ccAccountIds.add(c.linkedAccountId);
      }
    }
  }
  return ccAccountIds;
}

function hydrateBudgetIndex(idx: SerializedBudgetIndex, data?: BudgetData): IndexedBudgetData {
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
  const incomeFromFutureByMonth = new Map<string, number>(
    Object.entries(idx.incomeFromFutureByMonth ?? {}).map(([k, v]) => [k, Number(v)])
  );
  const incomeFromPastByMonth = new Map<string, number>(
    Object.entries(idx.incomeFromPastByMonth ?? {}).map(([k, v]) => [k, Number(v)])
  );
  const incomeDeferredToFutureByMonth = new Map<string, number>(
    Object.entries(idx.incomeDeferredToFutureByMonth ?? {}).map(([k, v]) => [k, Number(v)])
  );
  const incomeDeferredToPastByMonth = new Map<string, number>(
    Object.entries(idx.incomeDeferredToPastByMonth ?? {}).map(([k, v]) => [k, Number(v)])
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

  const unfundedPaydownByMonth = new Map<string, Map<number, number>>();
  if (idx.unfundedPaydownByMonth) {
    for (const [m, catMap] of Object.entries(idx.unfundedPaydownByMonth)) {
      const inner = new Map<number, number>();
      for (const [catId, val] of Object.entries(catMap)) {
        inner.set(Number(catId), val);
      }
      unfundedPaydownByMonth.set(m, inner);
    }
  }

  const endingBalanceByMonth = new Map<string, Map<number, number>>();
  if (idx.endingBalanceByMonth) {
    for (const [m, catMap] of Object.entries(idx.endingBalanceByMonth)) {
      const inner = new Map<number, number>();
      for (const [catId, val] of Object.entries(catMap)) {
        inner.set(Number(catId), val);
      }
      endingBalanceByMonth.set(m, inner);
    }
  } else if (data) {
    const normData = normalizeBudgetData(data);
    const ccGroupIds = new Set(
      normData.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
    );
    const seenLinkedAccounts = new Set<number>();
    const ccPayCatToAccount = new Map<number, number>();
    for (const c of normData.categories) {
      if (
        ccGroupIds.has(c.groupId) &&
        c.linkedAccountId != null &&
        !seenLinkedAccounts.has(c.linkedAccountId)
      ) {
        seenLinkedAccounts.add(c.linkedAccountId);
        ccPayCatToAccount.set(c.id, c.linkedAccountId);
      }
    }
    for (const [m, cMap] of carryoverByMonth) {
      const aMap = assignedByMonth.get(m) ?? new Map<number, number>();
      const oMap = outflowByMonth.get(m) ?? new Map<number, number>();
      const sMap = spendByAccountMonth.get(m) ?? new Map<number, number>();
      const paydownMap = unfundedPaydownByMonth.get(m) ?? new Map<number, number>();
      const nextBal = new Map<number, number>();
      for (const c of normData.categories) {
        const prev = cMap.get(c.id) ?? 0;
        const assigned = aMap.get(c.id) ?? 0;
        const rawFlow = oMap.get(c.id) ?? 0;
        let ccBuffer = 0;
        const linkedAcc = ccPayCatToAccount.get(c.id);
        if (linkedAcc != null) {
          ccBuffer = sMap.get(linkedAcc) ?? 0;
        }
        if (ccGroupIds.has(c.groupId)) {
          const avail = Math.round(prev + assigned + rawFlow + ccBuffer);
          nextBal.set(c.id, avail);
        } else {
          const paydown = paydownMap.get(c.id) ?? 0;
          const avail = Math.round(prev + assigned + rawFlow - paydown);
          if (avail >= 0 || c.overspendCarriesOver) {
            nextBal.set(c.id, avail);
          } else {
            nextBal.set(c.id, 0);
          }
        }
      }
      endingBalanceByMonth.set(m, nextBal);
    }
  }

  return {
    assignedByMonth,
    assignedTotalByMonth,
    outflowByMonth,
    spendByAccountMonth,
    incomeByMonth,
    incomeFromFutureByMonth,
    incomeFromPastByMonth,
    incomeDeferredToFutureByMonth,
    incomeDeferredToPastByMonth,
    carryoverByMonth,
    endingBalanceByMonth,
    overspentByMonth,
    surplusByMonth,
    unfundedPaydownByMonth,
  };
}

function buildRawIndexData(
  data: BudgetData,
  splitParentIds: Set<number>,
  accountMap: Map<number, Account>,
  ccAccountIds: Set<number>
): RawIndexData {
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
  const incomeByMonth = new Map<string, number>();
  const incomeFromFutureByMonth = new Map<string, number>();
  const incomeFromPastByMonth = new Map<string, number>();
  const incomeDeferredToFutureByMonth = new Map<string, number>();
  const incomeDeferredToPastByMonth = new Map<string, number>();
  const cardPaymentsByAccountMonth = new Map<string, Map<number, number>>();
  const categoryTransactionsByMonth = new Map<string, Map<number, CategoryTxEntry[]>>();

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
      const classification = classifyBoundaryTransfer({
        srcOnBudget: onA,
        destOnBudget: onB,
        amount: amt,
        categoryId: t.categoryId,
        incomeMonth: t.incomeMonth,
        allowMissingOutflowCategory: true,
      });
      netOnBudgetDelta = (onA ? amt : 0) + (onB ? -amt : 0);
      isInternalTransfer = !classification.isBoundaryCrossing;
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

      let ctm = categoryTransactionsByMonth.get(mk);
      if (!ctm) {
        ctm = new Map();
        categoryTransactionsByMonth.set(mk, ctm);
      }
      let list = ctm.get(t.categoryId);
      if (!list) {
        list = [];
        ctm.set(t.categoryId, list);
      }
      list.push({
        id: t.id,
        accountId: t.accountId,
        date: t.date,
        amount: netOnBudgetDelta,
        isCC: ccAccountIds.has(t.accountId),
      });
    }

    if (isIncomeTransaction(t, accountMap)) {
      const incMonth = t.incomeMonth || mk;
      const incomeAmt = netOnBudgetDelta > 0 ? netOnBudgetDelta : amt;
      incomeByMonth.set(incMonth, Math.round((incomeByMonth.get(incMonth) ?? 0) + incomeAmt));

      if (t.incomeMonth && t.incomeMonth !== mk) {
        if (mk > t.incomeMonth) {
          incomeFromFutureByMonth.set(
            t.incomeMonth,
            Math.round((incomeFromFutureByMonth.get(t.incomeMonth) ?? 0) + incomeAmt)
          );
          incomeDeferredToPastByMonth.set(
            mk,
            Math.round((incomeDeferredToPastByMonth.get(mk) ?? 0) + incomeAmt)
          );
        } else if (mk < t.incomeMonth) {
          incomeFromPastByMonth.set(
            t.incomeMonth,
            Math.round((incomeFromPastByMonth.get(t.incomeMonth) ?? 0) + incomeAmt)
          );
          incomeDeferredToFutureByMonth.set(
            mk,
            Math.round((incomeDeferredToFutureByMonth.get(mk) ?? 0) + incomeAmt)
          );
        }
      }
    }

    // Transfers involving credit cards
    if (t.transferAccountId != null && isInternalTransfer) {
      const sending = amt < 0 ? t.accountId : t.transferAccountId;
      const receiving = amt < 0 ? t.transferAccountId : t.accountId;
      const transferAmount = Math.abs(amt);

      // Payment into a credit card (from checking, cash, or another card)
      if (ccAccountIds.has(receiving)) {
        let pm = cardPaymentsByAccountMonth.get(mk);
        if (!pm) {
          pm = new Map();
          cardPaymentsByAccountMonth.set(mk, pm);
        }
        pm.set(
          receiving,
          Math.round((pm.get(receiving) ?? 0) + transferAmount)
        );
      }

    }
  }

  return {
    assignedByMonth,
    assignedTotalByMonth,
    outflowByMonth,
    incomeByMonth,
    incomeFromFutureByMonth,
    incomeFromPastByMonth,
    incomeDeferredToFutureByMonth,
    incomeDeferredToPastByMonth,
    cardPaymentsByAccountMonth,
    categoryTransactionsByMonth,
  };
}

function computeAllMonths(
  data: BudgetData,
  rawData: RawIndexData,
  orderedMonths: string[],
  ccGroupIds: Set<number>
): IndexedBudgetData {
  const carryoverByMonth = new Map<string, Map<number, number>>();
  const endingBalanceByMonth = new Map<string, Map<number, number>>();
  const spendByAccountMonth = new Map<string, Map<number, number>>();
  const overspentByMonth = new Map<string, number>();
  const surplusByMonth = new Map<string, number>();
  const unfundedPaydownByMonth = new Map<string, Map<number, number>>();

  let currentBalance = new Map<number, number>(
    data.categories.map((c) => [c.id, num(c.carryover)])
  );
  let runningSurplus = 0;
  const unfundedDebt = new Map<number, Map<number, number>>();

  const accountToCCPayCat = new Map<number, number>();
  for (const c of data.categories) {
    if (
      ccGroupIds.has(c.groupId) &&
      c.linkedAccountId != null &&
      !accountToCCPayCat.has(c.linkedAccountId)
    ) {
      accountToCCPayCat.set(c.linkedAccountId, c.id);
    }
  }

  for (const month of orderedMonths) {
    carryoverByMonth.set(month, new Map(currentBalance));
    surplusByMonth.set(month, runningSurplus);

    const aMap = rawData.assignedByMonth.get(month) ?? new Map<number, number>();
    const oMap = rawData.outflowByMonth.get(month) ?? new Map<number, number>();
    const categoryTxMap = rawData.categoryTransactionsByMonth.get(month) ?? new Map<number, CategoryTxEntry[]>();
    const cardPayments = rawData.cardPaymentsByAccountMonth.get(month) ?? new Map<number, number>();

    const monthFundedCCByAccount = new Map<number, number>();
    const availableCCBufferByAccount = new Map<number, number>();
    for (const [accId, catId] of accountToCCPayCat) {
      availableCCBufferByAccount.set(accId, currentBalance.get(catId) ?? 0);
    }

    let monthCashOverspent = 0;
    const nextBalance = new Map<number, number>();
    const monthUnfundedPaydown = new Map<number, number>();

    // 1. First pass: Non-CC categories
    for (const c of data.categories) {
      if (ccGroupIds.has(c.groupId)) continue;

      const prev = currentBalance.get(c.id) ?? 0;
      const assigned = aMap.get(c.id) ?? 0;
      const rawFlow = oMap.get(c.id) ?? 0;
      const txs = categoryTxMap.get(c.id) ?? [];

      const catFundedCCByAccount = new Map<number, number>();
      const cardCreditByAccount = new Map<number, number>();
      let catFundedCC = 0;
      let netCCSpend = 0;

      const priorCatDebt = unfundedDebt.get(c.id);
      const priorDebtMap = new Map<number, number>(priorCatDebt ? priorCatDebt : []);
      const catDebtMap = new Map<number, number>(priorDebtMap);
      unfundedDebt.set(c.id, catDebtMap);

      // If category carried over a negative balance (prev < 0) and has prior unfunded CC debt,
      // any positive assignment in this month first covers any cash portion of the deficit,
      // and any remaining assignment funds the prior CC debt (moving funds to CC Payment category).
      if (prev < 0 && assigned > 0) {
        const totalPriorCCDebt = Array.from(priorDebtMap.values()).reduce((sum, d) => sum + d, 0);
        const priorCashDeficit = Math.max(0, -prev - totalPriorCCDebt);
        let assignedAfterCashDeficit = Math.max(0, assigned - priorCashDeficit);

        for (const [accId, debt] of priorDebtMap) {
          if (assignedAfterCashDeficit <= 0) break;
          if (debt > 0) {
            const fundedAmt = Math.min(debt, assignedAfterCashDeficit);
            catFundedCCByAccount.set(
              accId,
              (catFundedCCByAccount.get(accId) ?? 0) + fundedAmt
            );
            monthFundedCCByAccount.set(
              accId,
              (monthFundedCCByAccount.get(accId) ?? 0) + fundedAmt
            );
            catDebtMap.set(accId, debt - fundedAmt);
            priorDebtMap.set(accId, debt - fundedAmt);
            assignedAfterCashDeficit -= fundedAmt;
            catFundedCC += fundedAmt;
          }
        }
      }

      const availableBeforeSpend = prev + assigned;
      let runningCashPool = Math.max(0, availableBeforeSpend);

      let catPriorUnfundedPaydown = 0;

      const sortedTxs = txs.slice().sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      for (const tx of sortedTxs) {
        if (tx.isCC) {
          if (tx.amount < 0) {
            const spend = -tx.amount;
            netCCSpend += spend;

            const cardCredit = cardCreditByAccount.get(tx.accountId) ?? 0;
            const creditUsed = Math.min(cardCredit, spend);
            cardCreditByAccount.set(tx.accountId, cardCredit - creditUsed);
            const remainingSpend = spend - creditUsed;

            const funded = Math.max(0, Math.min(runningCashPool, remainingSpend));
            runningCashPool -= funded;
            catFundedCC += funded;
            catFundedCCByAccount.set(
              tx.accountId,
              (catFundedCCByAccount.get(tx.accountId) ?? 0) + funded
            );
            monthFundedCCByAccount.set(
              tx.accountId,
              (monthFundedCCByAccount.get(tx.accountId) ?? 0) + funded
            );
            const unfunded = remainingSpend - funded;
            if (unfunded > 0) {
              catDebtMap.set(
                tx.accountId,
                (catDebtMap.get(tx.accountId) ?? 0) + unfunded
              );
            }
          } else if (tx.amount > 0) {
            let refund = tx.amount;
            netCCSpend -= refund;

            // 1. Pay down unfunded CC debt from prior months first
            const priorDebtForAcc = priorDebtMap.get(tx.accountId) ?? 0;
            const priorPaydown = Math.max(0, Math.min(priorDebtForAcc, refund));
            if (priorPaydown > 0) {
              priorDebtMap.set(tx.accountId, priorDebtForAcc - priorPaydown);
              catDebtMap.set(
                tx.accountId,
                Math.max(0, (catDebtMap.get(tx.accountId) ?? 0) - priorPaydown)
              );
              refund -= priorPaydown;
              if (!c.overspendCarriesOver || prev >= 0) {
                catPriorUnfundedPaydown += priorPaydown;
              }
            }

            // 2. Pay down unfunded CC spend from current month
            if (refund > 0) {
              const currentTotalDebt = catDebtMap.get(tx.accountId) ?? 0;
              const remainingPrior = priorDebtMap.get(tx.accountId) ?? 0;
              const currentMonthUnfunded = Math.max(0, currentTotalDebt - remainingPrior);
              const currentMonthPaydown = Math.max(0, Math.min(currentMonthUnfunded, refund));
              if (currentMonthPaydown > 0) {
                catDebtMap.set(tx.accountId, currentTotalDebt - currentMonthPaydown);
                refund -= currentMonthPaydown;
              }
            }

            // 3. Reverse funded CC spending in the current month for this account
            if (refund > 0) {
              const currentFunded = catFundedCCByAccount.get(tx.accountId) ?? 0;
              const fundedRefund = Math.max(0, Math.min(currentFunded, refund));
              if (fundedRefund > 0) {
                catFundedCCByAccount.set(
                  tx.accountId,
                  currentFunded - fundedRefund
                );
                catFundedCC -= fundedRefund;
                monthFundedCCByAccount.set(
                  tx.accountId,
                  (monthFundedCCByAccount.get(tx.accountId) ?? 0) - fundedRefund
                );
                runningCashPool += fundedRefund;
                refund -= fundedRefund;
              }
            }

            // 4. Reverse prior months' funded CC buffer (if any remaining refund)
            if (refund > 0) {
              const availInCC = availableCCBufferByAccount.get(tx.accountId) ?? 0;
              const fundedRefundFromPrior = Math.max(0, Math.min(availInCC, refund));
              if (fundedRefundFromPrior > 0) {
                availableCCBufferByAccount.set(tx.accountId, availInCC - fundedRefundFromPrior);
                monthFundedCCByAccount.set(
                  tx.accountId,
                  (monthFundedCCByAccount.get(tx.accountId) ?? 0) - fundedRefundFromPrior
                );
                runningCashPool += fundedRefundFromPrior;
                refund -= fundedRefundFromPrior;
              }
            }

            // 5. Any excess refund remains as card credit balance on this card
            if (refund > 0) {
              cardCreditByAccount.set(
                tx.accountId,
                (cardCreditByAccount.get(tx.accountId) ?? 0) + refund
              );
            }
          }
        } else {
          // Cash account transaction
          runningCashPool += tx.amount;
        }
      }

      if (catPriorUnfundedPaydown > 0) {
        monthUnfundedPaydown.set(c.id, catPriorUnfundedPaydown);
      }

      const effectiveFlow = rawFlow - catPriorUnfundedPaydown;
      const endAvailable = Math.round(prev + assigned + effectiveFlow);
      if (endAvailable >= 0) {
        nextBalance.set(c.id, endAvailable);
      } else {
        if (c.overspendCarriesOver) {
          nextBalance.set(c.id, endAvailable);
        } else {
          nextBalance.set(c.id, 0);
          const totalDeficit = -endAvailable;
          const ccOverspent = Math.max(0, Math.min(totalDeficit, netCCSpend - catFundedCC));
          const cashOverspent = totalDeficit - ccOverspent;
          monthCashOverspent += cashOverspent;
        }
      }
    }

    // 2. Second pass: CC payment categories
    const monthSpendByAccount = new Map<number, number>();
    const seenLinkedAccounts = new Set<number>();
    for (const c of data.categories) {
      if (!ccGroupIds.has(c.groupId)) continue;

      const prev = currentBalance.get(c.id) ?? 0;
      const assigned = aMap.get(c.id) ?? 0;
      const rawFlow = oMap.get(c.id) ?? 0;

      let ccBuffer = 0;
      const linkedAcc = c.linkedAccountId;
      if (linkedAcc != null && !seenLinkedAccounts.has(linkedAcc)) {
        seenLinkedAccounts.add(linkedAcc);
        const fundedCC = monthFundedCCByAccount.get(linkedAcc) ?? 0;
        const cardPayment = cardPayments.get(linkedAcc) ?? 0;
        ccBuffer = Math.round(fundedCC - cardPayment);
        monthSpendByAccount.set(linkedAcc, ccBuffer);
      }

      const next = Math.round(prev + assigned + rawFlow + ccBuffer);
      nextBalance.set(c.id, next);
    }

    endingBalanceByMonth.set(month, new Map(nextBalance));
    spendByAccountMonth.set(month, monthSpendByAccount);
    overspentByMonth.set(month, monthCashOverspent);
    unfundedPaydownByMonth.set(month, monthUnfundedPaydown);

    const income = rawData.incomeByMonth.get(month) ?? 0;
    const assignedTotal = rawData.assignedTotalByMonth.get(month) ?? 0;
    const tbb = Math.round(income - assignedTotal + runningSurplus - monthCashOverspent);
    runningSurplus = tbb;

    currentBalance = nextBalance;
  }

  return {
    assignedByMonth: rawData.assignedByMonth,
    assignedTotalByMonth: rawData.assignedTotalByMonth,
    outflowByMonth: rawData.outflowByMonth,
    spendByAccountMonth,
    incomeByMonth: rawData.incomeByMonth,
    incomeFromFutureByMonth: rawData.incomeFromFutureByMonth,
    incomeFromPastByMonth: rawData.incomeFromPastByMonth,
    incomeDeferredToFutureByMonth: rawData.incomeDeferredToFutureByMonth,
    incomeDeferredToPastByMonth: rawData.incomeDeferredToPastByMonth,
    carryoverByMonth,
    endingBalanceByMonth,
    overspentByMonth,
    surplusByMonth,
    unfundedPaydownByMonth,
  };
}

export function buildBudgetIndex(data: BudgetData): SerializedBudgetIndex {
  const normData = normalizeBudgetData(data);
  const splitParentIds = new Set<number>();
  for (const t of normData.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }
  const accountMap = new Map<number, Account>(normData.accounts.map((a) => [a.id, a]));
  const ccAccountIds = getCCAccountIds(normData);
  const rawData = buildRawIndexData(normData, splitParentIds, accountMap, ccAccountIds);

  const months = getMonthsWithData(normData);
  const ccGroupIds = new Set(
    normData.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );

  const index = computeAllMonths(normData, rawData, months, ccGroupIds);
  budgetDataIndexCache.set(data, index);
  if (normData !== data) {
    budgetDataIndexCache.set(normData, index);
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
  const serializedEnding: Record<string, Record<string | number, number>> = {};
  for (const [m, map] of index.endingBalanceByMonth) {
    serializedEnding[m] = Object.fromEntries(map);
  }
  const serializedUnfundedPaydown: Record<string, Record<string | number, number>> = {};
  if (index.unfundedPaydownByMonth) {
    for (const [m, map] of index.unfundedPaydownByMonth) {
      if (map.size > 0) {
        serializedUnfundedPaydown[m] = Object.fromEntries(map);
      }
    }
  }

  const result: SerializedBudgetIndex = {
    version: BUDGET_INDEX_VERSION,
    assignedByMonth: serializedAssigned,
    assignedTotalByMonth: Object.fromEntries(index.assignedTotalByMonth),
    outflowByMonth: serializedOutflow,
    spendByAccountMonth: serializedSpend,
    incomeByMonth: Object.fromEntries(index.incomeByMonth),
    incomeFromFutureByMonth: Object.fromEntries(index.incomeFromFutureByMonth ?? new Map()),
    incomeFromPastByMonth: Object.fromEntries(index.incomeFromPastByMonth ?? new Map()),
    incomeDeferredToFutureByMonth: Object.fromEntries(index.incomeDeferredToFutureByMonth ?? new Map()),
    incomeDeferredToPastByMonth: Object.fromEntries(index.incomeDeferredToPastByMonth ?? new Map()),
    carryoverByMonth: serializedCarryover,
    endingBalanceByMonth: serializedEnding,
    overspentByMonth: Object.fromEntries(index.overspentByMonth),
    surplusByMonth: Object.fromEntries(index.surplusByMonth),
    unfundedPaydownByMonth: serializedUnfundedPaydown,
  };

  serializedIndexEpochs.set(result, globalCacheEpoch);
  return result;
}

function getOrBuildIndex(
  data: BudgetData,
  splitParentIds: Set<number>,
  accountMap: Map<number, Account>,
  ccAccountIds: Set<number>,
  targetMonth?: string
): IndexedBudgetData {
  let cached = budgetDataIndexCache.get(data);
  if (cached) return cached;

  if (data.budgetIndex) {
    const indexEpoch = serializedIndexEpochs.get(data.budgetIndex);
    const isValidEpoch = indexEpoch === undefined || indexEpoch === globalCacheEpoch;
    const isValidVersion =
      data.budgetIndex.version === undefined ||
      data.budgetIndex.version === BUDGET_INDEX_VERSION;

    if (isValidEpoch && isValidVersion) {
      if (indexEpoch === undefined) {
        serializedIndexEpochs.set(data.budgetIndex, globalCacheEpoch);
      }
      cached = hydrateBudgetIndex(data.budgetIndex, data);
      budgetDataIndexCache.set(data, cached);
      return cached;
    } else {
      data.budgetIndex = undefined;
    }
  }

  const rawData = buildRawIndexData(data, splitParentIds, accountMap, ccAccountIds);
  const months = getMonthsWithData(data);
  const orderedMonths =
    targetMonth && !months.includes(targetMonth)
      ? [...new Set([...months, targetMonth])].sort()
      : months;
  const ccGroupIds = new Set(
    data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );

  cached = computeAllMonths(data, rawData, orderedMonths, ccGroupIds);
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
  const normData = normalizeBudgetData(data);

  // Build split parent ID set so parent rows are skipped in all aggregations
  const splitParentIds = new Set<number>();
  for (const t of normData.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const accountMap = new Map<number, Account>(normData.accounts.map((a) => [a.id, a]));
  const ccAccountIds = getCCAccountIds(normData);
  const index = getOrBuildIndex(normData, splitParentIds, accountMap, ccAccountIds, month);
  if (normData !== data) {
    budgetDataIndexCache.set(data, index);
  }

  // 1. Determine the ordered list of months we need to walk through.
  const months = getMonthsWithData(normData);

  // CC Payment groups and categories: Map<categoryId, linkedAccountId>
  const ccGroupIds = new Set(
    normData.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id)
  );
  const seenLinkedAccounts = new Set<number>();
  const ccPayCatToAccount = new Map<number, number>();
  for (const c of normData.categories) {
    if (
      ccGroupIds.has(c.groupId) &&
      c.linkedAccountId != null &&
      !seenLinkedAccounts.has(c.linkedAccountId)
    ) {
      seenLinkedAccounts.add(c.linkedAccountId);
      ccPayCatToAccount.set(c.id, c.linkedAccountId);
    }
  }

  // Build cumulative carryover per category up to (but not including) `month`.
  const { carryoverMap, overspentPrevious, overspentPreviousMonthKey } = buildCarryoverMap(
    normData,
    index,
    months,
    month
  );

  // 2. Compute the current month's raw outflow per category.
  const outflowMap = index.outflowByMonth.get(month) ?? new Map<number, number>();

  // 3. CC buffer for this month.
  const ccBufferMap = buildCCBufferMap(index, month, ccPayCatToAccount);

  // 4. Assignments for the current month.
  const assignMap = index.assignedByMonth.get(month) ?? new Map<number, number>();

  // 5. Build CatRow for every category.
  const unfundedPaydownMap = index.unfundedPaydownByMonth?.get(month) ?? new Map<number, number>();
  const catsByGroup = new Map<number, CatRow[]>();
  for (const c of normData.categories) {
    const carryoverIn = carryoverMap.get(c.id) ?? 0;
    const assigned = assignMap.get(c.id) ?? 0;
    const rawFlow = outflowMap.get(c.id) ?? 0;
    const outflow = Math.min(0, rawFlow);
    const paydown = unfundedPaydownMap.get(c.id) ?? 0;

    const ccBuffer = ccBufferMap.get(c.id) ?? 0;
    const available = ccGroupIds.has(c.groupId)
      ? Math.round(carryoverIn + assigned + rawFlow + ccBuffer)
      : Math.round(carryoverIn + assigned + rawFlow - paydown);

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
  const groups: GroupRow[] = normData.groups
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
  const incomeFromFuture = index.incomeFromFutureByMonth?.get(month) ?? 0;
  const incomeFromPast = index.incomeFromPastByMonth?.get(month) ?? 0;
  const incomeDeferredToFuture = index.incomeDeferredToFutureByMonth?.get(month) ?? 0;
  const incomeDeferredToPast = index.incomeDeferredToPastByMonth?.get(month) ?? 0;
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
    overspentPreviousMonthKey,
    incomeFromFuture,
    incomeFromPast,
    incomeDeferredToFuture,
    incomeDeferredToPast,
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

/**
 * Retrieve carryover balance map and previous data month's cash overspent amount.
 */
function buildCarryoverMap(
  data: BudgetData,
  index: IndexedBudgetData,
  orderedMonths: string[],
  targetMonth: string
): {
  carryoverMap: Map<number, number>;
  overspentPrevious: number;
  overspentPreviousMonthKey?: string;
} {
  const priorMonths = orderedMonths.filter((m) => m < targetMonth);
  const mostRecentPrior = priorMonths.length > 0 ? priorMonths[priorMonths.length - 1] : null;
  const overspentPrevious = mostRecentPrior
    ? (index.overspentByMonth.get(mostRecentPrior) ?? 0)
    : 0;

  const carryoverMap =
    index.carryoverByMonth.get(targetMonth) ??
    (mostRecentPrior && index.endingBalanceByMonth.get(mostRecentPrior)
      ? new Map(index.endingBalanceByMonth.get(mostRecentPrior))
      : new Map(data.categories.map((c) => [c.id, num(c.carryover)])));

  return {
    carryoverMap,
    overspentPrevious,
    ...(mostRecentPrior ? { overspentPreviousMonthKey: mostRecentPrior } : {}),
  };
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

