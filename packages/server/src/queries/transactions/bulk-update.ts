import { and, eq, ne, or, sql } from "drizzle-orm";
import type { BulkUpdateTransactionPatch, ClearedStatus } from "@ynab/logic";
import { classifyBoundaryTransfer, TransactionError } from "@ynab/logic";
import { assertEntityInvariants } from "../../invariants.js";
import type { Database } from "../../client.js";
import { withTransaction } from "../../transaction.js";
import { transactions } from "../../schema.js";
import { learnRenameRuleFromPayees } from "../rename-rules.js";
import { assertValidISODate, assertValidISOMonth, assertValidAmount, sanitizeFlagColor } from "./validation.js";
import { isAccountOnBudget, assertTargetAccountsOpen, getAccountInfo } from "./accounts.js";
import { applyBalance, getAccountName, childCount, getChildren } from "./shared.js";

export async function bulkUpdateTransactions(
  db: Database,
  ids: number[],
  patch: BulkUpdateTransactionPatch
) {
  if (!ids || ids.length === 0) return [];
  if (patch.date !== undefined && patch.date != null) {
    assertValidISODate(patch.date, "date");
  }
  if (patch.incomeMonth !== undefined && patch.incomeMonth != null) {
    assertValidISOMonth(patch.incomeMonth, "incomeMonth");
  }
  // Defense-in-depth: the BulkUpdateTransactionPatch type and the route
  // schema both exclude "r", but this still throws for any caller that
  // bypasses types (plain JS, future callers) — hence the unknown widening.
  const untrustedPatch = patch as { status?: unknown; transferStatus?: unknown };
  if (untrustedPatch.status === "r" || untrustedPatch.transferStatus === "r") {
    throw new TransactionError(
      "cannot set status to 'r'; only the reconcile flow may set 'r'"
    );
  }
  const renameRulesToLearn: { from: string; to: string }[] = [];

  const updated = await withTransaction(db, async () => {
    const updatedRows: (typeof transactions.$inferSelect)[] = [];
    const familyIntents = new Map<number, { date?: string; status?: ClearedStatus }>();
    for (const id of ids) {
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) continue;

      const touchesStructural =
        patch.accountId !== undefined ||
        patch.categoryId !== undefined ||
        patch.date !== undefined ||
        patch.payee !== undefined ||
        patch.memo !== undefined ||
        patch.amount !== undefined ||
        patch.incomeMonth !== undefined;

      if (existing.status === "r" && (patch.status !== undefined || touchesStructural)) {
        throw new TransactionError(
          `Transaction ${id} is reconciled and locked. Unreconcile before editing.`,
          422
        );
      }

      if (existing.transferStatus === "r" && (patch.transferStatus !== undefined || touchesStructural)) {
        throw new TransactionError(
          `Transaction ${id} is reconciled and locked. Unreconcile before editing.`,
          422
        );
      }

      if (existing.parentId != null) {
        const [parent] = await db.select().from(transactions).where(eq(transactions.id, existing.parentId));
        if (parent && (parent.status === "r" || parent.transferStatus === "r") && (patch.status !== undefined || touchesStructural)) {
          throw new TransactionError(
            `Transaction ${id} is reconciled and locked. Unreconcile before editing.`,
            422
          );
        }
      }

      const isParent = existing.parentId == null && existing.transferAccountId == null;
      const hasChildren = isParent && (await childCount(db, id)) > 0;
      const isSplitParent = isParent && hasChildren;

      if (isSplitParent) {
        const children = await getChildren(db, id);
        if (children.some((c) => c.status === "r" || c.transferStatus === "r")) {
          throw new TransactionError(
            `Transaction ${id} is reconciled and locked. Unreconcile before editing.`,
            422
          );
        }
        if ("amount" in patch && patch.amount !== undefined) {
          throw new TransactionError("cannot change amount of a split parent; edit children");
        }
        if ("accountId" in patch && patch.accountId !== undefined) {
          throw new TransactionError("cannot change account of a split parent");
        }
      }

      if (existing.parentId != null && patch.accountId !== undefined) {
        throw new TransactionError("cannot change account of a split child");
      }
      if (existing.parentId != null && patch.amount !== undefined) {
        throw new TransactionError("cannot change amount of a split child; edit the split");
      }

      if (
        existing.transferAccountId != null &&
        patch.accountId != null &&
        Number(patch.accountId) !== existing.accountId
      ) {
        throw new TransactionError("cannot change account of a transfer; delete and recreate");
      }

      const newAccountId = patch.accountId != null ? Number(patch.accountId) : existing.accountId;
      const newAmount = patch.amount != null ? assertValidAmount(patch.amount) : Number(existing.amount);

      if (patch.accountId != null && Number(patch.accountId) !== existing.accountId) {
        await assertTargetAccountsOpen(db, [newAccountId]);
      }

      assertEntityInvariants({
        accountId: newAccountId,
        transferAccountId: existing.transferAccountId,
        parentId: existing.parentId,
        subTransactions: isSplitParent ? await getChildren(db, id) : undefined,
      });

      if (patch.accountId != null || patch.amount != null) {
        if (existing.transferAccountId != null) {
          await applyBalance(db, existing.accountId, -Number(existing.amount));
          await applyBalance(db, existing.transferAccountId, Number(existing.amount));
          await applyBalance(db, newAccountId, newAmount);
          await applyBalance(db, existing.transferAccountId, -newAmount);
        } else if (!isSplitParent) {
          if (newAccountId !== existing.accountId || newAmount !== Number(existing.amount)) {
            await applyBalance(db, existing.accountId, -Number(existing.amount));
            await applyBalance(db, newAccountId, newAmount);
          }
        }
      }

      const setFields: Record<string, unknown> = {};
      if (patch.status !== undefined && patch.status != null) {
        setFields.status = patch.status;
        setFields.reconciledAt = null;
        setFields.reconciliationId = null;
      }
      if (patch.transferStatus !== undefined && patch.transferStatus != null) {
        setFields.transferStatus = patch.transferStatus;
        setFields.transferReconciledAt = null;
        setFields.transferReconciliationId = null;
      }
      if (patch.categoryId !== undefined) {
        setFields.categoryId = patch.categoryId ?? null;
      }
      if (patch.flagColor !== undefined) {
        setFields.flagColor = sanitizeFlagColor(patch.flagColor);
      }
      if (patch.date !== undefined && patch.date != null) setFields.date = String(patch.date);
      if (patch.payee !== undefined && patch.payee != null) {
        if (existing.transferAccountId != null && !String(patch.payee).trim()) {
          const destName = await getAccountName(db, existing.transferAccountId);
          setFields.payee = `Transfer : ${destName ?? "Unknown"}`;
        } else {
          setFields.payee = String(patch.payee);
        }
      }
      if (patch.memo !== undefined) setFields.memo = patch.memo == null ? "" : String(patch.memo);
      if (patch.amount !== undefined && patch.amount != null) setFields.amount = newAmount;
      if (patch.accountId !== undefined && patch.accountId != null) setFields.accountId = newAccountId;
      if (patch.incomeMonth !== undefined) setFields.incomeMonth = patch.incomeMonth ?? null;

      const srcAccount = await getAccountInfo(db, newAccountId);
      const srcOnBudget = srcAccount?.onBudget ?? true;
      const srcKind = srcAccount?.kind ?? "liquid";
      const destOnBudget =
        existing.transferAccountId != null
          ? await isAccountOnBudget(db, existing.transferAccountId)
          : null;

      if (existing.transferAccountId != null) {
        const finalCatId = "categoryId" in setFields ? (setFields.categoryId as number | null) : existing.categoryId;
        const incMonth =
          "incomeMonth" in setFields
            ? (setFields.incomeMonth as string | null)
            : (existing.incomeMonth ?? null);
        const classification = classifyBoundaryTransfer({
          srcOnBudget,
          destOnBudget: destOnBudget ?? true,
          amount: newAmount,
          categoryId: finalCatId,
          incomeMonth: incMonth,
        });
        setFields.categoryId = classification.categoryId;
        setFields.isIncome = classification.isIncome;
        setFields.incomeMonth = classification.incomeMonth;
      } else if (isSplitParent) {
        setFields.categoryId = null;
        setFields.isIncome = false;
        setFields.incomeMonth = null;
      } else if (!srcOnBudget) {
        setFields.categoryId = null;
        setFields.incomeMonth = null;
        setFields.isIncome = false;
      } else if (srcKind === "credit") {
        if ("categoryId" in patch) {
          setFields.categoryId = patch.categoryId ?? null;
        }
        setFields.incomeMonth = null;
        setFields.isIncome = false;
      } else {
        const finalCatId = "categoryId" in setFields ? setFields.categoryId : existing.categoryId;
        const isEligibleForIncome = finalCatId == null;

        if (patch.accountId != null || patch.amount != null || patch.categoryId !== undefined) {
          const isIncome = isEligibleForIncome && newAmount > 0;
          setFields.isIncome = isIncome;
          if (!isIncome) {
            setFields.incomeMonth = null;
          }
        } else if (!isEligibleForIncome && existing.isIncome) {
          setFields.isIncome = false;
          setFields.incomeMonth = null;
        }

        if (!isEligibleForIncome && "incomeMonth" in setFields) {
          setFields.incomeMonth = null;
        }
      }

      // G-income-lineage: keep the verbatim sentinel only while the row
      // stays the same income. Un-flagging income, or explicitly
      // re-specifying the category/income month, clears it so export
      // derives the fresh label. (Bulk transfer rewrites always touch
      // categoryId/incomeMonth via classification, so only an explicit
      // patch clears on a still-income row.)
      const finalBulkIsIncome =
        "isIncome" in setFields ? Boolean(setFields.isIncome) : Boolean(existing.isIncome);
      if (!finalBulkIsIncome) {
        setFields.incomeCategoryRaw = null;
      } else if (patch.categoryId !== undefined || patch.incomeMonth !== undefined) {
        setFields.incomeCategoryRaw = null;
      }

      if (Object.keys(setFields).length > 0) {
        // A bulk edit counts as reviewing each touched row.
        setFields.needsReview = false;
        const [row] = await db
          .update(transactions)
          .set(setFields)
          .where(eq(transactions.id, id))
          .returning();
        if (row) updatedRows.push(row);

        const familyRoot = isSplitParent ? id : existing.parentId;
        if (familyRoot != null) {
          const intent = familyIntents.get(familyRoot) ?? {};
          if ("date" in setFields && setFields.date != null) {
            intent.date = String(setFields.date);
          }
          if ("status" in setFields && setFields.status != null) {
            intent.status = setFields.status as ClearedStatus;
          }
          familyIntents.set(familyRoot, intent);
        }
      }

      if (
        patch.payee != null &&
        String(patch.payee).trim() !== existing.payee.trim() &&
        existing.transferAccountId == null &&
        existing.parentId == null &&
        !isSplitParent
      ) {
        renameRulesToLearn.push({ from: existing.payee, to: String(patch.payee) });
      }
    }

    for (const [familyRoot, intent] of familyIntents) {
      const familyFilter = or(
        eq(transactions.id, familyRoot),
        eq(transactions.parentId, familyRoot)
      );
      const familyRows = await db.select().from(transactions).where(familyFilter);
      if (familyRows.some((row) => row.status === "r" || row.transferStatus === "r")) {
        throw new TransactionError(
          `Transaction ${familyRoot} is reconciled and locked. Unreconcile before editing.`,
          422
        );
      }
      if (intent.date != null) {
        await db.update(transactions).set({ date: intent.date }).where(familyFilter);
      }
      if (intent.status != null) {
        await db
          .update(transactions)
          .set({ status: intent.status, reconciledAt: null, reconciliationId: null })
          .where(familyFilter);
        // Transfer legs follow the family status, same rule as
        // updateTransaction. Bulk edits already refuse families containing a
        // reconciled leg, so the 'r' guard below is defense in depth.
        await db
          .update(transactions)
          .set({
            transferStatus: intent.status,
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
    }

    return updatedRows;
  });

  for (const rule of renameRulesToLearn) {
    try {
      await learnRenameRuleFromPayees(db, rule.from, rule.to);
    } catch {
      // Best-effort only (see above). Swallowed silently.
    }
  }

  return updated;
}
