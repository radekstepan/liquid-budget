import { inArray } from "drizzle-orm";
import type {
  DuplicateAnalysisResult,
  DuplicateEntry,
  TransactionDuplicateFlag,
  TransactionFlagState,
} from "@ynab/logic";
import { findDuplicateGroups, TRANSACTION_DUPLICATE_FLAG } from "@ynab/logic";
import type { Db } from "../client.js";
import { accounts, duplicateIgnores, transactions } from "../schema.js";
import { withTransaction } from "../transaction.js";

/**
 * Analyze the whole database for duplicate transactions and mark the
 * unflagged ones with the internal "duplicate" flag so they stand out in
 * the register as a D badge.
 *
 * Only plain regular rows participate (no split parents/children, no
 * transfers). Reconciled duplicates are reported but never modified
 * (they are locked). Duplicates that already carry a manual flag are
 * reported but left untouched so the analysis never overrides a user
 * flag. Rows still carrying the "duplicate" marker that are no longer
 * part of an active duplicate group have it cleared. Groups the user
 * confirmed as legitimate (see {@link dismissDuplicateGroup}) are skipped
 * entirely, so confirmed rows are never re-flagged.
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
      flagColor: (r.flagColor as TransactionFlagState | null) ?? null,
      status: (r.status as "u" | "c" | "r") ?? "c",
      parentId: r.parentId,
      transferAccountId: r.transferAccountId,
    }))
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

  const ignoredRows = await db
    .select({ fingerprint: duplicateIgnores.fingerprint })
    .from(duplicateIgnores);
  const ignored = new Set(ignoredRows.map((r) => r.fingerprint));

  const groups = findDuplicateGroups(entries).filter((g) => !ignored.has(g.fingerprint));

  return withTransaction(db, async () => {
    // Ids that remain duplicates after this run (either newly marked or
    // already carrying the internal marker from a previous run).
    const activeDuplicateIds = new Set<number>();
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
          if (dup.flagColor === TRANSACTION_DUPLICATE_FLAG && dup.id != null) {
            activeDuplicateIds.add(dup.id);
          }
          continue;
        }
        if (dup.id != null) {
          flagIds.push(dup.id);
          activeDuplicateIds.add(dup.id);
          flaggedCount++;
        }
      }
    }

    if (flagIds.length > 0) {
      await db
        .update(transactions)
        .set({ flagColor: TRANSACTION_DUPLICATE_FLAG })
        .where(inArray(transactions.id, flagIds));
    }

    // Clear stale internal duplicate markers on rows that are no longer part
    // of an active duplicate group (and are not reconciled / locked).
    let clearedCount = 0;
    for (const r of rows) {
      if (r.id == null) continue;
      if (activeDuplicateIds.has(r.id)) continue;
      if (r.flagColor !== TRANSACTION_DUPLICATE_FLAG) continue;
      if (r.status === "r") continue;
      clearedCount++;
    }
    if (clearedCount > 0) {
      const staleIds = rows
        .filter(
          (r) =>
            r.id != null &&
            !activeDuplicateIds.has(r.id) &&
            r.flagColor === TRANSACTION_DUPLICATE_FLAG &&
            r.status !== "r"
        )
        .map((r) => r.id!);
      await db
        .update(transactions)
        .set({ flagColor: null })
        .where(inArray(transactions.id, staleIds));
    }

    const duplicateCount = groups.reduce(
      (n, g) => n + g.duplicates.length,
      0
    );

    return {
      groups,
      duplicateCount,
      flaggedCount,
      alreadyFlaggedCount,
      lockedCount,
      clearedCount,
    };
  });
}

/**
 * Confirm a duplicate group as legitimate. The fingerprint is recorded so
 * future analyses skip the group (see {@link analyzeUnflaggedDuplicates}),
 * and the internal duplicate marker is cleared from the group's rows
 * immediately so no re-run is needed to unflag them. Manual user flags are
 * never touched. Idempotent: dismissing twice, or dismissing a fingerprint
 * with no current group, succeeds without further changes.
 */
export async function dismissDuplicateGroup(
  db: Db,
  fingerprint: string
): Promise<{ dismissed: boolean; clearedCount: number }> {
  if (fingerprint.trim() === "") {
    throw new Error("fingerprint must not be empty");
  }
  return withTransaction(db, async () => {
    await db
      .insert(duplicateIgnores)
      .values({ fingerprint, createdAt: new Date().toISOString() })
      .onConflictDoNothing();

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

    const entries: DuplicateEntry[] = rows
      .map((r) => ({
        id: r.id,
        accountId: r.accountId,
        date: r.date,
        payee: r.payee,
        memo: r.memo,
        amount: r.amount,
        flagColor: (r.flagColor as TransactionFlagState | null) ?? null,
        status: (r.status as "u" | "c" | "r") ?? "c",
        parentId: r.parentId,
        transferAccountId: r.transferAccountId,
      }))
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

    const group = findDuplicateGroups(entries).find((g) => g.fingerprint === fingerprint);
    if (!group) {
      return { dismissed: true, clearedCount: 0 };
    }
    const memberIds = [group.keeper.id, ...group.duplicates.map((d) => d.id)].filter(
      (id): id is number => id != null
    );
    const clearIds = rows
      .filter(
        (r) =>
          r.id != null &&
          memberIds.includes(r.id) &&
          r.flagColor === TRANSACTION_DUPLICATE_FLAG &&
          r.status !== "r"
      )
      .map((r) => r.id!);
    if (clearIds.length > 0) {
      await db
        .update(transactions)
        .set({ flagColor: null })
        .where(inArray(transactions.id, clearIds));
    }
    return { dismissed: true, clearedCount: clearIds.length };
  });
}
