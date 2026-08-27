import { eq, or, sql } from "drizzle-orm";
import type { CsvImportRow, ImportSkippedEntry } from "@ynab/logic";
import { applyRenameRules, buildExistingImportFingerprints, duplicateFingerprint } from "@ynab/logic";
import type { Db } from "./client.js";
import { withTransaction } from "./transaction.js";
import { accounts, categories, transactions } from "./schema.js";
import { TransactionError } from "./queries/transactions.js";
import { getRenameRules } from "./queries/rename-rules.js";

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
  const allAccounts = await db.select({ id: accounts.id, name: accounts.name }).from(accounts);
  const accountNameById = new Map(allAccounts.map((a) => [a.id, a.name]));

  const categoryRows = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories);
  const categoryByName = new Map<string, number>();
  for (const c of categoryRows) {
    const key = c.name.trim().toLowerCase();
    if (!categoryByName.has(key)) categoryByName.set(key, c.id);
  }
  // Automatic payee rename rules are applied to every incoming row before
  // duplicate detection and insertion, so re-importing a bank statement
  // produces clean, consistent payee names.
  const renameRules = getRenameRules(db);

  // Build a fingerprint set from existing transactions in this account so
  // re-importing a statement never doubles rows. Top-level plain transactions,
  // split parents, and transfers are included.
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
    .where(
      or(
        eq(transactions.accountId, input.accountId),
        eq(transactions.transferAccountId, input.accountId)
      )
    );

  const existingFingerprints = buildExistingImportFingerprints(
    input.accountId,
    existingTx,
    accountNameById
  );

  return withTransaction(db, async () => {
    const created: number[] = [];
    const skipped: ImportSkippedEntry[] = [];
    // First occurrence of a fingerprint in this batch -> source row number.
    const batchSeen = new Map<string, number>();
    for (const rawRow of input.rows) {
      if (rawRow.error || rawRow.date == null || rawRow.amountCents == null || !rawRow.payee?.trim()) {
        skipped.push({
          rowNumber: rawRow.rowNumber,
          accountName: account.name,
          date: rawRow.date ?? "",
          payee: rawRow.payee ?? "",
          memo: rawRow.memo ?? "",
          amount: rawRow.amountCents != null ? Math.round(rawRow.amountCents) : 0,
          reason:
            rawRow.error ||
            (!rawRow.date
              ? "Invalid date"
              : rawRow.amountCents == null
                ? "Invalid amount"
                : !rawRow.payee?.trim()
                  ? "Missing payee"
                  : "Invalid row"),
        });
        continue;
      }
      const row = {
        ...rawRow,
        payee: applyRenameRules(renameRules, rawRow.payee ?? ""),
      };
      const amount = Math.round(row.amountCents!);
      if (amount === 0) {
        skipped.push({
          rowNumber: row.rowNumber,
          accountName: account.name,
          date: row.date!,
          payee: row.payee ?? "",
          memo: row.memo ?? "",
          amount: 0,
          reason: "Amount is zero",
        });
        continue;
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
      const categoryId = account.onBudget && row.category
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
    return { count: created.length, skipped };
  });
}