import { eq } from "drizzle-orm";
import type { ClearedStatus } from "@ynab/logic";
import { classifyBoundaryTransfer, inferUncategorizedInflowIncome, isTransferPayee, TransactionError } from "@ynab/logic";
import { assertEntityInvariants } from "../../invariants.js";
import type { Database } from "../../client.js";
import { withTransaction } from "../../transaction.js";
import { transactions } from "../../schema.js";
import { learnRenameRuleFromPayees } from "../rename-rules.js";
import { assertValidISODate, assertValidAmount, sanitizeFlagColor } from "./validation.js";
import { getAccountInfo, getTransferTargetInfo, closedAccountMessage } from "./accounts.js";
import { applyBalance, getAccountName, getChildren, assertSplitsBalancedOr4xx } from "./shared.js";
import type { SubTransactionInput, UpdateSplitParentFields } from "./types.js";

export async function updateSplit(
  db: Database,
  parentId: number,
  parentFields: UpdateSplitParentFields,
  children: SubTransactionInput[]
) {
  if (parentFields.status === "r") {
    throw new TransactionError(
      "cannot set status to 'r'; only the reconcile flow may set 'r'"
    );
  }

  let shouldLearnRenameRule = false;
  let learnedOldPayee = "";
  let learnedNewPayee = "";

  const res = await withTransaction(db, async () => {
    const [parent] = await db.select().from(transactions).where(eq(transactions.id, parentId));
    if (!parent) {
      throw new TransactionError("split parent not found", 404);
    }
    if (parent.status === "r" || parent.transferStatus === "r") {
      throw new TransactionError("Reconciled split transaction cannot be modified.", 422);
    }
    if (parent.parentId != null) {
      throw new TransactionError("target row is a split child, not a split parent");
    }
    if (parentFields.date !== undefined && parentFields.date != null) {
      assertValidISODate(parentFields.date, "date");
    }
    const parentAmount =
      parentFields.amount !== undefined && parentFields.amount != null
        ? assertValidAmount(parentFields.amount)
        : assertValidAmount(parent.amount);
    assertSplitsBalancedOr4xx(parentAmount, children);

    assertEntityInvariants({
      accountId: parent.accountId,
      transferAccountId: parentFields.transferAccountId ?? null,
      subTransactions: children,
    });

    for (const c of children) {
      if (c.transferAccountId != null) {
        assertEntityInvariants({
          accountId: parent.accountId,
          transferAccountId: Number(c.transferAccountId),
        });
      }
    }

    const oldChildren = await getChildren(db, parentId);
    if (oldChildren.some((c) => c.status === "r" || c.transferStatus === "r")) {
      throw new TransactionError("Reconciled split transaction cannot be modified.", 422);
    }

    if (oldChildren.length > 0) {
      for (const c of oldChildren) {
        await applyBalance(db, c.accountId, -Number(c.amount));
        if (c.transferAccountId != null) {
          await applyBalance(db, c.transferAccountId, Number(c.amount));
        }
      }
      // No delete-all here: children claimed by id below are updated in
      // place (preserving register order); only unclaimed rows are
      // deleted after the rewrite loop.
    } else {
      // Converting a single transaction or transfer to a split: reverse the old transaction's balance
      await applyBalance(db, parent.accountId, -Number(parent.amount));
      if (parent.transferAccountId != null) {
        await applyBalance(db, parent.transferAccountId, Number(parent.amount));
      }
    }

    const pf: Record<string, unknown> = {};
    if (parentFields.amount !== undefined && parentFields.amount != null) pf.amount = parentAmount;
    if (parentFields.date !== undefined && parentFields.date != null) pf.date = String(parentFields.date);
    if (parentFields.payee !== undefined && parentFields.payee != null) pf.payee = String(parentFields.payee);
    if (parentFields.memo !== undefined) pf.memo = parentFields.memo == null ? "" : String(parentFields.memo);
    if (parentFields.status !== undefined && parentFields.status != null) {
      pf.status = parentFields.status;
      pf.reconciledAt = null;
      pf.reconciliationId = null;
    }
    if (parentFields.flagColor !== undefined) pf.flagColor = sanitizeFlagColor(parentFields.flagColor);
    // Rewriting a split counts as reviewing the family: the parent here,
    // fresh children by column default, matched children explicitly below.
    pf.needsReview = false;
    if (oldChildren.length === 0) {
      pf.transferAccountId = null;
      pf.transferStatus = null;
      pf.transferReconciledAt = null;
      pf.transferReconciliationId = null;
      pf.transferMemo = null;
      pf.transferCheckNumber = null;
      pf.transferFitid = null;
      pf.transferYnabId = null;
      pf.transferImportedPayee = null;
      pf.transferSource = null;
      pf.categoryId = null;
      pf.isIncome = false;
      pf.incomeMonth = null;
      pf.incomeCategoryRaw = null;
    }
    if (Object.keys(pf).length > 0) {
      await db.update(transactions).set(pf).where(eq(transactions.id, parentId));
    }

    const newMemo = (pf.memo as string | undefined) ?? parent.memo;
    const newDate = (pf.date as string | undefined) ?? parent.date;
    const newPayee = (pf.payee as string | undefined) ?? parent.payee;
    const newStatus: ClearedStatus =
      (pf.status as ClearedStatus | undefined) ?? (parent.status as ClearedStatus);

    const srcAccount = await getAccountInfo(db, parent.accountId);
    const srcOnBudget = srcAccount?.onBudget ?? true;
    const srcKind = srcAccount?.kind ?? "liquid";
    const newChildren = [];
    const usedOldIndices = new Set<number>();

    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      // Identity match: an incoming id naming one of this split's current
      // children updates that row in place, preserving its id — and with
      // it the row's same-day register position (order ties break on id).
      // Unknown or duplicate ids fall through to plain inserts below.
      let matchedOldChild: (typeof oldChildren)[0] | undefined;
      if (c.id != null) {
        const childId = Number(c.id);
        const foundIdx = oldChildren.findIndex(
          (oc, idx) => !usedOldIndices.has(idx) && oc.id === childId
        );
        if (foundIdx !== -1) {
          usedOldIndices.add(foundIdx);
          matchedOldChild = oldChildren[foundIdx];
        }
      }
      const childAmount = assertValidAmount(c.amount);
      let payee = newPayee;
      const transferAccountId = c.transferAccountId ? Number(c.transferAccountId) : null;
      let categoryId = c.categoryId ? Number(c.categoryId) : null;
      let isIncome = false;

      if (transferAccountId) {
        const destName = await getAccountName(db, transferAccountId);
        payee = `Transfer : ${destName ?? "Unknown"}`;
        const destInfo = await getTransferTargetInfo(db, transferAccountId);
        const closedDest = closedAccountMessage(destInfo, transferAccountId);
        if (closedDest) {
          throw new TransactionError(closedDest, 422);
        }
        const destOnBudget = destInfo?.onBudget ?? true;
        const classification = classifyBoundaryTransfer({
          srcOnBudget,
          destOnBudget,
          amount: childAmount,
          categoryId,
          incomeMonth: null,
        });
        categoryId = classification.categoryId;
        isIncome = classification.isIncome;
      } else {
        if (c.payee !== undefined && c.payee !== null && c.payee !== "") {
          payee = String(c.payee);
        } else {
          // Reuse the identity match above to preserve a custom payee (BUG-34)
          if (
            matchedOldChild &&
            matchedOldChild.transferAccountId == null &&
            matchedOldChild.payee &&
            matchedOldChild.payee !== parent.payee
          ) {
            payee = matchedOldChild.payee;
          } else {
            payee = newPayee;
          }
        }

        if (!srcOnBudget) {
          categoryId = null;
          isIncome = false;
        } else if (srcKind === "credit") {
          categoryId = c.categoryId ? Number(c.categoryId) : null;
          isIncome = false;
        } else {
          isIncome = inferUncategorizedInflowIncome({
            categoryId,
            amountCents: childAmount,
          }).isIncome;
        }
      }

      const values = {
        accountId: parent.accountId,
        categoryId,
        date: newDate,
        payee,
        // Children inherit the parent's memo unless they have their own.
        memo: c.memo ?? newMemo ?? "",
        amount: childAmount,
        status: newStatus,
        transferStatus: transferAccountId ? (c.transferStatus ?? newStatus) : null,
        transferAccountId,
        parentId,
        isIncome,
        // A rewrite re-authors every child in-app terms: YNAB4-only
        // columns (verbatim sentinel, dest-leg memo/lineage) reset so
        // export derives from the edited state instead of echoing a
        // label the user never chose.
        incomeCategoryRaw: null,
        transferMemo: null,
        transferCheckNumber: null,
        transferFitid: null,
        transferYnabId: null,
        transferImportedPayee: null,
        transferSource: null,
      };
      if (matchedOldChild != null) {
        // Identity-preserving update: the same values a fresh insert would
        // carry, written onto the existing row. Columns the rewrite never
        // sets (entity ids, flags, income month, created-at) survive; the
        // YNAB4-only columns above reset even on matched rows.
        await db
          .update(transactions)
          .set({ ...values, needsReview: false })
          .where(eq(transactions.id, matchedOldChild.id));
        newChildren.push({ ...matchedOldChild, ...values, needsReview: false });
      } else {
        const [row] = await db.insert(transactions).values(values).returning();
        newChildren.push(row);
      }
      await applyBalance(db, parent.accountId, childAmount);
      if (transferAccountId) {
        await applyBalance(db, transferAccountId, -childAmount);
      }
    }

    // Delete children the rewrite dropped: old rows no incoming child
    // claimed by id. Their balances were already reversed above.
    for (let idx = 0; idx < oldChildren.length; idx++) {
      if (!usedOldIndices.has(idx)) {
        await db.delete(transactions).where(eq(transactions.id, oldChildren[idx]!.id));
      }
    }

    // Learn a rename rule when a split's display payee is changed.
    // Never for transfers: the parent may be a transfer being converted
    // to a split, and system payees (`Transfer : <account>`) must not
    // seed rename rules in either direction.
    if (
      parentFields.payee != null &&
      String(parentFields.payee).trim() !== parent.payee.trim() &&
      parent.transferAccountId == null &&
      !isTransferPayee(parent.payee) &&
      !isTransferPayee(String(parentFields.payee))
    ) {
      shouldLearnRenameRule = true;
      learnedOldPayee = parent.payee;
      learnedNewPayee = String(parentFields.payee);
    }
    return { parent: { ...parent, ...pf }, children: newChildren };
  });

  if (shouldLearnRenameRule) {
    try {
      await learnRenameRuleFromPayees(db, learnedOldPayee, learnedNewPayee);
    } catch {
      // Best-effort only (see above). Swallowed silently.
    }
  }

  return res;
}

/**
 * Delete all children of a split transaction and reverse their balance effects.
 * Used when converting a split transaction into a single or transfer transaction.
 */

export async function deleteSplitChildren(db: Database, parentId: number): Promise<void> {
  await withTransaction(db, async () => {
    const children = await getChildren(db, parentId);
    if (children.length === 0) return;

    if (children.some((c) => c.status === "r" || c.transferStatus === "r")) {
      throw new TransactionError("Reconciled split transaction cannot be modified.", 422);
    }

    const [parent] = await db.select().from(transactions).where(eq(transactions.id, parentId));
    if (!parent) return;

    for (const c of children) {
      await applyBalance(db, c.accountId, -Number(c.amount));
      if (c.transferAccountId != null) {
        await applyBalance(db, c.transferAccountId, Number(c.amount));
      }
    }

    await applyBalance(db, parent.accountId, Number(parent.amount));
    await db.delete(transactions).where(eq(transactions.parentId, parentId));
  });
}

/**
 * Delete a transaction. Cascade in the schema handles removing children
 * of a split parent when the parent is deleted, but we must still
 * reverse the children's balance effects beforehand.
 *
 *   - split parent: reverse each child's balance, then cascade deletes them
 *   - split child: reverse only its own balance (and if only 1 child remains, clean up parent)
 *   - transfer: reverse both source and destination balances
 *   - regular: reverse its own balance
 */
