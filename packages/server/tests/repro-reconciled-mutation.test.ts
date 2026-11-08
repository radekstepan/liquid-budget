/**
 * REPRO ONLY — `updateSplit` bypasses the reconciled-transfer dest-leg lock.
 *
 * YNAB4 contract (stock reference, read-only):
 * - `com/ynab/ynabData/vo/MatchableTransactionVO.as` carries per-row
 *   `cleared`; each side of a transfer is its own row with INDEPENDENT
 *   cleared state, linked by `transferTransactionId`
 *   (`BaseTransactionVO.transferTransactionId`).
 * - Reconciling flips `c` -> `r` per side (`Register.as` reconcile flow).
 *
 * Our model: one row per transfer with dual status (`status` = source leg,
 * `transferStatus` = dest leg). The reconcile flow flips each leg
 * independently (`reconcileAccount`'s flipSource/flipDest queries in
 * `packages/server/src/queries/reconcile.ts:193-226`).
 *
 * Our-side lock (`packages/server/src/queries/transactions.ts`):
 * - `updateTransaction` guards BOTH legs (`:764-776`): a row with
 *   `status === "r"` or `transferStatus === "r"` throws 422 unless the
 *   patch unreconciles that leg first. So amount/date edits of an `r`
 *   row, dest-leg edits of a reconciled transfer, and deletes of `r`
 *   rows are already rejected (verified green — not pinned here).
 * - `deleteTransaction` / `bulkDeleteTransactions` / `mergeTransactions`
 *   check both legs too (verified green — not pinned here).
 * - `updateSplit` (`:1219`) checks ONLY `parent.status === "r"`. The
 *   children check (`:1250`) only fires when old children exist, so
 *   converting a transfer (a childless row) to a split skips every
 *   reconciled check. A source-`r` transfer is still caught by the
 *   parent check, but a DEST-`r` transfer (`status: "c"`,
 *   `transferStatus: "r"`) sails through: the conversion strips the
 *   transfer linkage and the dest leg's reconciliation is silently
 *   destroyed. The source leg and the dest leg must lock alike
 *   (g-status pinned dual-status semantics).
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import path from "path";
import { fileURLToPath } from "url";
import { createTransaction, updateSplit } from "../src/queries/transactions.js";
import { reconcileAccount } from "../src/queries/reconcile.js";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openMigratedDb(): Db {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

async function seedAccount(db: Db, name: string): Promise<number> {
  const [account] = await db
    .insert(schema.accounts)
    .values({ name, kind: "liquid", groupLabel: "Budget Accounts", balance: 0, onBudget: true, sort: 0 })
    .returning();
  return account!.id;
}

async function seedCategory(db: Db, name: string, sort: number): Promise<number> {
  const [group] = await db
    .insert(schema.categoryGroups)
    .values({ name: `Group ${name}`, sort })
    .returning();
  const [cat] = await db
    .insert(schema.categories)
    .values({ groupId: group!.id, name, sort })
    .returning();
  return cat!.id;
}

/** Transfer A -> B, then reconcile ONLY the destination side. */
async function seedDestReconciledTransfer(db: Db): Promise<{ txId: number; destId: number }> {
  const srcId = await seedAccount(db, "Source");
  const destId = await seedAccount(db, "Dest");
  const tx = await createTransaction(db, {
    accountId: srcId,
    date: "2026-09-01",
    payee: "Transfer",
    amount: -100,
    transferAccountId: destId,
  });
  await reconcileAccount(db, {
    accountId: destId,
    statementBalance: 100,
    statementDate: "2026-09-30",
    adjustmentCategoryId: null,
  });
  return { txId: tx.id, destId };
}

describe("repro: reconciled-transfer dest leg locked like the source leg", () => {
  it("converting a dest-reconciled transfer to a split is rejected", async () => {
    const db = openMigratedDb();
    const cat1 = await seedCategory(db, "C1", 0);
    const cat2 = await seedCategory(db, "C2", 1);
    const { txId } = await seedDestReconciledTransfer(db);
    const before = db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txId))
      .get();
    expect(before).toMatchObject({ status: "c", transferStatus: "r" });

    // FAILS today: resolves (conversion proceeds) instead of rejecting
    // with 422; the dest leg's reconciliation is silently destroyed.
    await expect(
      updateSplit(
        db,
        txId,
        {},
        [
          { amount: -60, memo: "one", categoryId: cat1 },
          { amount: -40, memo: "two", categoryId: cat2 },
        ]
      )
    ).rejects.toMatchObject({ name: "TransactionError", status: 422 });
  });

  it("rewriting a dest-reconciled transfer into a split with a transfer leg is rejected", async () => {
    const db = openMigratedDb();
    const cat = await seedCategory(db, "C1", 0);
    const thirdId = await seedAccount(db, "Third");
    const { txId } = await seedDestReconciledTransfer(db);
    const before = db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txId))
      .get();
    expect(before).toMatchObject({ status: "c", transferStatus: "r" });

    // FAILS today: resolves (rewrite proceeds, replacing the reconciled
    // dest leg with a fresh transfer leg) instead of rejecting with 422.
    await expect(
      updateSplit(
        db,
        txId,
        {},
        [
          { amount: -40, memo: "one", categoryId: cat },
          { amount: -60, memo: "two", transferAccountId: thirdId },
        ]
      )
    ).rejects.toMatchObject({ name: "TransactionError", status: 422 });
  });
});
