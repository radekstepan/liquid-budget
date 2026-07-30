export type Account = {
  id: number;
  name: string;
  kind: "liquid" | "credit" | "offbudget";
  groupLabel: string;
  balance: string;
  onBudget: boolean;
  sort: number;
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
};

export type Assignment = {
  id: number;
  categoryId: number;
  month: string;
  amount: string;
};

export type Transaction = {
  id: number;
  accountId: number;
  categoryId: number | null;
  date: string;
  payee: string;
  memo: string;
  amount: string;
  cleared: boolean;
  createdAt?: string;
};

export type Recurring = {
  id: number;
  accountId: number;
  categoryId: number | null;
  payee: string;
  amount: string;
  frequency: string;
  nextDate: string;
  active: boolean;
};

export type BudgetData = {
  accounts: Account[];
  groups: CategoryGroup[];
  categories: Category[];
  assignments: Assignment[];
  transactions: Transaction[];
  recurring: Recurring[];
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
  /** Total assigned across all non-CC groups this month. */
  totalAssigned: number;
};
