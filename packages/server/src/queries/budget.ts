import { asc, desc, sql } from "drizzle-orm";
import type { BudgetData } from "@ynab/logic";
import type { Database } from "../client.js";
import { accounts, assignments, categoryGroups, categories, recurring, transactions } from "../schema.js";

export async function getBudgetData(db: Database): Promise<BudgetData> {
  const [accts, groups, cats, assigns, txns, recur] = await Promise.all([
    db.select().from(accounts).orderBy(asc(accounts.sort)),
    db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort)),
    db.select().from(categories).orderBy(asc(categories.sort)),
    db.select().from(assignments),
    db.select().from(transactions).orderBy(desc(transactions.date), desc(transactions.id)),
    db.select().from(recurring).orderBy(asc(recurring.nextDate)),
  ]);

  return {
    accounts: accts.map((a) => ({ ...a, kind: a.kind as "liquid" | "credit" | "offbudget" })),
    groups,
    categories: cats,
    assignments: assigns,
    transactions: txns.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
    recurring: recur,
  };
}

export async function isSeeded(db: Database): Promise<boolean> {
  const rows = await db.execute<{ count: string }>(
    sql`select count(*)::int as count from ${accounts}`
  );
  const count = Number(rows.rows[0]?.count ?? 0);
  return count > 0;
}
