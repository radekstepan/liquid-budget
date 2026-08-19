import { eq, sql } from "drizzle-orm";
import type { CsvImportRow, ImportSkippedEntry } from "@ynab/logic";
import { duplicateFingerprint } from "@ynab/logic";
import type { Db } from "./client.js";
import { accounts, categories, transactions } from "./schema.js";
import { TransactionError } from "./queries/transactions.js";

export type ImportCsvInput = {
  accountId: number;
  rows: CsvImportRow[];
};

export type ImportCsvResult = {
  count: number;
  skipped: ImportSkippedEntry[];
};

export async function importCsvTransactions(db: Db, input: ImportCsvInput): Promise<ImportCsvResult> {
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

  // Build a fingerprint set from existing plain regular transactions in
  // this account so re-importing a statement never doubles the rows.
  // Split parents, split children, and transfers are excluded (their
  // amounts/payees are shared across legitimate rows).
  const existingTx = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      date: transactions.date,
      payee: transactions.payee,
      memo: transactions.memo,
      amount: transactions.amount,
      parentId: transactions.parentId,
      transferAccountId: transactions.transferAccountId,
    })
    .from(transactions)
    .where(eq(transactions.accountId, input.accountId));
  const childIds = new Set<number>();
  for (const t of existingTx) {
    if (t.parentId != null) childIds.add(t.parentId);
  }
  const existingFingerprints = new Set<string>();
  for (const t of existingTx) {
    if (t.parentId != null || t.transferAccountId != null || childIds.has(t.id)) continue;
    existingFingerprints.add(
      duplicateFingerprint({
        accountId: t.accountId,
        date: t.date,
        payee: t.payee,
        memo: t.memo,
        amount: t.amount,
      })
    );
  }

  db.run(sql`BEGIN`);
  try {
    const created: number[] = [];
    const skipped: ImportSkippedEntry[] = [];
    // First occurrence of a fingerprint in this batch -> source row number.
    const batchSeen = new Map<string, number>();
    for (const row of rows) {
      const amount = Math.round(row.amountCents!);
      if (amount === 0) {
        throw new TransactionError(`Row ${row.rowNumber}: amount must be non-zero`);
      }
      const fp = duplicateFingerprint({
        accountId: input.accountId,
        date: row.date!,
        payee: row.payee ?? "",
        memo: row.memo ?? "",
        amount,
      });
      const matchRowNumber = batchSeen.get(fp);
      if (existingFingerprints.has(fp) || matchRowNumber != null) {
        skipped.push({
          rowNumber: row.rowNumber,
          accountName: account.name,
          date: row.date!,
          payee: row.payee ?? "",
          memo: row.memo ?? "",
          amount,
          reason:
            matchRowNumber != null
              ? `Duplicate of row ${matchRowNumber} in this file`
              : "Matches an existing transaction",
          matchRowNumber,
        });
        continue;
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
      batchSeen.set(fp, row.rowNumber);
      existingFingerprints.add(fp);
      await db
        .update(accounts)
        .set({ balance: sql`${accounts.balance} + ${amount}` })
        .where(eq(accounts.id, input.accountId));
    }
    db.run(sql`COMMIT`);
    return { count: created.length, skipped };
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}