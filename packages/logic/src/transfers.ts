/**
 * transfers.ts
 *
 * Single source of truth for budget boundary transfer classification.
 */

import type { Account, Transaction } from "./types.js";
import { num } from "./format.js";
import { isTransferPayee } from "./rename-rules.js";

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

export interface InferInflowIncomeParams {
  categoryId: number | null;
  /** Signed amount in integer cents. Only the sign is read. */
  amountCents: number;
  /**
   * Explicit isIncome override ("Income" vs "Uncategorized" choice).
   * Defaults to true when eligible.
   */
  explicitIsIncome?: boolean;
  incomeMonth?: string | null;
}

/**
 * Single source of truth for the uncategorized-inflow income rule on
 * liquid on-budget accounts: a positive inflow with no category is
 * income (explicit `isIncome: false` keeps it "Uncategorized"); anything
 * else — categorized, outflow, or zero — is never income and carries no
 * income month.
 *
 * Callers own the account-scope guard (off-budget / credit / transfer /
 * split-parent branches) and any value-change preservation; they funnel
 * the liquid on-budget non-transfer leaf through here so the server
 * (`transactions/create`, `transactions/update`, `transactions/splits`)
 * and the optimistic planner (`optimistic.ts`) cannot drift.
 */
export function inferUncategorizedInflowIncome({
  categoryId,
  amountCents,
  explicitIsIncome,
  incomeMonth = null,
}: InferInflowIncomeParams): { isIncome: boolean; incomeMonth: string | null } {
  const eligible = categoryId == null && amountCents > 0;
  const isIncome = eligible ? (explicitIsIncome ?? true) : false;
  return { isIncome, incomeMonth: isIncome ? (incomeMonth ?? null) : null };
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
 * Net on-budget delta of any row, transfer or plain: transfer rows delegate
 * to {@link transferNetOnBudgetDelta}; plain rows score `amt` when their
 * account is on-budget, else 0. Missing accounts default to on-budget
 * (matches `isIncomeTransaction`). Read-path helper so cash-flow/report
 * aggregators share one boundary-math site instead of inlining it.
 */
export function rowNetOnBudgetDelta(
  t: Transaction,
  accountMap?: Map<number, Account> | Account[]
): number {
  if (t.transferAccountId != null) return transferNetOnBudgetDelta(t, accountMap);
  const onA = findAccount(accountMap, t.accountId)?.onBudget ?? true;
  return onA ? num(t.amount) : 0;
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
 * Transfer eligibility guards, ported from YNAB4
 * (TransactionList.as:266-273, BaseTransaction.as:144-163,
 * TransferUtilities.as:22-52, BaseTransaction.as:304-329).
 *
 * Strict write-path validation. This is intentionally separate from
 * {@link classifyBoundaryTransfer}, which stays lenient for read paths:
 * classify sees only boundary booleans (no account ids, so it cannot
 * detect self-transfers) and runs over already-stored rows in
 * `budget-engine`/`merge`, where throwing would turn legacy data into
 * runtime errors. Callers creating or editing rows must run
 * {@link validateTransferEligibility} first, then classify.
 *
 * YNAB4 also forbids transfers for ScheduledTransaction,
 * MatchedTransaction, and their SubTransactions. Those states have no
 * representable check here: `Transaction` carries no scheduled/matched
 * markers (scheduled entries live in the separate `recurring` table, whose
 * "transfer" flavour is intentionally retained for import/seed
 * compatibility; import "matched" state is not persisted), so there is no
 * field to key the ban on. The structurally representable guards —
 * self-transfer, split-parent-as-transfer, same-boundary category, and
 * payee/leg consistency — are enforced below. Persistence-level mirrors
 * already exist (the `transactions_transfer_not_self_check` DB CHECK and
 * the server's `assertEntityInvariants`); these pure helpers let
 * logic-level callers check first without I/O.
 *
 * `isTransferPayee` (defined in `rename-rules.js`) is reused here, not
 * duplicated. It is imported for internal use only and deliberately not
 * re-exported: `index.ts` barrels both this module and `rename-rules.js`
 * via `export *`, so a second export of the same name would make the
 * barrel name ambiguous and drop it.
 */

/**
 * Input shape for {@link validateTransferEligibility}. A subset of
 * `Transaction` plus resolved context the row alone cannot carry:
 *
 *   - `isSplitParent`: whether other rows reference this row as `parentId`
 *     (see `isSplitParent` in `split.js`). A split parent carrying its own
 *     transfer leg is never valid — a split's transfer legs live on its
 *     children.
 *   - `srcOnBudget` / `destOnBudget`: budget-boundary sides of the source
 *     and destination accounts. Needed only for the same-boundary category
 *     check; omit them when the caller has no account data and that check
 *     is skipped.
 */
export interface TransferEligibilityInput {
  accountId: number;
  transferAccountId?: number | null;
  categoryId?: number | null;
  payee?: string | null;
  parentId?: number | null;
  isSplitParent?: boolean;
  srcOnBudget?: boolean | null;
  destOnBudget?: boolean | null;
}

/**
 * Payee/leg consistency: YNAB4 derives a transfer's payee from its target
 * account (`Transfer : <account>`), so a transfer-styled payee with no
 * transfer leg is orphaned metadata and always a caller bug.
 *
 * The reverse direction is allowed: a transfer leg may carry free-text
 * payee (the server derives `Transfer : <name>` only when the payee is
 * empty), so this function does not constrain transfer-row payees.
 *
 * Throws via `errorFactory` (default: `TransactionError`, an HTTP 4xx).
 */
export function validateTransferPayeeConsistency(
  payee: string | null | undefined,
  transferAccountId: number | null | undefined,
  errorFactory: (message: string) => Error = (msg) => new TransactionError(msg, 400)
): void {
  if (transferAccountId == null && payee != null && isTransferPayee(payee)) {
    throw errorFactory("transfer payee requires a transferAccountId");
  }
}

/**
 * Throw unless the input is an eligible transfer (or a non-transfer row
 * with consistent payee/leg fields).
 *
 * Rules, in order:
 *   1. Payee/leg consistency (see {@link validateTransferPayeeConsistency}).
 *   2. Non-transfer rows (`transferAccountId == null`) pass after rule 1.
 *   3. Self-transfer (`accountId === transferAccountId`) throws — YNAB4's
 *      `checkAccountDoesntConflictWithTransferAccount`.
 *   4. Split-parent-as-transfer (`isSplitParent === true`) throws — a split
 *      parent cannot itself be a transfer; transfer legs live on children.
 *      Split *children* that are transfer legs (`parentId != null` with a
 *      leg set) are legitimate and pass.
 *   5. Same-boundary transfer carrying a category throws — YNAB4's
 *      BaseTransaction NeedsCategory/Error invariants: on-budget↔on-budget
 *      (and off↔off) moves carry no category; the spending is captured by
 *      the terminal categorized rows. Enforced only when both boundary
 *      sides are provided.
 *
 * Boundary direction rules (outflow requires a category, inflow without
 * one is income) are NOT duplicated here — {@link classifyBoundaryTransfer}
 * already enforces them. Compose the two: validate eligibility, then
 * classify.
 *
 * Throws via `errorFactory` (default: `TransactionError`, an HTTP 4xx).
 */
export function validateTransferEligibility(
  input: TransferEligibilityInput,
  errorFactory: (message: string) => Error = (msg) => new TransactionError(msg, 400)
): void {
  validateTransferPayeeConsistency(input.payee, input.transferAccountId, errorFactory);

  const transferAccountId = input.transferAccountId ?? null;
  if (transferAccountId == null) return;

  if (transferAccountId === input.accountId) {
    throw errorFactory("transfer account must differ from source account");
  }

  if (input.isSplitParent === true) {
    throw errorFactory("Split transaction cannot be a transfer");
  }

  if (
    input.srcOnBudget != null &&
    input.destOnBudget != null &&
    input.srcOnBudget === input.destOnBudget &&
    input.categoryId != null
  ) {
    throw errorFactory("internal transfer cannot have a category");
  }
}

/**
 * Boolean counterpart to {@link validateTransferEligibility}: true when
 * the input passes all eligibility rules, false otherwise. Never throws.
 */
export function isTransferEligible(input: TransferEligibilityInput): boolean {
  try {
    validateTransferEligibility(input);
    return true;
  } catch {
    return false;
  }
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
