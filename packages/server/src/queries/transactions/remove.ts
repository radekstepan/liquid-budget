import { eq } from "drizzle-orm";
import { TransactionError } from "@ynab/logic";
import type { Database } from "../../client.js";
import { withTransaction } from "../../transaction.js";
import { transactions } from "../../schema.js";
import { applyBalance, getChildren } from "./shared.js";

export async function deleteTransaction(db: Database, id: number) {
  const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!existing) return null;

  if (existing.status === "r" || existing.transferStatus === "r") {
    throw new TransactionError(
      "Transaction is reconciled and locked. Unreconcile before deleting.",
      422
    );
  }

  if (existing.parentId != null) {
    const [parent] = await db.select().from(transactions).where(eq(transactions.id, existing.parentId));
    if (parent && (parent.status === "r" || parent.transferStatus === "r")) {
      throw new TransactionError(
        "Transaction is reconciled and locked. Unreconcile before deleting.",
        422
      );
    }
  }

  return withTransaction(db, async () => {
    const [current] = await db.select().from(transactions).where(eq(transactions.id, id));
    if (!current) return null;

    if (current.parentId != null) {
      await applyBalance(db, current.accountId, -Number(current.amount));
      if (current.transferAccountId != null) {
        await applyBalance(db, current.transferAccountId, Number(current.amount));
      }
      await db.delete(transactions).where(eq(transactions.id, id));

      // Check remaining children of the split parent.
      // If only 1 child remains, flatten the remaining child into a regular transaction and delete the parent.
      const remaining = await getChildren(db, current.parentId);
      if (remaining.length === 1) {
        const lastChild = remaining[0]!;
        const [parent] = await db
          .select()
          .from(transactions)
          .where(eq(transactions.id, current.parentId));

        const childPayee =
          lastChild.payee && lastChild.payee.trim() !== ""
            ? lastChild.payee
            : (parent?.payee ?? "");
        const childFlagColor = lastChild.flagColor ?? (parent?.flagColor ?? null);
        const childPayeeId = lastChild.payeeId ?? (parent?.payeeId ?? null);

        await db
          .update(transactions)
          .set({
            parentId: null,
            payee: childPayee,
            payeeId: childPayeeId,
            flagColor: childFlagColor,
          })
          .where(eq(transactions.id, lastChild.id));

        await db.delete(transactions).where(eq(transactions.id, current.parentId));
      } else if (remaining.length === 0) {
        await db.delete(transactions).where(eq(transactions.id, current.parentId));
      } else {
        const newTotal = remaining.reduce((sum, c) => sum + Number(c.amount), 0);
        await db
          .update(transactions)
          .set({ amount: newTotal })
          .where(eq(transactions.id, current.parentId));
      }
    } else if (current.transferAccountId != null) {
      await applyBalance(db, current.accountId, -Number(current.amount));
      await applyBalance(db, current.transferAccountId, Number(current.amount));
      await db.delete(transactions).where(eq(transactions.id, id));
    } else {
      const children = await getChildren(db, id);
      if (children.some((c) => c.status === "r" || c.transferStatus === "r")) {
        throw new TransactionError(
          "Reconciled split transaction cannot be deleted. Unreconcile before deleting.",
          422
        );
      }
      if (children.length > 0) {
        for (const c of children) {
          await applyBalance(db, c.accountId, -Number(c.amount));
          if (c.transferAccountId != null) {
            await applyBalance(db, c.transferAccountId, Number(c.amount));
          }
        }
      } else {
        await applyBalance(db, current.accountId, -Number(current.amount));
      }
      await db.delete(transactions).where(eq(transactions.id, id));
    }

    return existing;
  });
}

/**
 * Bulk delete transactions in an atomic transaction.
 * Reconciled transactions ("r") are rejected with TransactionError (422).
 */

export async function bulkDeleteTransactions(db: Database, ids: number[]) {
  if (!ids || ids.length === 0) return [];
  return withTransaction(db, async () => {
    type DeletedTransactionRow = { id: number } & Partial<typeof transactions.$inferSelect>;
    const deleted: DeletedTransactionRow[] = [];
    const deletedIds = new Set<number>();
    for (const id of ids) {
      if (deletedIds.has(id)) continue;
      const [existing] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!existing) continue;
      if (existing.status === "r" || existing.transferStatus === "r") {
        throw new TransactionError(
          `Transaction ${id} is reconciled and locked. Unreconcile before deleting.`,
          422
        );
      }
      if (existing.parentId != null) {
        const [parent] = await db.select().from(transactions).where(eq(transactions.id, existing.parentId));
        if (parent && (parent.status === "r" || parent.transferStatus === "r")) {
          throw new TransactionError(
            `Transaction ${id} is reconciled and locked. Unreconcile before deleting.`,
            422
          );
        }
        await applyBalance(db, existing.accountId, -Number(existing.amount));
        if (existing.transferAccountId != null) {
          await applyBalance(db, existing.transferAccountId, Number(existing.amount));
        }
        await db.delete(transactions).where(eq(transactions.id, id));
        deleted.push(existing);
        deletedIds.add(id);

        // Check remaining children of the split parent.
        const remaining = await getChildren(db, existing.parentId);
        if (remaining.length === 1) {
          const lastChild = remaining[0]!;
          const childPayee =
            lastChild.payee && lastChild.payee.trim() !== ""
              ? lastChild.payee
              : (parent?.payee ?? "");
          const childFlagColor = lastChild.flagColor ?? (parent?.flagColor ?? null);
          const childPayeeId = lastChild.payeeId ?? (parent?.payeeId ?? null);

          await db
            .update(transactions)
            .set({
              parentId: null,
              payee: childPayee,
              payeeId: childPayeeId,
              flagColor: childFlagColor,
            })
            .where(eq(transactions.id, lastChild.id));

          await db.delete(transactions).where(eq(transactions.id, existing.parentId));
        } else if (remaining.length === 0) {
          await db.delete(transactions).where(eq(transactions.id, existing.parentId));
        } else {
          const newTotal = remaining.reduce((sum, c) => sum + Number(c.amount), 0);
          await db
            .update(transactions)
            .set({ amount: newTotal })
            .where(eq(transactions.id, existing.parentId));
        }
      } else {
        const children = await getChildren(db, id);
        if (children.some((c) => c.status === "r" || c.transferStatus === "r")) {
          throw new TransactionError(
            `Reconciled split transaction ${id} cannot be deleted. Unreconcile before deleting.`,
            422
          );
        }
        if (children.length > 0) {
          for (const c of children) {
            await applyBalance(db, c.accountId, -Number(c.amount));
            if (c.transferAccountId != null) {
              await applyBalance(db, c.transferAccountId, Number(c.amount));
            }
            deleted.push(c);
            deletedIds.add(c.id);
          }
          await db.delete(transactions).where(eq(transactions.parentId, id));
        } else {
          await applyBalance(db, existing.accountId, -Number(existing.amount));
          if (existing.transferAccountId != null) {
            await applyBalance(db, existing.transferAccountId, Number(existing.amount));
          }
        }
        await db.delete(transactions).where(eq(transactions.id, id));
        deleted.push(existing);
        deletedIds.add(id);
      }
    }
    return deleted;
  });
}
