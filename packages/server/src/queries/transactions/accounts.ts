import { eq } from "drizzle-orm";
import { TransactionError } from "@ynab/logic";
import type { Database } from "../../client.js";
import { accounts } from "../../schema.js";

export async function isAccountOnBudget(db: Database, accountId: number): Promise<boolean> {
  const [row] = await db
    .select({ onBudget: accounts.onBudget })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row?.onBudget ?? true;
}

/**
 * Guard for closed accounts (`archived = true`). Used only when a row is
 * *moved* onto a different account (edits staying on the current account
 * remain allowed so history stays fixable). Creation paths piggyback on
 * their existing account lookups instead — see closedAccountMessage.
 */
export async function assertTargetAccountsOpen(db: Database, accountIds: (number | null | undefined)[]): Promise<void> {
  const ids = Array.from(new Set(accountIds.filter((id): id is number => id != null)));
  if (ids.length === 0) return;
  for (const id of ids) {
    const [row] = await db
      .select({ id: accounts.id, name: accounts.name, archived: accounts.archived })
      .from(accounts)
      .where(eq(accounts.id, id));
    const message = closedAccountMessage(
      row ? { archived: Boolean(row.archived), name: row.name } : null,
      id
    );
    if (message) {
      throw new TransactionError(message, 422);
    }
  }
}

export async function getAccountInfo(
  db: Database,
  accountId: number
): Promise<{ onBudget: boolean; kind: string; archived: boolean; name: string } | null> {
  const [row] = await db
    .select({ onBudget: accounts.onBudget, kind: accounts.kind, archived: accounts.archived, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!row) return null;
  const onBudget = row.onBudget ?? true;
  const kind = row.kind ?? (onBudget ? "liquid" : "offbudget");
  return { onBudget, kind, archived: Boolean(row.archived), name: row.name ?? "" };
}

/**
 * Fetch the fields needed to validate a transfer destination (budget
 * boundary + closed check) in a single lookup.
 */
export async function getTransferTargetInfo(
  db: Database,
  accountId: number
): Promise<{ onBudget: boolean; archived: boolean; name: string } | null> {
  const [row] = await db
    .select({ onBudget: accounts.onBudget, archived: accounts.archived, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!row) return null;
  return { onBudget: row.onBudget ?? true, archived: Boolean(row.archived), name: row.name ?? "" };
}

/**
 * Closed-account message helper. Returns the 422 message when the account
 * info indicates a closed (`archived`) account, or null when the target is
 * usable. Lets each query module throw its own error type
 * (TransactionError vs RecurringError) without extra lookups.
 */
export function closedAccountMessage(
  info: { archived?: boolean | null; name?: string | null } | null,
  fallbackId: number
): string | null {
  if (info?.archived) {
    return `Account "${info.name || fallbackId}" is closed. Reopen it before adding transactions.`;
  }
  return null;
}
