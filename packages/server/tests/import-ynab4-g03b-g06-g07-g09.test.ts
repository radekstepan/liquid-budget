/**
 * import-ynab4-g03b-g06-g07-g09.test.ts
 *
 * Covers the YNAB4 fidelity gaps fixed together:
 *
 * - G-03 (remainder): `accounts.account_type_raw` preserves the verbatim
 *   YNAB4 account type (`kind` keeps driving app logic; the exporter
 *   prefers the raw value when present). `lastEnteredCheckNumber` has no
 *   column and is reported as a dropped warning.
 * - G-06: split legs with amount 0 import verbatim and zero-sum parents
 *   import with amount 0; only parents with literally no live children
 *   are skipped.
 * - G-07: explicit-zero budgets import whenever the month exists in
 *   YNAB4, per-category notes persist on `assignments.note`, and
 *   month-level `MonthlyBudget.note` is reported as dropped.
 * - G-09: stock-shaped files (no `reconciliations[]` array — stock YNAB4
 *   never writes one) create no reconciliation rows; only the
 *   account-level `lastReconciledAt/Balance` fields are set, while
 *   per-row `cleared: "Reconciled"` flags keep their "r" status.
 *   Exporter-shaped files (explicit array — our own extension) still
 *   import rows and links.
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { importYnab4 } from "../src/import-ynab4.js";
import { exportYnab4 } from "../src/export-ynab4.js";
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

describe("G-03 remainder: verbatim account types, dropped check numbers", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("preserves raw account types + notes, warns on lastEnteredCheckNumber, and round-trips raw types", async () => {
    const result = await importYnab4(db, {
      accounts: [
        {
          entityId: "acc_inv",
          accountName: "Brokerage",
          accountType: "InvestmentAccount",
          onBudget: false,
          note: "Retirement stash",
          lastEnteredCheckNumber: 42,
        },
        {
          entityId: "acc_mtg",
          accountName: "Mortgage",
          accountType: "Mortgage",
          onBudget: true,
          lastEnteredCheckNumber: -1,
        },
        { entityId: "acc_chk", accountName: "Checking", accountType: "Checking", onBudget: true },
      ],
      payees: [],
      masterCategories: [],
      transactions: [],
      monthlyBudgets: [],
      scheduledTransactions: [],
    });

    const accs = await db.select().from(schema.accounts);
    expect(accs).toHaveLength(3);
    const byName = new Map(accs.map((a) => [a.name, a]));

    // Raw types preserved verbatim; kind keeps the 3-way app mapping.
    expect(byName.get("Brokerage")).toMatchObject({
      accountTypeRaw: "InvestmentAccount",
      kind: "offbudget",
      notes: "Retirement stash",
    });
    expect(byName.get("Mortgage")).toMatchObject({ accountTypeRaw: "Mortgage", kind: "liquid" });
    expect(byName.get("Checking")).toMatchObject({ accountTypeRaw: "Checking", kind: "liquid" });

    // Only the non-default check number (42) is reported; -1/unset is YNAB4's default.
    expect(result.warnings.some((w) => w.includes("lastEnteredCheckNumber"))).toBe(true);
    expect(result.warnings.filter((w) => w.includes("lastEnteredCheckNumber"))).toHaveLength(1);

    // Export prefers the raw type and writes the note back.
    const { ynabData } = await exportYnab4(db);
    const byAccName = new Map(ynabData.accounts.map((a: any) => [a.accountName, a]));
    expect(byAccName.get("Brokerage")).toMatchObject({
      accountType: "InvestmentAccount",
      note: "Retirement stash",
    });
    expect(byAccName.get("Mortgage")).toMatchObject({ accountType: "Mortgage" });
    expect(byAccName.get("Checking")).toMatchObject({ accountType: "Checking" });
  });
});

describe("G-06: zero legs and zero-sum parents import verbatim", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("imports 0-amount legs and zero-sum parents; skips only childless parents", async () => {
    const result = await importYnab4(db, {
      accounts: [{ entityId: "acc1", accountName: "Checking", accountType: "Checking", onBudget: true }],
      payees: [{ entityId: "p1", name: "Store" }],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Everyday",
          type: "OUTFLOW",
          subCategories: [
            { entityId: "sc1", name: "Groceries" },
            { entityId: "sc2", name: "Household" },
          ],
        },
      ],
      transactions: [
        {
          entityId: "t_split",
          accountId: "acc1",
          date: "2026-06-01",
          amount: -100,
          cleared: "Cleared",
          payeeId: "p1",
          categoryId: "Category/__Split__",
          subTransactions: [
            { entityId: "st1", categoryId: "sc1", amount: -60, memo: "Food" },
            { entityId: "st2", categoryId: "sc2", amount: 0, memo: "Coupon (free)" },
            { entityId: "st3", categoryId: "sc1", amount: -40, memo: "More food" },
          ],
        },
        {
          entityId: "t_zero",
          accountId: "acc1",
          date: "2026-06-02",
          amount: 0,
          cleared: "Cleared",
          payeeId: "p1",
          categoryId: "Category/__Split__",
          subTransactions: [
            { entityId: "st4", categoryId: "sc1", amount: -25, memo: "Out" },
            { entityId: "st5", categoryId: "sc2", amount: 25, memo: "Back" },
          ],
        },
        {
          entityId: "t_empty",
          accountId: "acc1",
          date: "2026-06-03",
          amount: -10,
          cleared: "Cleared",
          payeeId: "p1",
          categoryId: "Category/__Split__",
          subTransactions: [{ entityId: "st6", categoryId: "sc1", amount: -10, isTombstone: true }],
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    });

    const txs = await db.select().from(schema.transactions);
    // 2 parents + 5 live children; only the all-tombstone parent skips.
    expect(txs).toHaveLength(7);

    const zeroLeg = txs.find((t) => t.memo === "Coupon (free)");
    expect(zeroLeg).toBeDefined();
    expect(Number(zeroLeg!.amount)).toBe(0);

    const zeroParent = txs.find((t) => t.entityId === "t_zero");
    expect(zeroParent).toBeDefined();
    expect(Number(zeroParent!.amount)).toBe(0);

    expect(result.duplicatesSkipped).toHaveLength(1);
    expect(result.duplicatesSkipped[0]).toMatchObject({
      reason: "Split transaction with no live children",
    });

    // Balance math is unaffected: parents are excluded from sums and
    // zero rows contribute 0 (-60 + 0 - 40 - 25 + 25 = -100).
    const [acc] = await db.select().from(schema.accounts);
    expect(Number(acc!.balance)).toBe(-10000);
  });
});

describe("G-07: explicit-zero budgets and budget notes", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("imports explicit zeros + per-category notes, warns on month-level notes, and round-trips", async () => {
    const fixture = {
      accounts: [{ entityId: "acc1", accountName: "Checking", accountType: "Checking", onBudget: true }],
      payees: [],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Everyday",
          type: "OUTFLOW",
          subCategories: [
            { entityId: "sc1", name: "Groceries" },
            { entityId: "sc2", name: "Household" },
          ],
        },
      ],
      transactions: [],
      monthlyBudgets: [
        {
          month: "2026-08-01",
          note: "Vacation month",
          monthlySubCategoryBudgets: [
            { categoryId: "sc1", budgeted: 200, note: "Groceries bump" },
            { categoryId: "sc2", budgeted: 0, note: "Paused" },
          ],
        },
        {
          month: "2026-09-01",
          monthlySubCategoryBudgets: [{ categoryId: "sc1", budgeted: 0 }],
        },
      ],
      scheduledTransactions: [],
    };
    const result = await importYnab4(db, fixture);

    const assigns = await db.select().from(schema.assignments);
    expect(assigns).toHaveLength(3);
    const key = (a: typeof assigns[number]) => `${a.month}/${a.categoryId}`;
    const cats = await db.select().from(schema.categories);
    const catIdByName = new Map(cats.map((c) => [c.name, c.id]));
    const byKey = new Map(assigns.map((a) => [key(a), a]));
    expect(byKey.get(`2026-08/${catIdByName.get("Groceries")}`)).toMatchObject({
      amount: 20000,
      note: "Groceries bump",
    });
    expect(byKey.get(`2026-08/${catIdByName.get("Household")}`)).toMatchObject({
      amount: 0,
      note: "Paused",
    });
    expect(byKey.get(`2026-09/${catIdByName.get("Groceries")}`)).toMatchObject({ amount: 0, note: "" });

    // The month-level note has no home and is reported, not silent.
    expect(result.warnings.some((w) => w.includes("month-level budget notes"))).toBe(true);

    // Re-export keeps explicit-zero months and per-category notes.
    const { ynabData } = await exportYnab4(db);
    const aug = ynabData.monthlyBudgets.find((mb: any) => mb.month === "2026-08-01");
    expect(aug).toBeDefined();
    const augGroceries = aug.monthlySubCategoryBudgets.find((b: any) => b.categoryId === "sc1");
    expect(augGroceries).toMatchObject({ budgeted: 200000, note: "Groceries bump" });
    const augHousehold = aug.monthlySubCategoryBudgets.find((b: any) => b.categoryId === "sc2");
    expect(augHousehold).toMatchObject({ budgeted: 0, note: "Paused" });
    const sep = ynabData.monthlyBudgets.find((mb: any) => mb.month === "2026-09-01");
    expect(sep).toBeDefined();
    expect(sep.monthlySubCategoryBudgets).toHaveLength(1);
  });
});

describe("G-09: no phantom precision for stock files", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("stock-shaped files set account fields only; export-shaped files import rows and links", async () => {
    // Stock shape: no `reconciliations[]` array at all.
    await importYnab4(db, {
      accounts: [
        {
          entityId: "acc_stock",
          accountName: "Checking",
          accountType: "Checking",
          onBudget: true,
          lastReconciledDate: "2026-05-15",
          lastReconciledBalance: 500,
        },
      ],
      payees: [{ entityId: "p1", name: "Store" }],
      masterCategories: [],
      transactions: [
        {
          entityId: "tx_r1",
          accountId: "acc_stock",
          date: "2026-05-01",
          amount: -50,
          cleared: "Reconciled",
          payeeId: "p1",
          categoryId: null,
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    });

    const [acc] = await db.select().from(schema.accounts);
    expect(acc?.lastReconciledAt).toBe("2026-05-15");
    expect(Number(acc?.lastReconciledBalance)).toBe(50000);

    // No phantom statement rows for stock files.
    expect(await db.select().from(schema.reconciliations)).toHaveLength(0);

    // The real per-row lock flag still imports as "r" (dateless round).
    const txs = await db.select().from(schema.transactions);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ status: "r", reconciliationId: null });

    // Exporter-shaped input (our own extension) still imports rows + links.
    const db2 = openMigratedDb();
    await importYnab4(db2, {
      accounts: [{ entityId: "acc_exp", accountName: "Checking", accountType: "Checking", onBudget: true }],
      payees: [{ entityId: "p1", name: "Store" }],
      masterCategories: [],
      reconciliations: [
        {
          entityId: "rec_round_1",
          accountId: "acc_exp",
          reconciledAt: "2026-05-31",
          statementDate: "2026-05-31",
          statementBalance: 1000,
        },
      ],
      transactions: [
        {
          entityId: "tx_r1",
          accountId: "acc_exp",
          date: "2026-05-01",
          amount: -50,
          cleared: "Reconciled",
          reconciliationId: "rec_round_1",
          payeeId: "p1",
          categoryId: null,
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    });

    const recs = await db2.select().from(schema.reconciliations);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ statementBalance: 100000 });
    const [linked] = await db2.select().from(schema.transactions);
    expect(linked).toMatchObject({ status: "r", reconciliationId: recs[0]!.id });
  });
});
