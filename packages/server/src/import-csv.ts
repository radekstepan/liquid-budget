import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import type { CsvImportRow, ImportSkippedEntry } from "@ynab/logic";
import { applyRenameRules, buildExistingImportFingerprints, duplicateFingerprint } from "@ynab/logic";
import type { Db } from "./client.js";
import { withTransaction } from "./transaction.js";
import { accounts, categories, categoryGroups, transactions } from "./schema.js";
import { TransactionError } from "./queries/transactions.js";
import { findOrCreatePayee, getPayeeByName, updatePayee } from "./queries/payees.js";
import { getRenameRules } from "./queries/rename-rules.js";

export type ImportCsvInput = {
  accountId: number;
  rows: CsvImportRow[];
};

export type ImportCsvResult = {
  count: number;
  skipped: ImportSkippedEntry[];
};

export type CategoryLookupItem = {
  id: number;
  name: string;
  groupName: string;
};

/**
 * Deterministically match a CSV category input against the budget categories.
 *
 * Matching priority:
 * 1. Exact match on category name across all groups (if unambiguous). If multiple
 *    categories in different groups share the exact name without a group prefix,
 *    it is considered ambiguous and resolves to null.
 * 2. Compound match with group qualification (e.g. "Group: Category",
 *    "Group / Category", "Group - Category"), tried exact-case then case-insensitive.
 * 3. Case-insensitive category name match (if unambiguous). If multiple categories
 *    match case-insensitively across groups, resolves to null.
 */
export function resolveImportCategory(
  rawInput: string | null | undefined,
  categoriesList: CategoryLookupItem[]
): number | null {
  if (!rawInput) return null;
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  // 1. Exact match on category name if unambiguous
  const exactCatMatches = categoriesList.filter((c) => c.name.trim() === trimmed);
  if (exactCatMatches.length === 1) {
    return exactCatMatches[0]!.id;
  }
  if (exactCatMatches.length > 1) {
    // Ambiguous: multiple categories in different groups share the exact name
    return null;
  }

  // 2. Compound match (Group: Category, Group / Category, Group - Category)
  const isCompoundExact = (c: CategoryLookupItem) => {
    const gn = c.groupName.trim();
    const cn = c.name.trim();
    return (
      trimmed === `${gn}: ${cn}` ||
      trimmed === `${gn}:${cn}` ||
      trimmed === `${gn} / ${cn}` ||
      trimmed === `${gn}/${cn}` ||
      trimmed === `${gn} - ${cn}`
    );
  };
  const compoundExactMatches = categoriesList.filter(isCompoundExact);
  if (compoundExactMatches.length === 1) {
    return compoundExactMatches[0]!.id;
  }
  if (compoundExactMatches.length > 1) {
    return null;
  }

  const trimmedLower = trimmed.toLowerCase();
  const isCompoundCI = (c: CategoryLookupItem) => {
    const gn = c.groupName.trim().toLowerCase();
    const cn = c.name.trim().toLowerCase();
    return (
      trimmedLower === `${gn}: ${cn}` ||
      trimmedLower === `${gn}:${cn}` ||
      trimmedLower === `${gn} / ${cn}` ||
      trimmedLower === `${gn}/${cn}` ||
      trimmedLower === `${gn} - ${cn}`
    );
  };
  const compoundCIMatches = categoriesList.filter(isCompoundCI);
  if (compoundCIMatches.length === 1) {
    return compoundCIMatches[0]!.id;
  }
  if (compoundCIMatches.length > 1) {
    return null;
  }

  // 3. Case-insensitive category name match
  const ciCatMatches = categoriesList.filter((c) => c.name.trim().toLowerCase() === trimmedLower);
  if (ciCatMatches.length === 1) {
    return ciCatMatches[0]!.id;
  }
  return null;
}

export async function importCsvTransactions(db: Db, input: ImportCsvInput): Promise<ImportCsvResult> {
  return withTransaction(db, async () => {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, input.accountId));
    if (!account) {
      throw new TransactionError("Account not found", 404);
    }
    if (account.archived) {
      throw new TransactionError(
        `Account "${account.name}" is closed. Reopen it before importing transactions.`,
        422
      );
    }
    const allAccounts = await db.select({ id: accounts.id, name: accounts.name }).from(accounts);
    const accountNameById = new Map(allAccounts.map((a) => [a.id, a.name]));

    const categoryRows: CategoryLookupItem[] = await db
      .select({
        id: categories.id,
        name: categories.name,
        groupName: categoryGroups.name,
      })
      .from(categories)
      .innerJoin(categoryGroups, eq(categories.groupId, categoryGroups.id))
      .orderBy(categoryGroups.sort, categories.sort, categories.id);
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
      accountNameById,
      renameRules
    );
    const created: number[] = [];
    const skipped: ImportSkippedEntry[] = [];
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
      const rawFp = duplicateFingerprint({
        accountId: input.accountId,
        date: rawRow.date!,
        payee: rawRow.payee ?? "",
        memo: rawRow.memo ?? "",
        amount,
      });
      const isDuplicate = existingFingerprints.matchAndConsume([fp, rawFp]);
      if (isDuplicate) {
        skipped.push({
          rowNumber: row.rowNumber,
          accountName: account.name,
          date: row.date!,
          payee: row.payee ?? "",
          memo: row.memo ?? "",
          amount,
          reason: "Matches an existing transaction",
        });
        continue;
      }
      const categoryId = account.onBudget && row.category
        ? resolveImportCategory(row.category, categoryRows)
        : null;
      // Link the row to a payee entity (creating it on first sight, BUG-16) and
      // fall back to the payee's auto-category when the statement row carries no
      // resolvable category. Off-budget accounts stay uncategorized, matching the
      // explicit-category resolution above.
      const knownPayee = getPayeeByName(db, row.payee ?? "");
      let payeeRow = findOrCreatePayee(db, row.payee ?? "");
      // A brand-new payee inherits the category most recently used with that
      // name, so the first statement that mentions it still categorizes like
      // history. Existing payees — including ones whose default was cleared —
      // are left alone.
      if (!knownPayee && payeeRow.autoCategoryId == null) {
        const prior = db
          .select({ categoryId: transactions.categoryId })
          .from(transactions)
          .where(
            and(
              eq(transactions.payee, payeeRow.name),
              isNotNull(transactions.categoryId)
            )
          )
          .orderBy(desc(transactions.date), desc(transactions.id))
          .limit(1)
          .get();
        if (prior?.categoryId != null) {
          payeeRow = (await updatePayee(db, payeeRow.id, { autoCategoryId: prior.categoryId })) ?? payeeRow;
        }
      }
      const effectiveCategoryId =
        categoryId === null && account.onBudget && payeeRow.autoCategoryId != null
          ? payeeRow.autoCategoryId
          : categoryId;
      const isIncome = effectiveCategoryId == null && amount > 0 && !!account.onBudget && account.kind !== "credit";
      const [inserted] = await db
        .insert(transactions)
        .values({
          accountId: input.accountId,
          categoryId: effectiveCategoryId,
          date: row.date!,
          payee: row.payee ?? "",
          payeeId: payeeRow.id,
          memo: row.memo ?? "",
          amount,
          // Imports land Uncleared so the user approves each row via the
          // C column — the same concept as scheduled transactions, which
          // also post as "u". Approving (u -> c) counts as reviewing the
          // row and clears its needsReview flag.
          status: "u",
          flagColor: null,
          transferAccountId: null,
          parentId: null,
          isIncome,
          incomeMonth: null,
          // Freshly imported rows need user review (shown bold, YNAB4-style)
          // until any user edit, payee-manager cascade, or reconcile clears
          // the flag. Automatic rename-rule backfills leave it untouched.
          needsReview: true,
        })
        .returning();
      created.push(inserted!.id);
      await db
        .update(accounts)
        .set({ balance: sql`${accounts.balance} + ${amount}` })
        .where(eq(accounts.id, input.accountId));
    }
    return { count: created.length, skipped };
  });
}