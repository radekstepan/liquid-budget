import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { accounts, transactions } from "../schema.js";
import { withTransaction } from "../transaction.js";
import { getBudgetData } from "./budget.js";
import { computeBudget, getMonthsWithData, isIncomeTransaction, todayISO } from "@ynab/logic";

export type BalanceIntegrityReport = {
  accountId: number;
  accountName: string;
  storedBalance: number;
  computedBalance: number;
  difference: number;
};

export type BudgetIntegrityReport = {
  totalOnBudgetAccountBalance: number;
  totalCategoryAvailable: number;
  tbb: number;
  /** accountBalances - categoryBalances - tbb; should be 0 */
  difference: number;
  month: string;
};

export type StorageIntegrityReport = {
  /** true when `PRAGMA integrity_check` returns exactly one "ok" row */
  ok: boolean;
  /** corruption detail lines, capped (empty when ok) */
  errors: string[];
};

const MAX_STORAGE_ERROR_LINES = 5;
const MAX_STORAGE_ERROR_CHARS = 300;

/**
 * Parse raw `PRAGMA integrity_check` rows into a report. Pure (no I/O) so
 * corruption shapes are unit-testable without a corrupt database file.
 */
export function parseIntegrityCheckRows(rows: unknown): StorageIntegrityReport {
  const values = (
    Array.isArray(rows) ? rows : []
  ).map((r) =>
    typeof r === "string" ? r : String(Object.values(r as Record<string, unknown>)[0] ?? "")
  );
  const ok = values.length === 1 && values[0]!.toLowerCase() === "ok";
  return {
    ok,
    errors: ok
      ? []
      : values.slice(0, MAX_STORAGE_ERROR_LINES).map((v) => v.slice(0, MAX_STORAGE_ERROR_CHARS)),
  };
}

/**
 * Run SQLite's `PRAGMA integrity_check` against the live database. Read-only
 * and fast for this workload (single-user budgets are a few MB at most); both
 * diagnostics endpoints surface the result as `storage` alongside their
 * domain checks so page-cache corruption is caught before it silently skews
 * balances. Corrupt pages make most domain reads throw first, so a failing
 * `storage.ok` with a 200 domain result means "page-level fault, domain math
 * still computed" — treat any `ok: false` as stop-and-restore-from-snapshot.
 */
export async function checkStorageIntegrity(db: Database): Promise<StorageIntegrityReport> {
  const rows = db.$client.prepare("PRAGMA integrity_check").all();
  return parseIntegrityCheckRows(rows);
}

/**
 * Audit all accounts in the database and verify that `account.balance` equals
 * the sum of all direct transaction amounts minus incoming transfer amounts
 * (excluding split parent rows which are non-balance bearing).
 */
export async function verifyBalanceIntegrity(db: Database): Promise<BalanceIntegrityReport[]> {
  const allAccounts = await db.select().from(accounts);
  const issues: BalanceIntegrityReport[] = [];

  for (const acct of allAccounts) {
    const outRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, acct.id),
          sql`${transactions.id} NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`
        )
      );

    const inRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.transferAccountId, acct.id),
          isNotNull(transactions.transferAccountId),
          sql`${transactions.id} NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`
        )
      );

    const outgoing = Number(outRes[0]?.sum ?? 0);
    const incomingFromTransfers = Number(inRes[0]?.sum ?? 0);
    const computedBalance = outgoing - incomingFromTransfers;
    const storedBalance = Number(acct.balance ?? 0);

    if (computedBalance !== storedBalance) {
      issues.push({
        accountId: acct.id,
        accountName: acct.name,
        storedBalance,
        computedBalance,
        difference: storedBalance - computedBalance,
      });
    }
  }

  return issues;
}

/**
 * Recompute every account's `balance` from the current set of transactions
 * and update the accounts table atomically inside a transaction.
 */
export async function recomputeAccountBalances(
  db: Database
): Promise<{ updatedCount: number }> {
  return withTransaction(db, async () => {
    const rows = await db.all<{ id: number; stored_balance: number; computed_balance: number }>(
      sql`
        SELECT
          a.id,
          a.balance AS stored_balance,
          (
            COALESCE((
              SELECT SUM(t.amount)
              FROM transactions t
              WHERE t.account_id = a.id
                AND t.id NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)
            ), 0)
            -
            COALESCE((
              SELECT SUM(t.amount)
              FROM transactions t
              WHERE t.transfer_account_id = a.id
                AND t.transfer_account_id IS NOT NULL
                AND t.id NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)
            ), 0)
          ) AS computed_balance
        FROM accounts a
      `
    );

    let updatedCount = 0;
    for (const row of rows) {
      const stored = Number(row.stored_balance ?? 0);
      const computed = Number(row.computed_balance ?? 0);
      if (stored !== computed) {
        await db
          .update(accounts)
          .set({ balance: computed })
          .where(eq(accounts.id, row.id));
        updatedCount++;
      }
    }

    return { updatedCount };
  });
}

/**
 * Verify the YNAB4 fundamental invariant:
 *   sum(on-budget account balances) - sum(category available balances) - TBB === 0
 *
 * This is the core identity that must hold for the budget to be internally
 * consistent. If this invariant is violated, TBB will be silently wrong.
 *
 * Evaluates at the latest month with data (or today's month, whichever is later)
 * by default, or at an explicit `targetMonth` with date-bounded account balances,
 * avoiding false positives from deferred income or future-dated transactions.
 */
export async function verifyBudgetIntegrity(
  db: Database,
  targetMonth?: string
): Promise<BudgetIntegrityReport> {
  const data = await getBudgetData(db);
  const todayMonth = todayISO().slice(0, 7);
  const months = getMonthsWithData(data);
  const latestMonth = months.reduce(
    (max, m) => (m > max ? m : max),
    todayMonth
  );
  const month = targetMonth ?? latestMonth;
  const result = computeBudget(data, month);

  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));
  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const onBudgetAccounts = data.accounts.filter((a) => a.onBudget);
  let totalAccountBalance = onBudgetAccounts.reduce(
    (s, a) => s + Number(a.balance ?? 0),
    0
  );

  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;

    const accA = accountMap.get(t.accountId);
    const onA = accA ? accA.onBudget : true;

    let netOnBudgetDelta = 0;
    if (t.transferAccountId != null) {
      const accB = accountMap.get(t.transferAccountId);
      const onB = accB ? accB.onBudget : true;
      netOnBudgetDelta = (onA ? Number(t.amount) : 0) + (onB ? -Number(t.amount) : 0);
    } else {
      netOnBudgetDelta = onA ? Number(t.amount) : 0;
    }

    if (netOnBudgetDelta === 0) continue;

    const isIncome = isIncomeTransaction(t, accountMap);
    const effectiveMonth = isIncome ? (t.incomeMonth || t.date.slice(0, 7)) : t.date.slice(0, 7);

    if (effectiveMonth > month) {
      totalAccountBalance -= netOnBudgetDelta;
    }
  }

  const totalCategoryAvailable = result.groups.reduce(
    (s, g) => s + g.available,
    0
  );

  // Unfunded CC spending creates debt on the card without moving cash into
  // the CC Payment category. In the spending month the negative category
  // available offsets the card debt in the invariant. In subsequent months the
  // negative is clamped to zero (no cash carryover), leaving the card debt
  // unmatched. We compute the portion of CC debt that is not covered by negative
  // category balances, and add it to the account side so the invariant holds:
  //
  //   unmatchedCCDebt = max(0, totalCCDebt - negativeCategorySum)
  //   diff = totalAccountBalance + unmatchedCCDebt - totalCategoryAvailable - TBB
  const ccAccounts = onBudgetAccounts.filter((a) => a.kind === "credit");
  const totalCCDebt = ccAccounts.reduce(
    (s, a) => s + Math.max(0, -Number(a.balance ?? 0)),
    0
  );
  const negativeCategorySum = result.groups.reduce(
    (s, g) => s + Math.max(0, -g.available),
    0
  );
  const unmatchedCCDebt = Math.max(0, totalCCDebt - negativeCategorySum);

  const difference = Math.round(
    totalAccountBalance + unmatchedCCDebt - totalCategoryAvailable - result.tbb
  );

  return {
    totalOnBudgetAccountBalance: totalAccountBalance,
    totalCategoryAvailable,
    tbb: result.tbb,
    difference,
    month,
  };
}
