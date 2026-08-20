import { inArray } from "drizzle-orm";
import type { ClearedStatus, DuplicateAnalysisResult, DuplicateEntry, TransactionFlagColor } from "@ynab/logic";
import { findDuplicateGroups } from "@ynab/logic";
import type { Db } from "../client.js";
import { accounts, transactions } from "../schema.js";

/**
 * Analyze the whole database for duplicate transactions and flag the
 * unflagged ones (yellow) so they stand out in the register.
 *
 * Only plain regular rows participate (no split parents/children, no
 * transfers). Reconciled duplicates are reported but never modified
 * (they are locked). Duplicates that already carry a flag are reported
 * but left untouched so the analysis is idempotent.
 */
export async function analyzeUnflaggedDuplicates(db: Db): Promise<DuplicateAnalysisResult> {
  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      date: transactions.date,
      payee: transactions.payee,
      memo: transactions.memo,
      amount: transactions.amount,
      flagColor: transactions.flagColor,
      status: transactions.status,
      parentId: transactions.parentId,
      transferAccountId: transactions.transferAccountId,
    })
    .from(transactions);

  const accRows = await db.select({ id: accounts.id, name: accounts.name }).from(accounts);
  const nameById = new Map(accRows.map((a) => [a.id, a.name]));

  const entries: DuplicateEntry[] = rows
    .map((r) => ({
      id: r.id,
      accountId: r.accountId,
      accountName: nameById.get(r.accountId) ?? "",
      date: r.date,
      payee: r.payee,
      memo: r.memo,
      amount: r.amount,
      flagColor: (r.flagColor as TransactionFlagColor | null) ?? null,
      status: (r.status as ClearedStatus) ?? "c",
      parentId: r.parentId,
      transferAccountId: r.transferAccountId,
    }))
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

  const groups = findDuplicateGroups(entries);

  const flagIds: number[] = [];
  let flaggedCount = 0;
  let alreadyFlaggedCount = 0;
  let lockedCount = 0;

  for (const group of groups) {
    for (const dup of group.duplicates) {
      if (dup.status === "r") {
        lockedCount++;
        continue;
      }
      if (dup.flagColor != null) {
        alreadyFlaggedCount++;
        continue;
      }
      if (dup.id != null) {
        flagIds.push(dup.id);
        flaggedCount++;
      }
    }
  }

  if (flagIds.length > 0) {
    await db
      .update(transactions)
      .set({ flagColor: "yellow" })
      .where(inArray(transactions.id, flagIds));
  }

  return {
    groups,
    duplicateCount: groups.reduce((n, g) => n + g.duplicates.length, 0),
    flaggedCount,
    alreadyFlaggedCount,
    lockedCount,
  };
}
