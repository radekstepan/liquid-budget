/**
 * transfers.ts
 *
 * Single source of truth for budget boundary transfer classification.
 */

import type { Account, Transaction } from "./types.js";
import { num } from "./format.js";

/**
 * Thrown to signal a domain/transaction validation failure that should surface
 * as an HTTP 4xx client response.
 */
export class TransactionError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "TransactionError";
  }
}

export type BoundaryTransferClassification = {
  isBoundaryCrossing: boolean;
  netOnBudgetDelta: number;
  categoryId: number | null;
  isIncome: boolean;
  incomeMonth: string | null;
};

export interface ClassifyBoundaryTransferParams {
  srcOnBudget: boolean;
  destOnBudget: boolean;
  amount: number;
  categoryId?: number | null;
  incomeMonth?: string | null;
  errorFactory?: (message: string) => Error;
  allowMissingOutflowCategory?: boolean;
}

/**
 * Classify a transfer between source and destination accounts according to
 * budget boundary rules.
 *
 * Four states handled:
 *   (a) Internal transfer (same boundary: srcOnBudget === destOnBudget):
 *       -> { isBoundaryCrossing: false, netOnBudgetDelta: 0, categoryId: null, isIncome: false, incomeMonth: null }
 *   (b) Boundary inflow with category (netOnBudgetDelta > 0 && categoryId != null):
 *       -> { isBoundaryCrossing: true, netOnBudgetDelta, categoryId, isIncome: false, incomeMonth: null }
 *   (c) Boundary inflow without category (netOnBudgetDelta > 0 && categoryId == null):
 *       -> { isBoundaryCrossing: true, netOnBudgetDelta, categoryId: null, isIncome: true, incomeMonth }
 *   (d) Boundary outflow (netOnBudgetDelta < 0):
 *       -> categoryId is required; throws error via errorFactory if null/undefined unless allowMissingOutflowCategory is true.
 *       -> { isBoundaryCrossing: true, netOnBudgetDelta, categoryId, isIncome: false, incomeMonth: null }
 */
export function classifyBoundaryTransfer({
  srcOnBudget,
  destOnBudget,
  amount,
  categoryId = null,
  incomeMonth = null,
  errorFactory = (msg) => new TransactionError(msg, 400),
  allowMissingOutflowCategory = false,
}: ClassifyBoundaryTransferParams): BoundaryTransferClassification {
  const isBoundaryCrossing = srcOnBudget !== destOnBudget;
  const netOnBudgetDelta = (srcOnBudget ? amount : 0) + (destOnBudget ? -amount : 0);

  if (!isBoundaryCrossing) {
    return {
      isBoundaryCrossing: false,
      netOnBudgetDelta: 0,
      categoryId: null,
      isIncome: false,
      incomeMonth: null,
    };
  }

  if (netOnBudgetDelta > 0) {
    if (categoryId != null) {
      return {
        isBoundaryCrossing: true,
        netOnBudgetDelta,
        categoryId,
        isIncome: false,
        incomeMonth: null,
      };
    }
    return {
      isBoundaryCrossing: true,
      netOnBudgetDelta,
      categoryId: null,
      isIncome: true,
      incomeMonth: incomeMonth ?? null,
    };
  }

  if (netOnBudgetDelta < 0) {
    if (categoryId == null) {
      if (allowMissingOutflowCategory) {
        return {
          isBoundaryCrossing: true,
          netOnBudgetDelta,
          categoryId: null,
          isIncome: false,
          incomeMonth: null,
        };
      }
      throw errorFactory("Boundary transfer outflow requires a category");
    }
    return {
      isBoundaryCrossing: true,
      netOnBudgetDelta,
      categoryId,
      isIncome: false,
      incomeMonth: null,
    };
  }

  // netOnBudgetDelta === 0 (e.g. 0 amount)
  return {
    isBoundaryCrossing: true,
    netOnBudgetDelta: 0,
    categoryId: null,
    isIncome: false,
    incomeMonth: null,
  };
}

type AccountLookup = Map<number, Account> | Account[] | undefined;

function findAccount(accounts: AccountLookup, id: number): Account | undefined {
  if (!accounts) return undefined;
  return accounts instanceof Map
    ? accounts.get(id)
    : accounts.find((a) => a.id === id);
}

/**
 * Net on-budget delta of a transfer row: positive when money ENTERS the
 * budget (a boundary inflow, e.g. an investment withdrawal back into an
 * on-budget account), negative when it LEAVES (a boundary outflow, e.g. a
 * contribution to an off-budget investment account), zero for internal
 * (same-boundary) moves. Non-transfer rows return 0.
 *
 * The sign convention is uniform regardless of which leg the row was
 * recorded on: the amount is the delta on `accountId`, so the budget impact
 * is `(onA ? amt : 0) + (onB ? -amt : 0)`. Missing accounts default to
 * on-budget (matches `isIncomeTransaction`).
 */
export function transferNetOnBudgetDelta(
  t: Transaction,
  accountMap?: Map<number, Account> | Account[]
): number {
  if (t.transferAccountId == null) return 0;
  const onA = findAccount(accountMap, t.accountId)?.onBudget ?? true;
  const onB = findAccount(accountMap, t.transferAccountId)?.onBudget ?? true;
  const amt = num(t.amount);
  return (onA ? amt : 0) + (onB ? -amt : 0);
}

/**
 * True when the row is a transfer touching at least one off-budget account:
 * a boundary crossing in either direction (a contribution out to, or a
 * withdrawal back from, an off-budget account) or a move between two
 * off-budget accounts. Such rows are money movement between pools, never
 * terminal income or spending: flow-through reports skip them and trace the
 * money through the intermediate account instead (see `sankey.ts`). Missing
 * accounts default to on-budget (matches `transferNetOnBudgetDelta`).
 */
export function isOffBudgetTransfer(
  t: Transaction,
  accountMap?: Map<number, Account> | Account[]
): boolean {
  if (t.transferAccountId == null) return false;
  const onA = findAccount(accountMap, t.accountId)?.onBudget ?? true;
  const onB = findAccount(accountMap, t.transferAccountId)?.onBudget ?? true;
  return !onA || !onB;
}

/**
 * True when the row is an internal transfer: both legs sit on the same side
 * of the budget boundary and both are on-budget (e.g. moving money from
 * chequing to an on-budget savings account). Such moves are pure money
 * movement inside the budget: the spending is captured by the terminal
 * purchase (wherever its account sits), so flow-through reports must not
 * count either leg — the legs would otherwise show as gross pass-through
 * "spending" under `Transfer: <account>` payees that never nets out (each
 * leg names the OTHER account, so the two sides never share a payee to net
 * under). Matches the `isInternalTransfer` boundary concept in
 * `reports.ts` (cash flow) and `budget-engine.ts`. Missing accounts default
 * to on-budget (matches `transferNetOnBudgetDelta`).
 */
export function isInternalTransfer(
  t: Transaction,
  accountMap?: Map<number, Account> | Account[]
): boolean {
  if (t.transferAccountId == null) return false;
  const onA = findAccount(accountMap, t.accountId)?.onBudget ?? true;
  const onB = findAccount(accountMap, t.transferAccountId)?.onBudget ?? true;
  return onA && onB;
}

/**
 * True when the row is an internal (same-boundary) transfer touching an
 * on-budget credit account — i.e. a credit-card payoff from the budget, a
 * cash advance back into it, or a balance transfer between cards. Such moves
 * are pure money movement: the spending was already captured by the original
 * categorized card purchases, so reports must not count the transfer again
 * (money flows THROUGH, it is not a second expense). A subset of
 * `isInternalTransfer` (kept as its own classifier for callers that care
 * specifically about the credit leg).
 *
 * Boundary-crossing transfers are never payoffs (see `isOffBudgetTransfer`):
 * money moves between the budget and an intermediate off-budget pool there,
 * and flow-through reports trace it instead of counting either leg.
 */
export function isCreditPayoffTransfer(
  t: Transaction,
  accountMap?: Map<number, Account> | Account[]
): boolean {
  if (t.transferAccountId == null) return false;
  const accA = findAccount(accountMap, t.accountId);
  const accB = findAccount(accountMap, t.transferAccountId);
  const onA = accA?.onBudget ?? true;
  const onB = accB?.onBudget ?? true;
  if (onA !== onB) return false;
  return (
    (accA != null && accA.kind === "credit" && accA.onBudget) ||
    (accB != null && accB.kind === "credit" && accB.onBudget)
  );
}
