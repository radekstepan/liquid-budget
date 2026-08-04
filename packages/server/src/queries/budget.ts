import { asc, desc, sql } from "drizzle-orm";
import type { BudgetData } from "@ynab/logic";
import type { Db } from "../client.js";
import { accounts, assignments, categoryGroups, categories, recurring, recurringSubTransactions, transactions } from "../schema.js";

export async function getBudgetData(db: Db): Promise<BudgetData> {
  const [accts, groups, cats, assigns, txns, recur, recurSubs] = await Promise.all([
    db.select().from(accounts).orderBy(asc(accounts.sort)),
    db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort)),
    db.select().from(categories).orderBy(asc(categories.sort)),
    db.select().from(assignments),
    db.select().from(transactions).orderBy(desc(transactions.date), desc(transactions.id)),
    db.select().from(recurring).orderBy(asc(recurring.nextDate)),
    db.select().from(recurringSubTransactions).orderBy(asc(recurringSubTransactions.sort), asc(recurringSubTransactions.id)),
  ]);

  return {
    accounts: accts.map((a) => ({
      ...a,
      kind: a.kind as "liquid" | "credit" | "offbudget",
      // SQLite stores real as number; logic types expect string
      balance: String(a.balance),
    })),
    groups,
    categories: cats.map((c) => ({
      ...c,
      carryover: String(c.carryover),
      goalTarget: c.goalTarget != null ? String(c.goalTarget) : null,
    })),
    assignments: assigns.map((a) => ({ ...a, amount: String(a.amount) })),
    transactions: txns.map((t) => ({
      ...t,
      amount: String(t.amount),
      // createdAt is already a text string in SQLite
      createdAt: t.createdAt,
    })),
    recurring: recur.map((r) => ({
      ...r,
      amount: String(r.amount),
      subTransactions: recurSubs
        .filter((s) => s.recurringId === r.id)
        .map((s) => ({ ...s, amount: String(s.amount) })),
    })),
  };
}

export async function isSeeded(db: Db): Promise<boolean> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(accounts);
  return Number(rows[0]?.count ?? 0) > 0;
}
