import { eq } from "drizzle-orm";
import type { ClearedStatus, MergeableTransaction, MergeOverrides } from "@ynab/logic";
import { applyMergeOverrides, pickMergePrimary, resolveMergedTransaction, TransactionError } from "@ynab/logic";
import { assertEntityInvariants } from "../../invariants.js";
import type { Database } from "../../client.js";
import { withTransaction } from "../../transaction.js";
import { categories, transactions } from "../../schema.js";
import { learnRenameRuleFromPayees } from "../rename-rules.js";
import { assertValidISODate, assertValidISOMonth, assertValidAmount, sanitizeFlagColor, sanitizeFlagState } from "./validation.js";
import { assertTargetAccountsOpen, getAccountInfo, getTransferTargetInfo } from "./accounts.js";
import { applyBalance, childCount } from "./shared.js";
import type { MergeTransactionsResult } from "./types.js";

export async function mergeTransactions(
  db: Database,
  ids: number[],
  overrides: MergeOverrides = {}
): Promise<MergeTransactionsResult> {
  if (
    !Array.isArray(ids) ||
    ids.length !== 2 ||
    !ids.every((id) => Number.isInteger(id) && (id as number) > 0)
  ) {
    throw new TransactionError("merge requires exactly two transaction ids", 400);
  }
  const [firstId, secondId] = ids as [number, number];
  if (firstId === secondId) {
    throw new TransactionError("cannot merge a transaction with itself", 400);
  }
  if (overrides.status === "r" || overrides.transferStatus === "r") {
    throw new TransactionError("cannot set status to 'r'; only the reconcile flow may set 'r'");
  }

  // Rename-rule seeding runs after the commit (match-approval learning,
  // YNAB4 `PayeeManager.renamePayee` parity): every original spelling
  // that differs from the surviving name maps to it, so future imports
  // arrive with the merged name. A rule-learning failure never rolls
  // back (or blocks) the merge itself.
  const learnedPairs: Array<{ from: string; to: string }> = [];

  const result = await withTransaction(db, async () => {
    const [first] = await db.select().from(transactions).where(eq(transactions.id, firstId));
    const [second] = await db.select().from(transactions).where(eq(transactions.id, secondId));
    const missingId = first == null ? firstId : second == null ? secondId : null;
    if (missingId != null || first == null || second == null) {
      throw new TransactionError(`transaction ${missingId} not found`, 404);
    }

    for (const row of [first, second]) {
      if (row.status === "r" || row.transferStatus === "r") {
        throw new TransactionError(
          `Transaction ${row.id} is reconciled and locked. Unreconcile before merging.`,
          422
        );
      }
      if (row.parentId != null) {
        throw new TransactionError(
          `Transaction ${row.id} is a split sub-transaction and cannot be merged`,
          400
        );
      }
      if ((await childCount(db, row.id)) > 0) {
        throw new TransactionError(
          `Transaction ${row.id} is a split transaction and cannot be merged`,
          400
        );
      }
    }

    const toMergeable = (row: typeof first): MergeableTransaction => ({
      id: row.id,
      accountId: row.accountId,
      transferAccountId: row.transferAccountId,
      categoryId: row.categoryId,
      date: row.date,
      payee: row.payee,
      payeeId: row.payeeId,
      memo: row.memo ?? "",
      amount: Number(row.amount),
      status: row.status as ClearedStatus,
      transferStatus: (row.transferStatus as ClearedStatus | null) ?? null,
      flagColor: sanitizeFlagState(row.flagColor),
      needsReview: Boolean(row.needsReview),
      entityId: row.entityId,
      transferEntityId: row.transferEntityId,
      isIncome: Boolean(row.isIncome),
      incomeMonth: row.incomeMonth,
    });
    const [primary, secondary] = pickMergePrimary(toMergeable(first), toMergeable(second));

    const srcInfo = await getAccountInfo(db, primary.accountId);
    const destInfo =
      primary.transferAccountId != null
        ? await getTransferTargetInfo(db, primary.transferAccountId)
        : null;
    const resolved = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: { onBudget: srcInfo?.onBudget ?? true, kind: srcInfo?.kind ?? "liquid" },
      destAccount: destInfo ? { onBudget: destInfo.onBudget } : null,
    });

    // User edits win over the resolution. Referenced rows are checked
    // up front so a bad id fails with a 404 instead of a FK error, and
    // moving the merged row onto a closed account is blocked like the
    // edit path (untouched legs stay allowed for history fixes).
    if (overrides.accountId !== undefined) {
      const info = await getAccountInfo(db, overrides.accountId);
      if (!info) throw new TransactionError(`account ${overrides.accountId} not found`, 404);
    }
    const finalAccountId = overrides.accountId ?? resolved.accountId;
    const finalTransferAccountId =
      overrides.transferAccountId !== undefined
        ? overrides.transferAccountId
        : resolved.transferAccountId;
    if (finalTransferAccountId != null) {
      const info = await getTransferTargetInfo(db, finalTransferAccountId);
      if (!info) throw new TransactionError(`account ${finalTransferAccountId} not found`, 404);
    }
    if (overrides.categoryId !== undefined && overrides.categoryId != null) {
      const [cat] = await db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.id, overrides.categoryId));
      if (!cat) throw new TransactionError(`category ${overrides.categoryId} not found`, 404);
    }
    if (overrides.date !== undefined) assertValidISODate(overrides.date);
    if (overrides.amount !== undefined) assertValidAmount(overrides.amount);
    if (overrides.incomeMonth !== undefined && overrides.incomeMonth != null) {
      assertValidISOMonth(overrides.incomeMonth, "incomeMonth");
    }
    assertEntityInvariants({
      accountId: finalAccountId,
      transferAccountId: finalTransferAccountId,
    });
    if (
      finalAccountId !== primary.accountId ||
      finalTransferAccountId !== primary.transferAccountId
    ) {
      await assertTargetAccountsOpen(db, [finalAccountId, finalTransferAccountId]);
    }

    const finalSrc = await getAccountInfo(db, finalAccountId);
    const finalDest =
      finalTransferAccountId != null
        ? await getTransferTargetInfo(db, finalTransferAccountId)
        : null;
    const merged = applyMergeOverrides(resolved, overrides, {
      sourceAccount: { onBudget: finalSrc?.onBudget ?? true, kind: finalSrc?.kind ?? "liquid" },
      destAccount: finalDest ? { onBudget: finalDest.onBudget } : null,
      destAccountName: finalDest?.name ?? null,
    });
    // DB row behind the winning mergeable: carries the YNAB4-only
    // columns the logic-layer mergeable does not model.
    const primaryRow = primary.id === first.id ? first : second;

    await applyBalance(db, first.accountId, -Number(first.amount));
    if (first.transferAccountId != null) {
      await applyBalance(db, first.transferAccountId, Number(first.amount));
    }
    await applyBalance(db, second.accountId, -Number(second.amount));
    if (second.transferAccountId != null) {
      await applyBalance(db, second.transferAccountId, Number(second.amount));
    }
    await applyBalance(db, merged.accountId, merged.amount);
    if (merged.transferAccountId != null) {
      await applyBalance(db, merged.transferAccountId, -merged.amount);
    }

    const [updated] = await db
      .update(transactions)
      .set({
        accountId: merged.accountId,
        categoryId: merged.categoryId,
        transferAccountId: merged.transferAccountId,
        date: merged.date,
        payee: merged.payee,
        payeeId: merged.payeeId,
        memo: merged.memo,
        amount: merged.amount,
        status: merged.status,
        transferStatus: merged.transferStatus,
        flagColor: sanitizeFlagColor(merged.flagColor),
        isIncome: merged.isIncome,
        incomeMonth: merged.incomeMonth,
        needsReview: merged.needsReview,
        entityId: merged.entityId,
        transferEntityId: merged.transferEntityId,
        // YNAB4-only columns ride on the surviving row: the verbatim
        // sentinel only while the merged row stays income, the dest-leg
        // memo/lineage only while it stays a transfer.
        incomeCategoryRaw: merged.isIncome ? (primaryRow.incomeCategoryRaw ?? null) : null,
        transferMemo: merged.transferAccountId != null ? (primaryRow.transferMemo ?? null) : null,
        transferCheckNumber:
          merged.transferAccountId != null ? (primaryRow.transferCheckNumber ?? null) : null,
        transferFitid: merged.transferAccountId != null ? (primaryRow.transferFitid ?? null) : null,
        transferYnabId: merged.transferAccountId != null ? (primaryRow.transferYnabId ?? null) : null,
        transferImportedPayee:
          merged.transferAccountId != null ? (primaryRow.transferImportedPayee ?? null) : null,
        transferSource: merged.transferAccountId != null ? (primaryRow.transferSource ?? null) : null,
      })
      .where(eq(transactions.id, primary.id))
      .returning();
    await db.delete(transactions).where(eq(transactions.id, secondary.id));

    const finalPayee = merged.payee.trim();
    for (const original of [first.payee, second.payee]) {
      if (original.trim() !== "" && original.trim() !== finalPayee) {
        learnedPairs.push({ from: original, to: merged.payee });
      }
    }

    return { merged: updated!, deletedId: secondary.id };
  });

  for (const pair of learnedPairs) {
    try {
      await learnRenameRuleFromPayees(db, pair.from, pair.to);
    } catch {
      // Best-effort only (see above). Swallowed silently.
    }
  }

  return result;
}

/**
 * Bulk update transactions in an atomic transaction.
 */
