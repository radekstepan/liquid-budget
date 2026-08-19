import { eq, sql } from "drizzle-orm";
import type { CsvImportRow } from "@ynab/logic";
import type { Db } from "./client.js";
import { accounts, categories, transactions } from "./schema.js";
import { TransactionError } from "./queries/transactions.js";

export type ImportCsvInput = {
  accountId: number;
  rows: CsvImportRow[];
};

export async function importCsvTransactions(db: Db, input: ImportCsvInput) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, input.accountId));
  if (!account) {
    throw new TransactionError("Account not found", 404);
  }
  const categoryRows = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories);
  const categoryByName = new Map<string, number>();
  for (const c of categoryRows) {
    const key = c.name.trim().toLowerCase();
    if (!categoryByName.has(key)) categoryByName.set(key, c.id);
  }
  const rows = input.rows.filter((r) => !r.error && r.date != null && r.amountCents != null);

  db.run(sql`BEGIN`);
  try {
    const created: number[] = [];
    for (const row of rows) {
      const amount = Math.round(row.amountCents!);
      if (amount === 0) {
        throw new TransactionError(`Row ${row.rowNumber}: amount must be non-zero`);
      }
      const categoryId = row.category
        ? (categoryByName.get(row.category.trim().toLowerCase()) ?? null)
        : null;
      const isIncome = categoryId == null && amount > 0 && !!account.onBudget;
      const [inserted] = await db
        .insert(transactions)
        .values({
          accountId: input.accountId,
          categoryId,
          date: row.date!,
          payee: row.payee ?? "",
          memo: row.memo ?? "",
          amount,
          status: "c",
          flagColor: null,
          transferAccountId: null,
          parentId: null,
          isIncome,
          incomeMonth: null,
        })
        .returning();
      created.push(inserted!.id);
      await db
        .update(accounts)
        .set({ balance: sql`${accounts.balance} + ${amount}` })
        .where(eq(accounts.id, input.accountId));
    }
    db.run(sql`COMMIT`);
    return { count: created.length };
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}