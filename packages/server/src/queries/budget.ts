import { asc, desc, sql } from "drizzle-orm";
import type { BudgetData } from "@ynab/logic";
import { buildBudgetIndex } from "@ynab/logic";
import type { Db } from "../client.js";
import { accounts, assignments, categoryGroups, categories, recurring, recurringSubTransactions, transactions } from "../schema.js";
import { sanitizeFlagColor, serializeTransactionRow } from "./transactions.js";
import { getRenameRules } from "./rename-rules.js";
import { getPayees } from "./payees.js";

export async function getBudgetData(db: Db): Promise<BudgetData> {
  // Report group-bys live in SQL now (queries/reports.ts: getReportAggregates,
  // SUM/GROUP BY month+category). The full transaction fan-out below stays
  // for the register/budget engine; report screens on large budgets should
  // page rows via listTransactionsPage (?accountId&before&limit) and fetch
  // O(months x categories) aggregates via GET /api/reports instead.
  const [accts, groups, cats, assigns, txns, recur, recurSubs] = await Promise.all([
    db.select().from(accounts).orderBy(asc(accounts.sort)),
    db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort)),
    db.select().from(categories).orderBy(asc(categories.sort)),
    db.select().from(assignments),
    db
      .select()
      .from(transactions)
      .orderBy(desc(transactions.date), desc(transactions.id)),
    db.select().from(recurring).orderBy(asc(recurring.nextDate)),
    db
      .select()
      .from(recurringSubTransactions)
      .orderBy(asc(recurringSubTransactions.sort), asc(recurringSubTransactions.id)),
  ]);

  // Group recurring sub-transactions by recurringId in O(M) time
  const subsByRecurringId = new Map<number, (typeof recurSubs[number])[]>();
  for (const s of recurSubs) {
    const list = subsByRecurringId.get(s.recurringId);
    if (list) {
      list.push(s);
    } else {
      subsByRecurringId.set(s.recurringId, [s]);
    }
  }

  const data: BudgetData = {
    accounts: accts.map((a) => ({
      ...a,
      kind: a.kind as "liquid" | "credit" | "offbudget",
      // SQLite stores real as number; logic types expect string
      balance: String(a.balance),
      lastReconciledBalance:
        a.lastReconciledBalance != null ? String(a.lastReconciledBalance) : null,
    })),
    groups,
    categories: cats.map((c) => ({
      ...c,
      carryover: String(c.carryover),
      goalTarget: c.goalTarget != null ? String(c.goalTarget) : null,
    })),
    assignments: assigns.map((a) => ({ ...a, amount: String(a.amount) })),
    transactions: txns.map(serializeTransactionRow),
    recurring: recur.map((r) => ({
      ...r,
      flagColor: sanitizeFlagColor(r.flagColor),
      memo: r.memo ?? "",
      amount: String(r.amount),
      subTransactions: (subsByRecurringId.get(r.id) ?? []).map((s) => ({
        ...s,
        amount: String(s.amount),
      })),
    })),
    renameRules: getRenameRules(db),
    payees: getPayees(db),
  };

  data.budgetIndex = buildBudgetIndex(data);
  return data;
}

export async function isSeeded(db: Db): Promise<boolean> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(accounts);
  return Number(rows[0]?.count ?? 0) > 0;
}
