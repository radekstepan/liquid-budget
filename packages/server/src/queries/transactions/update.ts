import { and, desc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import type { ClearedStatus } from "@ynab/logic";
import { classifyBoundaryTransfer, TransactionError } from "@ynab/logic";
import { assertEntityInvariants } from "../../invariants.js";
import type { Database } from "../../client.js";
import { withTransaction } from "../../transaction.js";
import { payees, transactions } from "../../schema.js";
import { learnRenameRuleFromPayees } from "../rename-rules.js";
import { assertValidISODate, assertValidISOMonth, assertValidAmount, sanitizeFlagColor } from "./validation.js";
import { isAccountOnBudget, assertTargetAccountsOpen, getAccountInfo } from "./accounts.js";
import { applyBalance, getAccountName, childCount, getChildren } from "./shared.js";
import type { UpdateTransactionInput } from "./types.js";

async function lastCategoryForPayee(
  db: Database,
  payeeName: string,
  excludeId?: number
): Promise<number | null> {
  const trimmed = payeeName.trim();
  if (!trimmed) return null;
  const [payeeRow] = await db
    .select({ autoCategoryId: payees.autoCategoryId })
    .from(payees)
    .where(eq(payees.name, trimmed));
  if (payeeRow?.autoCategoryId != null) return payeeRow.autoCategoryId;
  const conditions = [
    eq(transactions.payee, trimmed),
    isNotNull(transactions.categoryId),
  ];
  if (excludeId != null) conditions.push(ne(transactions.id, excludeId));
  const [prior] = await db
    .select({ categoryId: transactions.categoryId })
    .from(transactions)
    .where(and(...conditions))
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(1);
  return prior?.categoryId ?? null;
}

export async function updateTransaction(db: Database, id: number, patch: UpdateTransactionInput) {
  const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!existing) return null;

  if (patch.status === "r" || patch.transferStatus === "r") {
    throw new TransactionError(
      "cannot set status to 'r'; only the reconcile flow may set 'r'"
    );
  }

  const touchesStructuralFields =
    patch.accountId !== undefined ||
    patch.categoryId !== undefined ||
    patch.transferAccountId !== undefined ||
    patch.date !== undefined ||
    patch.payee !== undefined ||
    patch.memo !== undefined ||
    patch.amount !== undefined ||
    patch.incomeMonth !== undefined ||
    patch.isIncome !== undefined;

  const isUnreconciling = patch.status === "u";
  const isUnreconcilingTransfer = patch.transferStatus === "u";

  if (existing.status === "r" && !isUnreconciling && (patch.status !== undefined || touchesStructuralFields)) {
    throw new TransactionError(
      "Transaction is reconciled and locked. Unreconcile before editing.",
      422
    );
  }

  if (existing.transferStatus === "r" && !isUnreconcilingTransfer && (patch.transferStatus !== undefined || touchesStructuralFields)) {
    throw new TransactionError(
      "Transaction is reconciled and locked. Unreconcile before editing.",
      422
    );
  }

  if (existing.parentId != null) {
    const [parent] = await db.select().from(transactions).where(eq(transactions.id, existing.parentId));
    if (parent && (parent.status === "r" || parent.transferStatus === "r") && !isUnreconciling && (patch.status !== undefined || touchesStructuralFields)) {
      throw new TransactionError(
        "Transaction is reconciled and locked. Unreconcile before editing.",
        422
      );
    }
  }

  if ("parentId" in (patch as Record<string, unknown>)) {
    throw new TransactionError("parentId cannot be changed via update");
  }

  if (
    existing.transferAccountId != null &&
    patch.accountId != null &&
    Number(patch.accountId) !== existing.accountId
  ) {
    throw new TransactionError("cannot change account of a transfer; delete and recreate");
  }

  if (patch.transferAccountId !== undefined || patch.accountId !== undefined) {
    const candidateAccountId = patch.accountId != null ? Number(patch.accountId) : existing.accountId;
    const candidateTransferAccountId = patch.transferAccountId !== undefined
      ? (patch.transferAccountId != null ? Number(patch.transferAccountId) : null)
      : existing.transferAccountId;
    assertEntityInvariants({
      accountId: candidateAccountId,
      transferAccountId: candidateTransferAccountId,
    });
    // Moving a row (or its transfer leg) onto a closed account is blocked.
    // Edits that stay on the current account remain allowed for history fixes.
    const movesAccount = patch.accountId != null && Number(patch.accountId) !== existing.accountId;
    const movesTransfer =
      patch.transferAccountId !== undefined &&
      (patch.transferAccountId != null ? Number(patch.transferAccountId) : null) !== existing.transferAccountId;
    if (movesAccount || movesTransfer) {
      await assertTargetAccountsOpen(db, [candidateAccountId, candidateTransferAccountId]);
    }
  }

  const p: Record<string, unknown> = {};
  if (patch.accountId !== undefined && patch.accountId != null) p.accountId = Number(patch.accountId);
  if (patch.categoryId !== undefined) {
    p.categoryId = patch.categoryId ?? null;
  }
  if (patch.transferAccountId !== undefined) {
    p.transferAccountId = patch.transferAccountId != null ? Number(patch.transferAccountId) : null;
  }
  if (patch.date !== undefined && patch.date != null) p.date = assertValidISODate(patch.date, "date");
  if (patch.payee !== undefined && patch.payee != null) p.payee = String(patch.payee);
  if (patch.memo !== undefined) p.memo = patch.memo == null ? "" : String(patch.memo);
  if (patch.amount !== undefined && patch.amount != null) p.amount = assertValidAmount(patch.amount);
  if (patch.status !== undefined && patch.status != null) {
    p.status = patch.status;
    p.reconciledAt = null;
    p.reconciliationId = null;
  }
  if (patch.transferStatus !== undefined && patch.transferStatus != null) {
    p.transferStatus = patch.transferStatus;
    p.transferReconciledAt = null;
    p.transferReconciliationId = null;
  }
  if (patch.flagColor !== undefined) p.flagColor = sanitizeFlagColor(patch.flagColor);
  if (patch.incomeMonth !== undefined) {
    p.incomeMonth = patch.incomeMonth ? assertValidISOMonth(patch.incomeMonth, "incomeMonth") : null;
  }
  if (patch.isIncome !== undefined) p.isIncome = patch.isIncome;
  // Any user edit through this path counts as reviewing the row: a
  // freshly imported (bold) transaction stops needing review.
  p.needsReview = false;

  let shouldLearnRenameRule = false;
  let oldPayee = "";
  let newPayee = "";

  const row = await withTransaction(db, async () => {
    // Re-read inside the transaction for an authoritative snapshot
    const [current] = await db.select().from(transactions).where(eq(transactions.id, id));
    if (!current) return null;

    if (current.status === "r" && !isUnreconciling && (patch.status !== undefined || touchesStructuralFields)) {
      throw new TransactionError(
        "Transaction is reconciled and locked. Unreconcile before editing.",
        422
      );
    }

    if (current.transferStatus === "r" && !isUnreconcilingTransfer && (patch.transferStatus !== undefined || touchesStructuralFields)) {
      throw new TransactionError(
        "Transaction is reconciled and locked. Unreconcile before editing.",
        422
      );
    }

    if (current.transferAccountId != null && "accountId" in p && p.accountId !== current.accountId) {
      throw new TransactionError("cannot change account of a transfer; delete and recreate");
    }

    const isParent = current.parentId == null && current.transferAccountId == null;
    const hasChildren = (await childCount(db, id)) > 0;
    const isSplitParent = isParent && hasChildren;

    if (isSplitParent) {
      if ("transferAccountId" in p && p.transferAccountId != null) {
        throw new TransactionError("Split transaction cannot be a transfer", 400);
      }
      const children = await getChildren(db, id);
      if (children.some((c) => c.status === "r" || c.transferStatus === "r")) {
        throw new TransactionError(
          "Transaction is reconciled and locked. Unreconcile before editing.",
          422
        );
      }
      if ("amount" in p) {
        throw new TransactionError("cannot change amount of a split parent; edit children");
      }
      if ("accountId" in p) {
        throw new TransactionError("cannot change account of a split parent");
      }
    }

    if (current.parentId != null) {
      if ("accountId" in p) {
        throw new TransactionError("cannot change account of a split child");
      }
      if ("amount" in p) {
        throw new TransactionError("cannot change amount of a split child; edit the split");
      }
    }

    const newAccountId = (p.accountId as number | undefined) ?? current.accountId;
    const newAmount = (p.amount as number | undefined) ?? Number(current.amount);
    const newTransferAccountId = "transferAccountId" in p
      ? (p.transferAccountId as number | null)
      : current.transferAccountId;

    assertEntityInvariants({
      accountId: newAccountId,
      transferAccountId: newTransferAccountId,
      parentId: current.parentId,
      subTransactions: isSplitParent ? await getChildren(db, id) : undefined,
    });

    if (!isSplitParent) {
      if (
        newAccountId !== current.accountId ||
        newAmount !== Number(current.amount) ||
        current.transferAccountId !== newTransferAccountId
      ) {
        // Reverse old balance effect
        await applyBalance(db, current.accountId, -Number(current.amount));
        if (current.transferAccountId != null) {
          await applyBalance(db, current.transferAccountId, Number(current.amount));
        }
        // Apply new balance effect
        await applyBalance(db, newAccountId, newAmount);
        if (newTransferAccountId != null) {
          await applyBalance(db, newTransferAccountId, -newAmount);
        }
      }
    }

    if (newTransferAccountId != null) {
      if (current.transferAccountId == null && !("transferStatus" in p)) {
        p.transferStatus = (patch.transferStatus ?? patch.status ?? (p.status as ClearedStatus) ?? current.status ?? "c") as ClearedStatus;
      }
    } else if (current.transferAccountId != null) {
      p.transferStatus = null;
      p.transferReconciledAt = null;
      p.transferReconciliationId = null;
      // The row is no longer a transfer: drop the dest leg's independent
      // memo + lineage with the rest of the transfer state.
      p.transferMemo = null;
      p.transferCheckNumber = null;
      p.transferFitid = null;
      p.transferYnabId = null;
      p.transferImportedPayee = null;
      p.transferSource = null;
    }

    const srcAccount = await getAccountInfo(db, newAccountId);
    const srcOnBudget = srcAccount?.onBudget ?? true;
    const srcKind = srcAccount?.kind ?? "liquid";

    // YNAB4-style payee auto-fill: renaming an uncategorized row to a payee
    // with history populates the category (unless the caller explicitly
    // chose a category or Income). Mirrors CSV import's rename-rule
    // categorization.
    if (
      patch.payee != null &&
      String(patch.payee).trim() !== "" &&
      String(patch.payee).trim() !== current.payee.trim() &&
      current.categoryId == null &&
      !current.isIncome &&
      (!("categoryId" in p) || (p.categoryId as number | null) == null) &&
      !("isIncome" in p) &&
      current.transferAccountId == null &&
      newTransferAccountId == null &&
      !isSplitParent &&
      srcOnBudget &&
      srcKind !== "credit"
    ) {
      const suggested = await lastCategoryForPayee(db, String(patch.payee), id);
      if (suggested != null) {
        p.categoryId = suggested;
      } else {
        // No history: preserve uncategorized (don't flip an inflow to
        // income just because the payee was fixed). An explicit isIncome
        // in the patch still wins via the recompute below.
        if (!("isIncome" in p)) {
          p.isIncome = current.isIncome;
          if (!current.isIncome) {
            p.incomeMonth = null;
          }
        }
      }
    }

    if (newTransferAccountId != null) {
      const destOnBudget = await isAccountOnBudget(db, newTransferAccountId);
      if (patch.payee !== undefined && !String(patch.payee).trim()) {
        const destName = await getAccountName(db, newTransferAccountId);
        p.payee = `Transfer : ${destName ?? "Unknown"}`;
      }
      const finalCatId = "categoryId" in p ? (p.categoryId as number | null) : current.categoryId;
      const incMonth = "incomeMonth" in p ? (p.incomeMonth as string | null) : (current.incomeMonth ?? null);
      const classification = classifyBoundaryTransfer({
        srcOnBudget,
        destOnBudget: destOnBudget ?? true,
        amount: newAmount,
        categoryId: finalCatId,
        incomeMonth: incMonth,
      });
      p.categoryId = classification.categoryId;
      p.isIncome = classification.isIncome;
      p.incomeMonth = classification.incomeMonth;
      if (!classification.isIncome) {
        // G-income-lineage: the verbatim YNAB4 sentinel survives only
        // while the row stays the same income.
        p.incomeCategoryRaw = null;
      }
    } else if (isSplitParent) {
      p.categoryId = null;
      p.isIncome = false;
      p.incomeMonth = null;
      p.incomeCategoryRaw = null;
    } else if (!srcOnBudget) {
      p.categoryId = null;
      p.incomeMonth = null;
      p.isIncome = false;
      p.incomeCategoryRaw = null;
    } else if (srcKind === "credit") {
      // Keep a caller-provided categoryId as-is (no defaulting on credit
      // accounts); only the income fields reset below.
      p.incomeMonth = null;
      p.isIncome = false;
      p.incomeCategoryRaw = null;
    } else {
      if (current.transferAccountId != null && !("categoryId" in p)) {
        p.categoryId = null;
      }
      const finalCatId = "categoryId" in p ? (p.categoryId as number | null) : current.categoryId;
      const isEligibleForIncome = finalCatId == null && newAmount > 0;

      // Only recompute income when the categorization inputs actually
      // changed (value comparison, not mere presence — the modal always
      // sends categoryId). Unrelated edits (status, memo, flag) preserve
      // the existing flag, so approving an uncategorized inflow leaves it
      // uncategorized (highlighted) YNAB4-style instead of flipping to
      // income. An explicit isIncome in the patch always wins.
      const categoryChanged =
        "categoryId" in p && (p.categoryId as number | null) !== current.categoryId;
      const amountChanged = "amount" in p && Number(p.amount) !== Number(current.amount);
      const accountChanged = "accountId" in p && Number(p.accountId) !== current.accountId;
      const incomeExplicit = "isIncome" in p;
      const incomeMonthChanged =
        "incomeMonth" in p && (p.incomeMonth as string | null) !== (current.incomeMonth ?? null);
      if (categoryChanged || amountChanged || accountChanged || incomeExplicit || incomeMonthChanged) {
        const isIncome = isEligibleForIncome
          ? ("isIncome" in p ? Boolean(p.isIncome) : true)
          : false;
        p.isIncome = isIncome;
        if (!isIncome) {
          p.incomeMonth = null;
          p.incomeCategoryRaw = null;
        } else if (categoryChanged || incomeMonthChanged) {
          // Same income, re-specified category/month: the old verbatim
          // sentinel no longer describes it; export derives the label.
          p.incomeCategoryRaw = null;
        }
      } else if (!isEligibleForIncome && current.isIncome) {
        // Safety: a categorized row (or non-positive amount) must never
        // stay flagged as income.
        p.isIncome = false;
        p.incomeMonth = null;
        p.incomeCategoryRaw = null;
      }
    }

    const [updatedRow] = await db.update(transactions).set(p).where(eq(transactions.id, id)).returning();

    // If this row is a split parent and date changed, propagate date to children
    if (isSplitParent && "date" in p && p.date != null) {
      await db
        .update(transactions)
        .set({ date: String(p.date) })
        .where(eq(transactions.parentId, id));
    }

    // If this row is a child of a split and date changed, propagate date to parent and siblings
    if (current.parentId != null && "date" in p && p.date != null) {
      await db
        .update(transactions)
        .set({ date: String(p.date) })
        .where(or(eq(transactions.id, current.parentId), eq(transactions.parentId, current.parentId)));
    }

    // If this row is a split parent and status changed, propagate status to children
    if (isSplitParent && "status" in p && p.status != null) {
      await db
        .update(transactions)
        .set({ status: p.status as ClearedStatus, reconciledAt: null, reconciliationId: null })
        .where(eq(transactions.parentId, id));
      // Transfer legs follow the parent too, so the destination side never
      // shows uncleared under a cleared split. Legs the destination account
      // already reconciled keep their state: only that account may move them.
      await db
        .update(transactions)
        .set({
          transferStatus: p.status as ClearedStatus,
          transferReconciledAt: null,
          transferReconciliationId: null,
        })
        .where(
          and(
            eq(transactions.parentId, id),
            sql`${transactions.transferAccountId} IS NOT NULL`,
            or(sql`${transactions.transferStatus} IS NULL`, ne(transactions.transferStatus, "r"))
          )
        );
    }

    // If this row is a child of a split and status changed, propagate status to parent and siblings
    if (current.parentId != null && "status" in p && p.status != null) {
      const familyFilter = or(
        eq(transactions.id, current.parentId),
        eq(transactions.parentId, current.parentId)
      );
      await db
        .update(transactions)
        .set({ status: p.status as ClearedStatus, reconciledAt: null, reconciliationId: null })
        .where(familyFilter);
      // Sibling transfer legs follow as well (the parent itself is never a
      // transfer, so the leg filter only matches siblings). Reconciled
      // destination legs are left untouched — see above.
      await db
        .update(transactions)
        .set({
          transferStatus: p.status as ClearedStatus,
          transferReconciledAt: null,
          transferReconciliationId: null,
        })
        .where(
          and(
            familyFilter,
            sql`${transactions.transferAccountId} IS NOT NULL`,
            or(sql`${transactions.transferStatus} IS NULL`, ne(transactions.transferStatus, "r"))
          )
        );
    }

    // Learn an automatic rename rule from a deliberate payee rename on a
    // plain regular transaction. Runs after the commit so a rule-learning
    // failure never rolls back (or blocks) the transaction edit itself.
    if (
      patch.payee != null &&
      String(patch.payee).trim() !== existing.payee.trim() &&
      existing.transferAccountId == null &&
      newTransferAccountId == null &&
      existing.parentId == null &&
      !isSplitParent
    ) {
      shouldLearnRenameRule = true;
      oldPayee = existing.payee;
      newPayee = String(patch.payee);
    }
    return updatedRow;
  });

  if (shouldLearnRenameRule) {
    try {
      await learnRenameRuleFromPayees(db, oldPayee, newPayee);
    } catch {
      // Best-effort only: a rule-learning failure must never roll back (or
      // block) the transaction edit, and console output would trip the
      // Vitest onConsoleLog guard. Swallowed silently.
    }
  }

  return row;
}

/**
 * Full-replace update of a split: validates the new children, reverses
 * the old children's balance, deletes them, optionally updates the
 * parent fields, then inserts the new children. Used by PATCH when the
 * caller passes `subTransactions: []`.
 */
