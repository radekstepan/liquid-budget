import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { todayISO } from "@ynab/logic";
import type { Database } from "../client.js";
import { withTransaction } from "../transaction.js";
import { accounts, categories, recurring, recurringSubTransactions, transactions } from "../schema.js";
import { assertValidAmount } from "./transactions.js";

export class AccountError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "AccountError";
  }
}

export type CreateAccountInput = {
  name: string;
  kind?: string;
  groupLabel?: string;
  balance?: number;
  onBudget?: boolean;
  archived?: boolean;
};

export type UpdateAccountInput = {
  name?: string;
  kind?: "liquid" | "credit" | "offbudget";
  groupLabel?: string;
  onBudget?: boolean;
  sort?: number;
  archived?: boolean;
};

export async function createAccount(db: Database, input: CreateAccountInput) {
  const balance = input.balance != null ? assertValidAmount(input.balance) : 0;
  const kind = String(input.kind ?? "liquid");
  const onBudget = input.onBudget !== undefined ? Boolean(input.onBudget) : kind !== "offbudget";

  if (kind === "offbudget" && onBudget === true) {
    throw new AccountError("Off-budget accounts cannot have onBudget set to true", 400);
  }
  if (kind !== "offbudget" && onBudget === false) {
    throw new AccountError("Liquid/credit accounts cannot have onBudget set to false", 400);
  }

  return withTransaction(db, async () => {
    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${accounts.sort}), -1)` })
      .from(accounts);
    const [row] = await db
      .insert(accounts)
      .values({
        name: String(input.name),
        kind,
        groupLabel: String(input.groupLabel ?? "Liquid"),
        balance,
        onBudget,
        sort: Number(maxRow?.max ?? -1) + 1,
        archived: input.archived ?? false,
      })
      .returning();
    if (!row) {
      throw new AccountError("Failed to create account");
    }

    if (balance !== 0) {
      await db.insert(transactions).values({
        accountId: row.id,
        categoryId: null,
        date: todayISO(),
        payee: "Starting Balance",
        memo: "",
        amount: balance,
        status: "c",
        isIncome: onBudget && balance > 0,
        transferAccountId: null,
        parentId: null,
      });
    }

    return row;
  });
}

export async function getAccount(db: Database, id: number) {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  return row;
}

export async function updateAccount(db: Database, id: number, patch: UpdateAccountInput) {
  const p: Record<string, unknown> = {};
  if (patch.name !== undefined && patch.name != null) p.name = String(patch.name);
  if (patch.groupLabel !== undefined && patch.groupLabel != null) p.groupLabel = String(patch.groupLabel);
  if (patch.sort !== undefined && patch.sort != null) p.sort = Number(patch.sort);
  if (patch.archived !== undefined && patch.archived != null) p.archived = !!patch.archived;

  const touchesTypeOrBoundary = patch.kind !== undefined || patch.onBudget !== undefined;

  return withTransaction(db, async () => {
    if (touchesTypeOrBoundary) {
      const [existing] = await db.select().from(accounts).where(eq(accounts.id, id));
      if (!existing) {
        throw new AccountError(`Account ${id} not found`, 404);
      }

      const nextKind = patch.kind !== undefined && patch.kind !== null ? String(patch.kind) : existing.kind;
      const nextOnBudget =
        patch.onBudget !== undefined && patch.onBudget !== null
          ? Boolean(patch.onBudget)
          : patch.kind !== undefined && patch.kind !== null
          ? nextKind !== "offbudget"
          : Boolean(existing.onBudget);

      const isKindChanging = nextKind !== existing.kind;
      const isOnBudgetChanging = nextOnBudget !== Boolean(existing.onBudget);

      if (isKindChanging || isOnBudgetChanging) {
        const [tx] = await db
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            or(
              eq(transactions.accountId, id),
              eq(transactions.transferAccountId, id)
            )
          )
          .limit(1);

        if (tx) {
          throw new AccountError(
            "Cannot change account type or budget participation when transactions exist",
            422
          );
        }

        if (nextKind === "offbudget" && nextOnBudget === true) {
          throw new AccountError("Off-budget accounts cannot have onBudget set to true", 400);
        }
        if (nextKind !== "offbudget" && nextOnBudget === false) {
          throw new AccountError("Liquid/credit accounts cannot have onBudget set to false", 400);
        }

        p.kind = nextKind;
        p.onBudget = nextOnBudget;
      } else {
        if (patch.kind !== undefined && patch.kind !== null) p.kind = nextKind;
        if (patch.onBudget !== undefined && patch.onBudget !== null) p.onBudget = nextOnBudget;
      }
    }

    if (Object.keys(p).length === 0) {
      const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
      return row;
    }
    const [row] = await db.update(accounts).set(p).where(eq(accounts.id, id)).returning();
    return row;
  });
}

/**
 * Delete an account cleanly.
 *
 * To avoid creating half-transfers (where the counterparty row in another account
 * has its transferAccountId set to NULL and becomes an orphaned uncategorized
 * transaction or phantom income), we explicitly find and delete all counterparty
 * transactions pointing to this account, reversing their balance effects,
 * as well as recurring transfer rules and linked categories.
 */
export async function deleteAccount(db: Database, id: number) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!account) return null;

  return withTransaction(db, async () => {
    // Check if the account contains any reconciled transactions
    const [reconciled] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.accountId, id), eq(transactions.status, "r")))
      .limit(1);

    if (reconciled) {
      throw new AccountError(
        "Account contains reconciled transactions. Unreconcile before deleting.",
        422
      );
    }

    // 1. Clean up transfer counterparty transactions where transferAccountId = id
    const counterparties = await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amount: transactions.amount,
        parentId: transactions.parentId,
        status: transactions.status,
        transferAccountId: transactions.transferAccountId,
      })
      .from(transactions)
      .where(eq(transactions.transferAccountId, id));

    for (const cp of counterparties) {
      const [existing] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, cp.id));
      if (!existing) continue;

      if (existing.status === "r") {
        throw new AccountError(
          `Transaction ${existing.id} is reconciled and locked. Unreconcile before deleting.`,
          422
        );
      }

      if (existing.parentId != null) {
        // Check if the split parent is reconciled
        const [parent] = await db
          .select()
          .from(transactions)
          .where(eq(transactions.id, existing.parentId));
        if (parent && parent.status === "r") {
          throw new AccountError(
            `Reconciled split transaction ${parent.id} cannot be modified. Unreconcile before deleting.`,
            422
          );
        }

        // Reverse balance for this child on its own account
        await db
          .update(accounts)
          .set({ balance: sql`${accounts.balance} - ${Number(existing.amount)}` })
          .where(eq(accounts.id, existing.accountId));

        // Delete the split child
        await db.delete(transactions).where(eq(transactions.id, existing.id));

        // Check remaining children of the split parent.
        const remaining = await db
          .select({
            id: transactions.id,
            accountId: transactions.accountId,
            amount: transactions.amount,
            transferAccountId: transactions.transferAccountId,
            status: transactions.status,
          })
          .from(transactions)
          .where(eq(transactions.parentId, existing.parentId));

        if (remaining.length === 1) {
          const lastChild = remaining[0]!;
          if (lastChild.status === "r") {
            throw new AccountError(
              `Transaction ${lastChild.id} is reconciled and locked. Unreconcile before deleting.`,
              422
            );
          }
          await db
            .update(accounts)
            .set({ balance: sql`${accounts.balance} - ${Number(lastChild.amount)}` })
            .where(eq(accounts.id, lastChild.accountId));

          if (lastChild.transferAccountId != null) {
            await db
              .update(accounts)
              .set({ balance: sql`${accounts.balance} + ${Number(lastChild.amount)}` })
              .where(eq(accounts.id, lastChild.transferAccountId));
          }
          await db.delete(transactions).where(eq(transactions.id, lastChild.id));
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
        await db
          .update(accounts)
          .set({ balance: sql`${accounts.balance} - ${Number(existing.amount)}` })
          .where(eq(accounts.id, existing.accountId));
        await db.delete(transactions).where(eq(transactions.id, existing.id));
      }
    }

    // 2. Reverse balance effects on other accounts for own transfers where transferAccountId IS NOT NULL
    // (children included, split parents excluded)
    const ownTransfers = await db
      .select({
        id: transactions.id,
        transferAccountId: transactions.transferAccountId,
        amount: transactions.amount,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, id),
          isNotNull(transactions.transferAccountId),
          sql`${transactions.id} NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`
        )
      );

    for (const tx of ownTransfers) {
      if (tx.transferAccountId != null) {
        await db
          .update(accounts)
          .set({ balance: sql`${accounts.balance} + ${Number(tx.amount)}` })
          .where(eq(accounts.id, tx.transferAccountId));
      }
    }

    // 3. Clean up recurring transfer counterparties
    await db.delete(recurring).where(eq(recurring.transferAccountId, id));
    await db.delete(recurringSubTransactions).where(eq(recurringSubTransactions.transferAccountId, id));

    // 4. Clean up linked categories (e.g. credit card payment categories)
    await db.delete(categories).where(eq(categories.linkedAccountId, id));

    // 5. Delete the account itself (SQLite cascade handles own transactions/recurring)
    await db.delete(accounts).where(eq(accounts.id, id));

    return account;
  });
}

export async function listAccounts(db: Database) {
  return db.select().from(accounts).orderBy(accounts.sort);
}
