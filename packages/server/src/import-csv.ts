import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { CsvImportRow, ImportSkippedEntry } from "@ynab/logic";
import { applyRenameRules, buildExistingImportFingerprints, duplicateFingerprint } from "@ynab/logic";
import type { Db } from "./client.js";
import { withTransaction } from "./transaction.js";
import { accounts, categories, categoryGroups, transactions } from "./schema.js";
import { TransactionError } from "./queries/transactions.js";
import { findOrCreatePayee } from "./queries/payees.js";
import { getRenameRules } from "./queries/rename-rules.js";

// Bulk-cap closed: every ids/rows array at the trust boundary is capped —
// bulk transaction ids (.max(1000) in contracts), recurring bulk ids
// (.max(1000) in contracts), CSV rows (MAX_CSV_IMPORT_ROWS below).

/**
 * Hard cap on rows per CSV import request. A single withTransaction holds
 * the single-writer SQLite lock for the whole import, so unbounded rows
 * (a ~5MB CSV can carry 100k+ rows) stall every other writer. Clients
 * chunk larger statements; bulk-delete/update ids are likewise capped at
 * 1000 in @ynab/logic contracts.
 */
export const MAX_CSV_IMPORT_ROWS = 1000;

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

/**
 * Latest categorized use per payee in one query (ORDER BY date DESC,
 * id DESC, first row per payee wins) — the batched form of the old
 * per-row rename-prior SELECT inside the import loop.
 */
export async function getLatestCategoryByPayee(db: Db, payees: string[]): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  if (payees.length === 0) return latest;
  const rows = await db
    .select({ payee: transactions.payee, categoryId: transactions.categoryId })
    .from(transactions)
    .where(and(inArray(transactions.payee, payees), isNotNull(transactions.categoryId)))
    .orderBy(desc(transactions.date), desc(transactions.id));
  for (const r of rows) {
    if (!latest.has(r.payee) && r.categoryId != null) {
      latest.set(r.payee, r.categoryId);
    }
  }
  return latest;
}

export async function importCsvTransactions(db: Db, input: ImportCsvInput): Promise<ImportCsvResult> {
  if (input.rows.length > MAX_CSV_IMPORT_ROWS) {
    throw new TransactionError(
      `CSV import is limited to ${MAX_CSV_IMPORT_ROWS} rows per request; split larger statements`,
      413
    );
  }
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
    // Pass 1 (row order preserved for fingerprint consume semantics):
    // validate, rename, dedupe, resolve payees/categories. Rows whose payee
    // was rename-corrected defer the latest-prior-category lookup to one
    // batched query below instead of N per-row SELECTs.
    type PreparedRow = {
      date: string;
      payee: string;
      payeeId: number;
      memo: string;
      amount: number;
      categoryId: number | null;
      needsPrior: boolean;
    };
    const prepared: PreparedRow[] = [];
    const priorPayees = new Set<string>();
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
      // Link the row to a payee entity (creating it on first sight, BUG-16).
      // The row itself stays uncategorized unless the statement carries an
      // explicit category or a rename rule corrected the payee — in which
      // case the clean name's default (or last use) populates the row,
      // mirroring a manual payee rename. Off-budget accounts stay
      // uncategorized, matching the explicit-category resolution above.
      const payeeRow = findOrCreatePayee(db, row.payee ?? "");
      let effectiveCategoryId = categoryId;
      let needsPrior = false;
      const wasRenamed = (row.payee ?? "") !== (rawRow.payee ?? "");
      if (effectiveCategoryId === null && account.onBudget && wasRenamed) {
        if (payeeRow.autoCategoryId != null) {
          effectiveCategoryId = payeeRow.autoCategoryId;
        } else {
          needsPrior = true;
          priorPayees.add(row.payee ?? "");
        }
      }
      prepared.push({
        date: row.date!,
        payee: row.payee ?? "",
        payeeId: payeeRow.id,
        memo: row.memo ?? "",
        amount,
        categoryId: effectiveCategoryId,
        needsPrior,
      });
    }
    // One batched latest-prior-category lookup for every rename-corrected
    // payee (replaces N per-row SELECTs ordered by date DESC, id DESC).
    const priorCategoryByPayee = await getLatestCategoryByPayee(db, [...priorPayees]);
    // Pass 2: insert in original row order, accumulating one balance bump.
    // A single UPDATE shortens the single-writer lock hold vs N bumps.
    let balanceDelta = 0;
    for (const p of prepared) {
      const finalCategoryId = p.needsPrior ? (priorCategoryByPayee.get(p.payee) ?? null) : p.categoryId;
      // YNAB4-style: imports never auto-mark income. Positive rows stay
      // uncategorized (highlighted) until the user explicitly categorizes
      // them as Income via the category picker.
      const [inserted] = await db
        .insert(transactions)
        .values({
          accountId: input.accountId,
          categoryId: finalCategoryId,
          date: p.date,
          payee: p.payee,
          payeeId: p.payeeId,
          memo: p.memo,
          amount: p.amount,
          // Imports land Uncleared so the user approves each row via the
          // C column — the same concept as scheduled transactions, which
          // also post as "u". Approving (u -> c) counts as reviewing the
          // row and clears its needsReview flag.
          status: "u",
          flagColor: null,
          transferAccountId: null,
          parentId: null,
          isIncome: false,
          incomeMonth: null,
          // Freshly imported rows need user review (shown bold, YNAB4-style)
          // until any user edit, payee-manager cascade, or reconcile clears
          // the flag. Automatic rename-rule backfills leave it untouched.
          needsReview: true,
        })
        .returning();
      created.push(inserted!.id);
      balanceDelta += p.amount;
    }
    if (balanceDelta !== 0) {
      await db
        .update(accounts)
        .set({ balance: sql`${accounts.balance} + ${balanceDelta}` })
        .where(eq(accounts.id, input.accountId));
    }
    return { count: created.length, skipped };
  });
}