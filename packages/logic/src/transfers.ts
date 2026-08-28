/**
 * transfers.ts
 *
 * Single source of truth for budget boundary transfer classification.
 */

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
 *       -> categoryId is required; throws error via errorFactory if null/undefined.
 *       -> { isBoundaryCrossing: true, netOnBudgetDelta, categoryId, isIncome: false, incomeMonth: null }
 */
export function classifyBoundaryTransfer({
  srcOnBudget,
  destOnBudget,
  amount,
  categoryId = null,
  incomeMonth = null,
  errorFactory = (msg) => new TransactionError(msg, 400),
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
