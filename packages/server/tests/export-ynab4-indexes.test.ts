import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import { exportYnab4 } from "../src/export-ynab4.js";
import { reconcileAccount } from "../src/queries/reconcile.js";
import { createRenameRule } from "../src/queries/rename-rules.js";
import type { Db } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

/**
 * P1 export-perf: per-row `Array.find` scans made export O(accounts x txns).
 * The lookups are now O(1) id/name maps. This test pins link integrity on a
 * many-account fixture (transfers, splits, reconciliations, renames, hidden
 * lineage) so a map regression surfaces as a dangling reference.
 */
type Ynab4ExportRowish = Record<string, unknown>;

describe("exportYnab4 lookup indexes (P1 export-perf)", () => {
  function openMigratedDb(): Db {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    const db = drizzle(raw, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
  }

  it("resolves every cross-reference on a 40-account fixture", async () => {    const db = openMigratedDb();
    const N = 40;
    const accountIds: number[] = [];
    for (let i = 0; i < N; i++) {
      const [a] = await db
        .insert(schema.accounts)
        .values({
          name: `Account ${i}`,
          kind: "liquid",
          groupLabel: "Budget Accounts",
          balance: 100000,
          onBudget: true,
          sort: i,
          entityId: i % 2 === 0 ? `acc-uuid-${i}` : null,
        })
        .returning();
      accountIds.push(a!.id);
    }
    const [group] = await db
      .insert(schema.categoryGroups)
      .values({ name: "Living", sort: 0, entityId: "group-uuid-living" })
      .returning();
    const [hiddenGroup] = await db
      .insert(schema.categoryGroups)
      .values({ name: "Hidden", sort: 1, isHidden: true, entityId: "MasterCategory/__Hidden__" })
      .returning();
    const [cat] = await db
      .insert(schema.categories)
      .values({ groupId: group!.id, name: "Groceries", sort: 0, entityId: "cat-uuid-groceries" })
      .returning();
    await db.insert(schema.categories).values({
      groupId: hiddenGroup!.id,
      name: "Old Sub",
      sort: 0,
      oldMasterEntityId: "group-uuid-living",
      oldMasterName: null,
    });

    // Chain transfers across all accounts + one regular txn each.
    for (let i = 0; i < N; i++) {
      const src = accountIds[i]!;
      const dest = accountIds[(i + 1) % N]!;
      await db.insert(schema.transactions).values({
        accountId: src,
        transferAccountId: dest,
        date: "2026-08-10",
        payee: `Transfer : Account ${(i + 1) % N}`,
        amount: -1000,
        status: "c",
      });
      await db.insert(schema.transactions).values({
        accountId: src,
        categoryId: cat!.id,
        date: "2026-08-11",
        payee: `Store ${i}`,
        memo: `memo ${i}`,
        amount: -100,
        status: "c",
      });
    }
    // One split with a transfer child on account 0.
    const [parent] = await db
      .insert(schema.transactions)
      .values({ accountId: accountIds[0], date: "2026-08-12", payee: "Split Store", amount: -500, status: "c" })
      .returning();
    await db.insert(schema.transactions).values([
      { accountId: accountIds[0], parentId: parent!.id, categoryId: cat!.id, date: "2026-08-12", payee: "Split Store", amount: -300, status: "c" },
      { accountId: accountIds[0], parentId: parent!.id, transferAccountId: accountIds[1], date: "2026-08-12", payee: "Split Store", amount: -200, status: "c" },
    ]);

    await createRenameRule(db, { sourcePattern: "STORE", targetPayee: "Standard Store", operator: "contains" });
    await createRenameRule(db, { sourcePattern: "Store 1", targetPayee: "Standard Store" });

    // Reconcile account 0 with a statement mismatch (posts an adjustment).
    await reconcileAccount(db, {
      accountId: accountIds[0]!,
      statementBalance: -999999,
      statementDate: "2026-08-15",
      adjustmentCategoryId: cat!.id,
    });

    const { ynabData } = await exportYnab4(db);

    // Every transferTransactionId cross-reference resolves both ways.
    // Every transferTransactionId cross-reference resolves both ways
    // (subTransactions live nested inside their parent row).
    const txByEntity = new Map<string, Ynab4ExportRowish>();
    for (const t of ynabData.transactions) {
      txByEntity.set(t.entityId as string, t as Ynab4ExportRowish);
      for (const s of (t.subTransactions as Ynab4ExportRowish[] | undefined) ?? []) {
        txByEntity.set(s.entityId as string, s);
      }
    }
    let linkedPairs = 0;
    for (const t of ynabData.transactions) {
      const target = t.transferTransactionId as string | undefined;
      if (target) {
        const peer = txByEntity.get(target);
        expect(peer, `dangling transferTransactionId ${target}`).toBeDefined();
        expect(peer!.transferTransactionId).toBe(t.entityId);
        linkedPairs++;
      }
    }
    expect(linkedPairs).toBeGreaterThan(N);

    // Every reconciliationId resolves; adjustment links resolve.
    const recEntities = new Set(ynabData.reconciliations.map((r) => r.entityId as string));
    for (const t of ynabData.transactions) {
      const recId = t.reconciliationId as string | null;
      if (recId != null) expect(recEntities.has(recId), `dangling reconciliationId ${recId}`).toBe(true);
    }
    for (const r of ynabData.reconciliations) {
      const adj = r.adjustmentTransactionId as string | null;
      if (adj != null) expect(txByEntity.has(adj), `dangling adjustmentTransactionId ${adj}`).toBe(true);
    }

    // Every payeeId resolves to an exported payee.
    const payeeEntities = new Set(ynabData.payees.map((p) => p.entityId as string));
    for (const t of ynabData.transactions) {
      if (t.payeeId != null) {
        expect(payeeEntities.has(t.payeeId as string), `dangling payeeId ${t.payeeId}`).toBe(true);
      }
    }

    // Rename conditions landed on the target payee entry.
    const standard = ynabData.payees.find((p) => p.name === "Standard Store");
    expect(standard).toBeDefined();
    expect((standard!.renameConditions as unknown[]).length).toBe(2);

    // Hidden-lineage category exports the mangled YNAB4 name.
    const hiddenMaster = ynabData.masterCategories.find((g) => g.entityId === "MasterCategory/__Hidden__");
    expect(hiddenMaster).toBeDefined();
    const mangled = (hiddenMaster!.subCategories as { name: string }[]).find((s) => s.name.includes("Old Sub"));
    expect(mangled!.name).toBe("Living ` Old Sub ` group-uuid-living");
  });
});
