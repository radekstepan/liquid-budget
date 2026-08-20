import { asc, desc, sql } from "drizzle-orm";
import type { BudgetData, ClearedStatus, TransactionFlagColor } from "@ynab/logic";
import { buildBudgetIndex, TRANSACTION_FLAG_COLORS } from "@ynab/logic";
import type { Db } from "../client.js";
import { accounts, assignments, categoryGroups, categories, recurring, recurringSubTransactions, transactions } from "../schema.js";

export async function getBudgetData(
  db: Db,
  options?: { limitTransactions?: number }
): Promise<BudgetData> {
  const [accts, groups, cats, assigns, txns, recur, recurSubs] = await Promise.all([
    db.select().from(accounts).orderBy(asc(accounts.sort)),
    db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort)),
    db.select().from(categories).orderBy(asc(categories.sort)),
    db.select().from(assignments),
    options?.limitTransactions != null
      ? db
          .select()
          .from(transactions)
          .orderBy(desc(transactions.date), desc(transactions.id))
          .limit(options.limitTransactions)
      : db
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
    transactions: txns.map((t) => ({
      ...t,
      amount: String(t.amount),
      status: (t.status as ClearedStatus) ?? "c",
      // createdAt is already a text string in SQLite
      createdAt: t.createdAt,
      isIncome: Boolean(t.isIncome),
      reconciledAt: t.reconciledAt,
      // Sanitize any flag_color read from the DB so a rogue value never
      // reaches the UI.
      flagColor: (TRANSACTION_FLAG_COLORS as readonly string[]).includes(String(t.flagColor))
        ? (t.flagColor as TransactionFlagColor)
        : null,
    })),
    recurring: recur.map((r) => ({
      ...r,
      amount: String(r.amount),
      subTransactions: (subsByRecurringId.get(r.id) ?? []).map((s) => ({
        ...s,
        amount: String(s.amount),
      })),
    })),
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
