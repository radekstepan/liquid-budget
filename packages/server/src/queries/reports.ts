import { TransactionError } from "@ynab/logic";
import type { Db } from "../client.js";

export type CategoryOutflowRow = {
  /** "YYYY-MM" of the transaction date. */
  month: string;
  /** Null = uncategorized outflow (cash-flow relevant, budget-irrelevant). */
  categoryId: number | null;
  /** SUM of net on-budget deltas (negative = spending, positive = refund). */
  total: number;
};

export type IncomeRow = {
  /** Transaction month: substr(date, 1, 7) — the cash-flow grouping. */
  month: string;
  /** Budget month: COALESCE(income_month, month) — the TBB grouping. */
  incomeMonth: string;
  total: number;
};

export type AccountDeltaRow = {
  /** "YYYY-MM" of the transaction date. */
  month: string;
  accountId: number;
  total: number;
};

export type ReportAggregates = {
  outflow: CategoryOutflowRow[];
  income: IncomeRow[];
  accountDeltas: AccountDeltaRow[];
};

export type ReportAggregatesInput = {
  startMonth?: string;
  endMonth?: string;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function validateMonth(value: string | undefined, name: string): void {
  if (value !== undefined && !MONTH_RE.test(value)) {
    throw new TransactionError(`Invalid ${name} (expected YYYY-MM)`, 400);
  }
}

/**
 * SQL group-bys for the report layer (P1 sql-aggregation).
 *
 * The pure `compute*` fns in `@ynab/logic` scan the full transaction list
 * in JS. On a large budget that means hydrating every row on each
 * navigation just to sum month x category. These three queries push the
 * group-bys into SQLite (`SUM ... GROUP BY substr(date,1,7)`) so report
 * screens can fetch O(months x categories) rows instead of O(transactions).
 * The logic fns stay as the fallback for small budgets / offline bundles.
 *
 * Boundary semantics mirror `budget-engine.ts` exactly:
 * - split parents (rows referenced as `parent_id`) are excluded, except an
 *   explicitly income-flagged parent still counts as income;
 * - net on-budget delta = (srcOnBudget ? amt : 0) + (dstOnBudget ? -amt : 0);
 * - internal transfers (both legs on-budget) carry no budget impact;
 * - income = uncategorized rows where the boundary classification is income
 *   (transfers: crossing && net > 0; plain rows: trusted `is_income` flag
 *   with on-budget source and positive amount, matching the write path).
 */

function normalizeRange(input: ReportAggregatesInput): ReportAggregatesInput {
  const { startMonth, endMonth } = input;
  if (startMonth !== undefined && endMonth !== undefined && startMonth > endMonth) {
    return { startMonth: endMonth, endMonth: startMonth };
  }
  return input;
}

function monthFilter(
  dateExpr: string,
  input: ReportAggregatesInput,
  params: (string | number)[]
): string {
  const clauses: string[] = [];
  if (input.startMonth !== undefined) {
    clauses.push(`${dateExpr} >= ?`);
    params.push(input.startMonth);
  }
  if (input.endMonth !== undefined) {
    clauses.push(`${dateExpr} <= ?`);
    params.push(input.endMonth);
  }
  return clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
}

const SPLIT_PARENT_EXCLUSION =
  `NOT EXISTS (SELECT 1 FROM transactions p WHERE p.parent_id = t.id)`;

const NET_EXPR = `((CASE WHEN COALESCE(src.on_budget, 1) THEN t.amount ELSE 0 END) + (CASE WHEN t.transfer_account_id IS NULL THEN 0 WHEN COALESCE(dst.on_budget, 1) THEN -t.amount ELSE 0 END))`;

const IS_INTERNAL =
  `(t.transfer_account_id IS NOT NULL AND COALESCE(src.on_budget, 1) = 1 AND COALESCE(dst.on_budget, 1) = 1)`;

/** True for rows the read path classifies as income (see module doc). */
const IS_INCOME = `(
  t.category_id IS NULL AND (
    (t.transfer_account_id IS NOT NULL
      AND COALESCE(src.on_budget, 1) != COALESCE(dst.on_budget, 1)
      AND ${NET_EXPR} > 0)
    OR (t.transfer_account_id IS NULL
      AND COALESCE(src.on_budget, 1) = 1
      AND t.amount > 0
      AND t.is_income = 1)
  )
)`;

export async function getMonthlyCategoryOutflow(
  db: Db,
  input: ReportAggregatesInput = {}
): Promise<CategoryOutflowRow[]> {
  const range_input = normalizeRange(input);
  validateMonth(range_input.startMonth, "startMonth");
  validateMonth(range_input.endMonth, "endMonth");
  const params: (string | number)[] = [];
  const range = monthFilter(`substr(t.date, 1, 7)`, range_input, params);
  const rows = db.$client
    .prepare(
      `SELECT substr(t.date, 1, 7) AS month, t.category_id AS categoryId,
              SUM(${NET_EXPR}) AS total
       FROM transactions t
       LEFT JOIN accounts src ON src.id = t.account_id
       LEFT JOIN accounts dst ON dst.id = t.transfer_account_id
       WHERE ${SPLIT_PARENT_EXCLUSION}
         AND NOT ${IS_INTERNAL}
         AND ${NET_EXPR} != 0
         AND NOT ${IS_INCOME}${range}
       GROUP BY month, t.category_id
       ORDER BY month ASC, t.category_id ASC`
    )
    .all(...params) as { month: string; categoryId: number | null; total: number }[];
  return rows.map((r) => ({ month: r.month, categoryId: r.categoryId, total: Number(r.total) }));
}

export async function getMonthlyIncome(
  db: Db,
  input: ReportAggregatesInput = {}
): Promise<IncomeRow[]> {
  const range_input = normalizeRange(input);
  validateMonth(range_input.startMonth, "startMonth");
  validateMonth(range_input.endMonth, "endMonth");
  // A deferred row (txn month M, income month N) is needed by cash flow
  // under M and by TBB under N, so the range keeps rows matching either.
  const params: (string | number)[] = [];
  const rangeClauses: string[] = [];
  if (range_input.startMonth !== undefined) {
    rangeClauses.push(`(substr(t.date, 1, 7) >= ? OR COALESCE(t.income_month, substr(t.date, 1, 7)) >= ?)`);
    params.push(range_input.startMonth, range_input.startMonth);
  }
  if (range_input.endMonth !== undefined) {
    rangeClauses.push(`(substr(t.date, 1, 7) <= ? OR COALESCE(t.income_month, substr(t.date, 1, 7)) <= ?)`);
    params.push(range_input.endMonth, range_input.endMonth);
  }
  const range = rangeClauses.length > 0 ? ` AND ${rangeClauses.join(" AND ")}` : "";
  const rows = db.$client
    .prepare(
      `SELECT substr(t.date, 1, 7) AS month,
              COALESCE(t.income_month, substr(t.date, 1, 7)) AS incomeMonth,
              SUM(CASE WHEN t.transfer_account_id IS NOT NULL THEN ${NET_EXPR} ELSE t.amount END) AS total
       FROM transactions t
       LEFT JOIN accounts src ON src.id = t.account_id
       LEFT JOIN accounts dst ON dst.id = t.transfer_account_id
       WHERE (${SPLIT_PARENT_EXCLUSION} OR t.is_income = 1)
         AND ${IS_INCOME}${range}
       GROUP BY month, incomeMonth
       ORDER BY month ASC, incomeMonth ASC`
    )
    .all(...params) as { month: string; incomeMonth: string; total: number }[];
  return rows.map((r) => ({ month: r.month, incomeMonth: r.incomeMonth, total: Number(r.total) }));
}

export async function getMonthlyAccountDeltas(
  db: Db,
  input: ReportAggregatesInput = {}
): Promise<AccountDeltaRow[]> {
  const range_input = normalizeRange(input);
  validateMonth(range_input.startMonth, "startMonth");
  validateMonth(range_input.endMonth, "endMonth");
  const params: (string | number)[] = [];
  const range = monthFilter(`month`, range_input, params);
  const rows = db.$client
    .prepare(
      `SELECT month, accountId AS accountId, SUM(delta) AS total FROM (
         SELECT substr(t.date, 1, 7) AS month, t.account_id AS accountId, t.amount AS delta
         FROM transactions t
         WHERE ${SPLIT_PARENT_EXCLUSION}
         UNION ALL
         SELECT substr(t.date, 1, 7) AS month, t.transfer_account_id AS accountId, -t.amount AS delta
         FROM transactions t
         WHERE t.transfer_account_id IS NOT NULL AND ${SPLIT_PARENT_EXCLUSION}
       )
       WHERE 1 = 1${range}
       GROUP BY month, accountId
       ORDER BY month ASC, accountId ASC`
    )
    .all(...params) as { month: string; accountId: number; total: number }[];
  return rows.map((r) => ({ month: r.month, accountId: r.accountId, total: Number(r.total) }));
}

export async function getReportAggregates(
  db: Db,
  input: ReportAggregatesInput = {}
): Promise<ReportAggregates> {
  const [outflow, income, accountDeltas] = await Promise.all([
    getMonthlyCategoryOutflow(db, input),
    getMonthlyIncome(db, input),
    getMonthlyAccountDeltas(db, input),
  ]);
  return { outflow, income, accountDeltas };
}
