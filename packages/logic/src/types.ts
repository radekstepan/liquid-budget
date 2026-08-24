export type Account = {
  id: number;
  name: string;
  kind: "liquid" | "credit" | "offbudget";
  groupLabel: string;
  balance: string;
  onBudget: boolean;
  sort: number;
  lastReconciledAt?: string | null;
  lastReconciledBalance?: number | string | null;
  archived?: boolean;
};

export type CategoryGroup = {
  id: number;
  name: string;
  sort: number;
  isCreditCardPayments: boolean;
};

export type Category = {
  id: number;
  groupId: number;
  name: string;
  sort: number;
  /**
   * Manually-entered starting balance for this category before the first
   * tracked month.  Acts as the seed carryover for cumulative calculations.
   */
  carryover: string;
  goalTarget: string | null;
  linkedAccountId: number | null;
  /**
   * YNAB4 "Red Arrow to the Right": when true, negative available balance
   * carries over into the next month as a negative starting balance, rather
   * than deducting from next month's TBB.
   */
  overspendCarriesOver?: boolean | null;
};

export type Assignment = {
  id: number;
  categoryId: number;
  month: string;
  amount: string;
};

/**
 * A transaction row.
 *
 * Three flavours, distinguished by which optional fields are set:
 *
 *   - Regular:   `parentId` and `transferAccountId` are both null.
 *   - Transfer:  `transferAccountId` is set; `categoryId` should be null.
 *                The row lives on the source account; the destination
 *                sees the same transfer via the `transferAccountId`
 *                linkage (no mirrored row).
 *   - Split:     `parentId` is null on the parent and set on each child.
 *                The parent's `amount` is informational (sum of
 *                children); only children contribute to account
 *                balances and to category outflows.
 */
/**
 * Cleared / Uncleared / Reconciled flag. YNAB4's tri-state:
 *   - "u" Uncleared: entered into the register but not yet seen on a bank statement.
 *   - "c" Cleared:    appeared on a bank statement; still mutable.
 *   - "r" Reconciled: matched to a specific statement date; locked.
 * Reconciled status is only set by the reconcile flow — direct
 * creation via the transaction modal always sets "c" or "u".
 */
export type ClearedStatus = "u" | "c" | "r";

/**
 * YNAB4's six flag colors, used to highlight transactions in the register.
 * Mirrors the colour names YNAB4 writes into its .ynab4 backup JSON
 * (`t.flag` = "Red" | "Orange" | "Yellow" | "Green" | "Blue" | "Purple").
 */
export type TransactionFlagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

/**
 * Internal flag marker the duplicate analyzer writes onto rows that match
 * another transaction. It is not part of the YNAB4 palette: the user can
 * never select it, but can switch away from it (to a color or to none).
 */
export type TransactionDuplicateFlag = "duplicate";

/** The full set of flag states a row can carry (read-side). */
export type TransactionFlagState = TransactionFlagColor | TransactionDuplicateFlag | null;

export type RenameRule = {
  id: number;
  sourcePattern: string;
  targetPayee: string;
  createdAt: string;
  updatedAt?: string | null;
};

export type Transaction = {
  id: number;
  accountId: number;
  categoryId: number | null;
  date: string;
  payee: string;
  memo: string;
  amount: string;
  status: ClearedStatus;
  /** YNAB4-style flag color, "duplicate", or null when the transaction is unflagged. */
  flagColor?: TransactionFlagState;
  createdAt?: string;
  parentId?: number | null;
  transferAccountId?: number | null;
  isIncome?: boolean;
  incomeMonth?: string | null;
  reconciledAt?: string | null;
};

export type BulkUpdateTransactionPatch = {
  status?: ClearedStatus;
  categoryId?: number | null;
  flagColor?: TransactionFlagColor | null;
  date?: string;
  payee?: string;
  memo?: string | null;
  amount?: number;
  accountId?: number;
  incomeMonth?: string | null;
};

export type SubTransaction = {
  /**
   * Nullable when the subtransaction is a transfer to another account.
   */
  categoryId: number | null;
  amount: number;
  memo?: string;
  transferAccountId?: number | null;
};

export type Recurring = {
  id: number;
  accountId: number;
  categoryId: number | null;
  payee: string;
  memo?: string;
  amount: string;
  frequency: string;
  nextDate: string;
  active: boolean;
  transferAccountId?: number | null;
  flagColor?: TransactionFlagColor | null;
};

export type RecurringSubTransaction = {
  id: number;
  recurringId: number;
  /**
   * Nullable to match the DB schema: `recurring_sub_transactions.category_id`
   * is `ON DELETE SET NULL` (mirroring `transactions.categoryId`) so that
   * deleting a category used in a recurring split does not crash with a FK
   * constraint violation — the sub-row simply becomes uncategorised.
   */
  categoryId: number | null;
  amount: string;
  memo: string;
  sort: number;
  transferAccountId?: number | null;
};

export type SerializedBudgetIndex = {
  assignedByMonth: Record<string, Record<string | number, number>>;
  assignedTotalByMonth: Record<string, number>;
  outflowByMonth: Record<string, Record<string | number, number>>;
  spendByAccountMonth: Record<string, Record<string | number, number>>;
  incomeByMonth: Record<string, number>;
  carryoverByMonth: Record<string, Record<string | number, number>>;
  overspentByMonth: Record<string, number>;
  surplusByMonth: Record<string, number>;
};

export type BudgetData = {
  accounts: Account[];
  groups: CategoryGroup[];
  categories: Category[];
  assignments: Assignment[];
  transactions: Transaction[];
  recurring: (Recurring & { subTransactions: RecurringSubTransaction[] })[];
  budgetIndex?: SerializedBudgetIndex;
  /**
   * Automatic payee rename rules applied to future CSV imports. Empty when
   * no rules have been learned or added.
   */
  renameRules?: RenameRule[];
};

export type CatRow = {
  category: Category;
  /** Available balance carried forward from the end of the previous month. */
  carryoverIn: number;
  /** Amount budgeted (assigned) to this category in the current month. */
  assigned: number;
  /**
   * Net outflow this month: min(0, rawOutflow).
   * Positive transactions in a category are clamped to 0 for display.
   */
  outflow: number;
  /**
   * CC payment categories only: the amount YNAB4 auto-transferred from
   * budget categories to cover credit card spending this month.
   * 0 for all non-CC-payment categories.
   */
  ccBuffer: number;
  /**
   * Running available balance: carryoverIn + assigned + rawOutflow + ccBuffer.
   * Can be negative if over-spent.
   */
  available: number;
  /**
   * 0–1 fraction of the goal (or assigned amount) that is funded.
   * 1 = fully funded, 0 = nothing funded.
   */
  fundedPct: number;
};

export type GroupRow = {
  group: CategoryGroup;
  rows: CatRow[];
  assigned: number;
  outflow: number;
  available: number;
};

/** Top-level result returned by computeBudget(). */
export type BudgetResult = {
  groups: GroupRow[];
  /**
   * To Be Budgeted: totalIncome − totalAssigned + priorSurplus.
   * Negative means you have assigned more than you earned — "over budgeted".
   */
  tbb: number;
  /** Sum of all uncategorised positive transactions in this month (income). */
  totalIncome: number;
  /** Positive TBB surplus accumulated from prior months and carried forward. */
  priorSurplus: number;
  /** true when tbb < 0 — you've assigned more than you received. */
  overBudgeted: boolean;
  /** Total assigned across all groups this month. */
  totalAssigned: number;
  /**
   * Cash overspending from the previous month that is deducted from this
   * month's TBB (already factored into priorSurplus). Only non-CC category
   * overspending is included; credit card overspending persists as debt within
   * the CC payment category.
   */
  overspentPrevious: number;
};
