/**
 * budget-walk.ts
 *
 * Month-walk machinery extracted from budget-engine.ts (P2 decompose):
 * shared set collectors plus the two per-month walk passes and the 5-step
 * CC-refund waterfall. Pure: all walk state is passed in explicitly, so the
 * YNAB4-faithful core stays testable in isolation and the walk order in
 * `computeAllMonths` is the only sequencing that matters.
 */

import type { Category, CategoryGroup, Transaction } from "./types.js";

/** Per-transaction slice the month walk consumes (precomputed in the raw index). */
export type CategoryTxEntry = {
  id: number;
  accountId: number;
  date: string;
  amount: number;
  isCC: boolean;
};

/**
 * Ids of split-parent rows (referenced as `parentId` by other rows).
 * Split totals live on the children; parents are skipped in aggregations.
 */
export function collectSplitParentIds(
  transactions: readonly Pick<Transaction, "parentId">[]
): Set<number> {
  const out = new Set<number>();
  for (const t of transactions) {
    if (t.parentId != null) out.add(t.parentId);
  }
  return out;
}

/** Ids of Credit Card Payments groups. */
export function collectCCGroupIds(
  groups: readonly Pick<CategoryGroup, "id" | "isCreditCardPayments">[]
): Set<number> {
  return new Set(groups.filter((g) => g.isCreditCardPayments).map((g) => g.id));
}

/**
 * First linked CC-payment category per account (first-wins; mirrors the
 * normalizeBudgetData link dedupe). Direction: accountId -> categoryId.
 */
export function mapCCPayCategories(
  categories: readonly Category[],
  ccGroupIds: Set<number>
): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of categories) {
    if (
      ccGroupIds.has(c.groupId) &&
      c.linkedAccountId != null &&
      !out.has(c.linkedAccountId)
    ) {
      out.set(c.linkedAccountId, c.id);
    }
  }
  return out;
}

/**
 * YNAB4 `overspendingHandling` inheritance for one category+month in walk
 * order: an explicit override for the month wins; otherwise the previous
 * walked month's effective handling is inherited; otherwise the static
 * `Category.overspendCarriesOver` flag seeds the chain (default false =
 * AffectsBuffer). Records the result in `inherited` and returns it.
 */
export function effectiveOverspendHandling(
  category: Category,
  month: string,
  overrides: Map<number, Map<string, boolean>> | undefined,
  inherited: Map<number, boolean>
): boolean {
  const explicit = overrides?.get(category.id)?.get(month);
  if (explicit !== undefined) {
    inherited.set(category.id, explicit);
    return explicit;
  }
  const prev = inherited.get(category.id);
  if (prev !== undefined) return prev;
  const seed = category.overspendCarriesOver ?? false;
  inherited.set(category.id, seed);
  return seed;
}

/** Mutable per-account ledgers the refund waterfall draws down. */
export type RefundWaterfallAccounts = {
  priorDebtMap: Map<number, number>;
  catDebtMap: Map<number, number>;
  catFundedCCByAccount: Map<number, number>;
  monthFundedCCByAccount: Map<number, number>;
  availableCCBufferByAccount: Map<number, number>;
  cardCreditByAccount: Map<number, number>;
};

/**
 * 5-step CC-refund waterfall for one positive CC transaction: prior-month
 * unfunded debt, then current-month unfunded spend, then current-month
 * funded buffer, then prior months' funded buffer, with any excess parked
 * as card credit. Returns the updated cash pool / funded totals plus the
 * prior-unfunded paydown to record for the month.
 */
export function applyRefundWaterfall(args: {
  accountId: number;
  refund: number;
  carriesOver: boolean;
  prev: number;
  runningCashPool: number;
  catFundedCC: number;
  accounts: RefundWaterfallAccounts;
}): { runningCashPool: number; catFundedCC: number; priorUnfundedPaydown: number } {
  const { accountId, carriesOver, prev, accounts } = args;
  let { refund, runningCashPool, catFundedCC } = args;
  const {
    priorDebtMap,
    catDebtMap,
    catFundedCCByAccount,
    monthFundedCCByAccount,
    availableCCBufferByAccount,
    cardCreditByAccount,
  } = accounts;
  let priorUnfundedPaydown = 0;

  // 1. Pay down unfunded CC debt from prior months first
  const priorDebtForAcc = priorDebtMap.get(accountId) ?? 0;
  const priorPaydown = Math.max(0, Math.min(priorDebtForAcc, refund));
  if (priorPaydown > 0) {
    priorDebtMap.set(accountId, priorDebtForAcc - priorPaydown);
    catDebtMap.set(
      accountId,
      Math.max(0, (catDebtMap.get(accountId) ?? 0) - priorPaydown)
    );
    refund -= priorPaydown;
    if (!carriesOver || prev >= 0) {
      priorUnfundedPaydown += priorPaydown;
    }
  }

  // 2. Pay down unfunded CC spend from current month
  if (refund > 0) {
    const currentTotalDebt = catDebtMap.get(accountId) ?? 0;
    const remainingPrior = priorDebtMap.get(accountId) ?? 0;
    const currentMonthUnfunded = Math.max(0, currentTotalDebt - remainingPrior);
    const currentMonthPaydown = Math.max(0, Math.min(currentMonthUnfunded, refund));
    if (currentMonthPaydown > 0) {
      catDebtMap.set(accountId, currentTotalDebt - currentMonthPaydown);
      refund -= currentMonthPaydown;
    }
  }

  // 3. Reverse funded CC spending in the current month for this account
  if (refund > 0) {
    const currentFunded = catFundedCCByAccount.get(accountId) ?? 0;
    const fundedRefund = Math.max(0, Math.min(currentFunded, refund));
    if (fundedRefund > 0) {
      catFundedCCByAccount.set(
        accountId,
        currentFunded - fundedRefund
      );
      catFundedCC -= fundedRefund;
      monthFundedCCByAccount.set(
        accountId,
        (monthFundedCCByAccount.get(accountId) ?? 0) - fundedRefund
      );
      runningCashPool += fundedRefund;
      refund -= fundedRefund;
    }
  }

  // 4. Reverse prior months' funded CC buffer (if any remaining refund)
  if (refund > 0) {
    const availInCC = availableCCBufferByAccount.get(accountId) ?? 0;
    const fundedRefundFromPrior = Math.max(0, Math.min(availInCC, refund));
    if (fundedRefundFromPrior > 0) {
      availableCCBufferByAccount.set(accountId, availInCC - fundedRefundFromPrior);
      monthFundedCCByAccount.set(
        accountId,
        (monthFundedCCByAccount.get(accountId) ?? 0) - fundedRefundFromPrior
      );
      runningCashPool += fundedRefundFromPrior;
      refund -= fundedRefundFromPrior;
    }
  }

  // 5. Any excess refund remains as card credit balance on this card
  if (refund > 0) {
    cardCreditByAccount.set(
      accountId,
      (cardCreditByAccount.get(accountId) ?? 0) + refund
    );
  }

  return { runningCashPool, catFundedCC, priorUnfundedPaydown };
}

/** Shared mutable walk state for the non-CC first pass. */
export type NonCCWalkShared = {
  currentBalance: Map<number, number>;
  /** Unfunded CC debt per category+account; persists across months. */
  unfundedDebt: Map<number, Map<number, number>>;
  /** accountId -> CC-payment categoryId (first-wins). */
  accountToCCPayCat: Map<number, number>;
  /** Funded buffer available per account; refunded down by the waterfall. */
  availableCCBufferByAccount: Map<number, number>;
  /** Funded-CC flow per account for the current month; refunded down too. */
  monthFundedCCByAccount: Map<number, number>;
  inheritedHandling: Map<number, boolean>;
  overrides: Map<number, Map<string, boolean>> | undefined;
  nextBalance: Map<number, number>;
  monthUnfundedPaydown: Map<number, number>;
};

/**
 * First pass for one non-CC category: prior-debt funding from new
 * assignments, cash-priority spend, chronological CC funding, the refund
 * waterfall, then clamp-or-carry. Returns the cash-overspent delta to
 * deduct from the month's TBB.
 */
export function walkNonCCCategory(
  c: Category,
  month: string,
  assigned: number,
  rawFlow: number,
  txs: CategoryTxEntry[],
  shared: NonCCWalkShared
): number {
  const {
    currentBalance,
    unfundedDebt,
    availableCCBufferByAccount,
    monthFundedCCByAccount,
    inheritedHandling,
    overrides,
    nextBalance,
    monthUnfundedPaydown,
  } = shared;
  let monthCashOverspent = 0;

  const prev = currentBalance.get(c.id) ?? 0;
  const carriesOver = effectiveOverspendHandling(c, month, overrides, inheritedHandling);

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

  // Pass 1 (Cash Priority): Deduct all cash (non-CC) activity from the available pool first.
  // This ensures cash spending always takes priority over CC spending regardless of transaction dates.
  let netCashFlow = 0;
  for (const tx of txs) {
    if (!tx.isCC) {
      netCashFlow += tx.amount;
    }
  }
  let runningCashPool = Math.max(0, availableBeforeSpend + netCashFlow);

  let catPriorUnfundedPaydown = 0;

  // Pass 2 (CC Funding): Process CC transactions chronologically using remaining cash pool.
  const ccTxs = txs
    .filter((tx) => tx.isCC)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  for (const tx of ccTxs) {
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
      const refund = tx.amount;
      netCCSpend -= refund;

      const out = applyRefundWaterfall({
        accountId: tx.accountId,
        refund,
        carriesOver,
        prev,
        runningCashPool,
        catFundedCC,
        accounts: {
          priorDebtMap,
          catDebtMap,
          catFundedCCByAccount,
          monthFundedCCByAccount,
          availableCCBufferByAccount,
          cardCreditByAccount,
        },
      });
      runningCashPool = out.runningCashPool;
      catFundedCC = out.catFundedCC;
      catPriorUnfundedPaydown += out.priorUnfundedPaydown;
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
    if (carriesOver) {
      nextBalance.set(c.id, endAvailable);
    } else {
      nextBalance.set(c.id, 0);
      const totalDeficit = -endAvailable;
      const ccOverspent = Math.max(0, Math.min(totalDeficit, netCCSpend - catFundedCC));
      const cashOverspent = totalDeficit - ccOverspent;
      monthCashOverspent += cashOverspent;
    }
  }
  return monthCashOverspent;
}

/** Shared mutable walk state for the CC-payment second pass. */
export type CCPaymentWalkShared = {
  currentBalance: Map<number, number>;
  inheritedHandling: Map<number, boolean>;
  overrides: Map<number, Map<string, boolean>> | undefined;
  nextBalance: Map<number, number>;
};

/**
 * Second pass over the CC Payment categories: prior balance + assignments
 * + raw flow + the funded-minus-paid buffer, then clamp-or-carry like a
 * regular category. Returns the per-account buffer spend plus the
 * cash-overspent delta for the month's TBB.
 */
export function walkCCPaymentCategories(
  categories: readonly Category[],
  ccGroupIds: Set<number>,
  month: string,
  assignedByCat: Map<number, number>,
  outflowByCat: Map<number, number>,
  cardPayments: Map<number, number>,
  monthFundedCCByAccount: Map<number, number>,
  shared: CCPaymentWalkShared
): { monthSpendByAccount: Map<number, number>; cashOverspent: number } {
  const { currentBalance, inheritedHandling, overrides, nextBalance } = shared;
  const monthSpendByAccount = new Map<number, number>();
  const seenLinkedAccounts = new Set<number>();
  let cashOverspent = 0;

  for (const c of categories) {
    if (!ccGroupIds.has(c.groupId)) continue;

    const prev = currentBalance.get(c.id) ?? 0;
    const assigned = assignedByCat.get(c.id) ?? 0;
    const rawFlow = outflowByCat.get(c.id) ?? 0;

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
    // YNAB4-style: overspend inside the CC Payment category itself is cash
    // overspending like a regular category — deduct the deficit from TBB
    // and clamp carryover to 0 (unless red-arrow handling carries it).
    if (next >= 0) {
      nextBalance.set(c.id, next);
    } else {
      const carriesOver = effectiveOverspendHandling(c, month, overrides, inheritedHandling);
      if (carriesOver) {
        nextBalance.set(c.id, next);
      } else {
        nextBalance.set(c.id, 0);
        cashOverspent += -next;
      }
    }
  }
  return { monthSpendByAccount, cashOverspent };
}
