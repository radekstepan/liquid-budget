/**
 * import-ynab4.integration.test.ts
 *
 * Full-path integration test for `importYnab4` against a real migrated
 * in-memory SQLite DB. The existing `import-ynab4.test.ts` only covers
 * `recomputeAccountBalances` and the BEGIN/COMMIT/ROLLBACK contract via
 * a mock DB; this exercises the actual mapping logic:
 *
 *   - tombstone skipping for accounts/payees/groups/subcategories
 *   - account kind/groupLabel derivation from YNAB4 account types
 *   - "Hidden Categories" and non-OUTFLOW master category skipping
 *   - credit-card payment group + per-credit-account categories
 *   - budgeted assignments (zero-budgeted rows skipped)
 *   - transfer detection via `targetAccountId` and the
 *     "Payee/Transfer:acc" payee convention
 *   - __ImmediateIncome__/__Split__ category → null mapping
 *   - split parents + children with parentId linkage
 *   - cleared-status mapping (Cleared → c, Uncleared → u, Reconciled → r)
 *   - scheduled frequency fallback and split/transfer scheduled rows
 *   - account balance recomputation including incoming transfers
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { isNotNull } from "drizzle-orm";
import path from "path";
import { fileURLToPath } from "url";
import { importYnab4 } from "../src/import-ynab4.js";
import { getBudgetData } from "../src/queries/budget.js";
import { postRecurringTransaction, updateRecurring } from "../src/queries/recurring.js";
import { unreconcileAccount } from "../src/queries/reconcile.js";
import { verifyBudgetIntegrity } from "../src/queries/diagnostics.js";
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

const ynabData = {
  accounts: [
    { entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true },
    { entityId: "acc2", accountName: "Visa", accountType: "CreditCard", onBudget: true },
    { entityId: "acc3", accountName: "RRSP", accountType: "InvestmentAccount", onBudget: false },
    { entityId: "accX", accountName: "Deleted", accountType: "Checking", onBudget: true, isTombstone: true },
  ],
  payees: [
    { entityId: "p1", name: "Grocery Store" },
    { entityId: "p2", name: "Employer" },
    { entityId: "p3", name: "Biennial Insurer" },
    { entityId: "p4", name: "One-off Electrician" },
    { entityId: "pX", name: "Old Payee", isTombstone: true },
  ],
  masterCategories: [
    {
      entityId: "mc1",
      name: "Everyday",
      type: "OUTFLOW",
      subCategories: [
        { entityId: "sc1", name: "Groceries" },
        { entityId: "sc2", name: "Deleted Cat", isTombstone: true },
      ],
    },
    { entityId: "mc2", name: "Hidden Categories", type: "OUTFLOW", subCategories: [] },
    { entityId: "mc3", name: "Income", type: "INFLOW", subCategories: [] },
  ],
  transactions: [
    {
      entityId: "t1",
      accountId: "acc1",
      date: "2026-06-01",
      amount: -100,
      cleared: "Cleared",
      payeeId: "p1",
      categoryId: "sc1",
    },
    {
      entityId: "t2",
      accountId: "acc1",
      date: "2026-06-02",
      amount: -500,
      cleared: "Uncleared",
      payeeId: null,
      categoryId: null,
      targetAccountId: "acc2",
      transferTransactionId: "t3",
    },
    {
      entityId: "t3",
      accountId: "acc2",
      date: "2026-06-02",
      amount: 500,
      cleared: "Uncleared",
      payeeId: "Payee/Transfer:acc1",
      categoryId: null,
      targetAccountId: "acc1",
      transferTransactionId: "t2",
    },
    {
      entityId: "t4",
      accountId: "acc1",
      date: "2026-06-03",
      amount: 3000,
      cleared: "Reconciled",
      payeeId: "p2",
      categoryId: "Category/__ImmediateIncome__",
    },
    {
      entityId: "t5",
      accountId: "acc1",
      date: "2026-06-04",
      amount: -150,
      cleared: "Cleared",
      payeeId: "p1",
      categoryId: "Category/__Split__",
      subTransactions: [
        { categoryId: "sc1", amount: -100 },
        { categoryId: "sc3-missing", amount: -50 },
      ],
    },
    { entityId: "tX", accountId: "acc1", date: "2026-06-05", amount: -1, cleared: "Cleared", payeeId: "pX", categoryId: "sc1", isTombstone: true },
    { entityId: "tY", accountId: "missing-acc", date: "2026-06-06", amount: -1, cleared: "Cleared", payeeId: null, categoryId: null },
  ],
  monthlyBudgets: [
    {
      month: "2026-06-01",
      monthlySubCategoryBudgets: [
        { categoryId: "sc1", budgeted: 500 },
        { categoryId: "sc2", budgeted: 0 },
        { categoryId: "sc1", budgeted: 999, isTombstone: true },
      ],
    },
    {
      month: "2026-07-01",
      isTombstone: true,
      monthlySubCategoryBudgets: [
        { categoryId: "sc1", budgeted: 999 },
      ],
    },
  ],
  scheduledTransactions: [
    {
      entityId: "s1",
      accountId: "acc1",
      date: "2026-07-01",
      amount: -75,
      frequency: "monthly",
      payeeId: "p1",
      categoryId: "sc1",
      memo: "Monthly groceries recurring",
      flag: "Red",
    },
    {
      entityId: "s2",
      accountId: "acc1",
      date: "2026-07-02",
      amount: -100,
      frequency: "EVERYWEEK",
      payeeId: "p1",
      categoryId: "sc1",
    },
    {
      entityId: "s3",
      accountId: "acc1",
      date: "2026-07-03",
      amount: -200,
      frequency: "biweekly",
      payeeId: "Payee/Transfer:acc2",
      categoryId: null,
    },
    {
      entityId: "s4",
      accountId: "acc1",
      date: "2026-07-04",
      amount: -300,
      frequency: "monthly",
      payeeId: "p1",
      categoryId: "Category/__Split__",
      subTransactions: [
        { categoryId: "sc1", amount: -200, memo: "Split recurring child 1" },
        { categoryId: null, targetAccountId: "acc2", amount: -100, memo: "Split recurring child 2" },
      ],
    },
    {
      entityId: "s5",
      accountId: "acc1",
      date: "2026-07-05",
      amount: -500,
      frequency: "EveryOtherYear",
      payeeId: "p3",
      categoryId: "sc1",
      memo: "Biennial policy",
      flag: "Blue",
    },
    {
      entityId: "s6",
      accountId: "acc1",
      date: "2026-07-06",
      amount: -600,
      frequency: "Never",
      payeeId: "p4",
      categoryId: "sc1",
    },
    { entityId: "sX", accountId: "acc1", date: "2026-07-05", amount: -1, frequency: "monthly", payeeId: null, categoryId: null, isTombstone: true },
  ],
};

describe("importYnab4 full import", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("returns the expected row counts", async () => {
    const result = await importYnab4(db, ynabData);
    expect(result).toEqual({
      accounts: 3,
      categoryGroups: 3, // Everyday + "Hidden Categories" + "Credit Card Payments"
      categories: 1, // only mapped subcategories (sc1); CC-payment cats aren't in the map
      transactions: 6, // 1 regular + 1 transfer (de-duplicated from pair) + 1 income + 1 split parent + 2 split children
      duplicatesSkipped: [
        {
          accountName: "Visa",
          date: "2026-06-02",
          payee: "",
          memo: "",
          amount: 50000,
          reason: "Duplicate transfer counterpart",
        },
      ],
    });
  });

  it("maps account kinds and group labels", async () => {
    await importYnab4(db, ynabData);
    const { accounts } = await getBudgetData(db);
    expect(accounts).toHaveLength(3);
    const byName = new Map(accounts.map((a) => [a.name, a]));
    expect(byName.get("Chequing")).toMatchObject({ kind: "liquid", groupLabel: "Budget Accounts", onBudget: true });
    expect(byName.get("Visa")).toMatchObject({ kind: "credit", groupLabel: "Credit Cards", onBudget: true });
    expect(byName.get("RRSP")).toMatchObject({ kind: "offbudget", groupLabel: "Off Budget", onBudget: false });
    expect(byName.get("Deleted")).toBeUndefined();
  });

  it("skips non-outflow groups and tombstones, imports hidden groups, and creates the CC payment group", async () => {
    await importYnab4(db, ynabData);
    const { groups, categories } = await getBudgetData(db);
    const groupNames = groups.map((g) => g.name);
    expect(groupNames).toContain("Everyday");
    expect(groupNames).toContain("Hidden Categories");
    expect(groupNames).toContain("Credit Card Payments");
    expect(groupNames).not.toContain("Income");

    const catNames = categories.map((c) => c.name);
    expect(catNames).toContain("Groceries");
    expect(catNames).not.toContain("Deleted Cat");
    // The Visa credit account gets a payment category linked to it.
    const visaCat = categories.find((c) => c.name === "Visa");
    expect(visaCat).toBeTruthy();
    const ccGroup = groups.find((g) => g.isCreditCardPayments)!;
    expect(visaCat!.groupId).toBe(ccGroup.id);
  });

  it("imports transactions with payee, status, and transfer mapping", async () => {
    await importYnab4(db, ynabData);
    const { transactions } = await getBudgetData(db);
    const byPayee = new Map(transactions.map((t) => [t.payee, t]));

    // Tombstone, unknown-account rows, and duplicate transfer counterparts are dropped.
    expect(transactions).toHaveLength(6);

    const regular = byPayee.get("Grocery Store");
    expect(regular).toMatchObject({ amount: "-10000", status: "c", date: "2026-06-01" });

    const transfer = transactions.find((t) => t.payee.startsWith("Transfer :"));
    expect(transfer).toBeTruthy();
    expect(Number(transfer!.amount)).toBe(-50000);

    const income = byPayee.get("Employer");
    expect(income).toMatchObject({ amount: "300000", status: "r", categoryId: null });

    // Split parent + children are linked via parentId.
    const splitChildren = transactions.filter((t) => t.parentId != null);
    expect(splitChildren).toHaveLength(2);
    const splitParent = transactions.find((t) => t.amount === "-15000");
    expect(splitParent).toBeTruthy();
    for (const child of splitChildren) {
      expect(child.parentId).toBe(splitParent!.id);
    }
    // The child with an unmapped category is still imported (null cat).
    expect(splitChildren.some((c) => c.categoryId === null)).toBe(true);
  });

  it("BUG-16: populates the payees table and links transactions and recurring rows via payeeId", async () => {
    await importYnab4(db, ynabData);

    // One payees row per distinct non-tombstone YNAB4 payee (tombstone pX dropped)
    const payeeRows = await db.select().from(schema.payees).orderBy(schema.payees.id);
    expect(payeeRows.map((p) => p.name)).toEqual([
      "Grocery Store",
      "Employer",
      "Biennial Insurer",
      "One-off Electrician",
    ]);
    const payeeIdByName = new Map(payeeRows.map((p) => [p.name, p.id]));

    const txns = await db.select().from(schema.transactions);
    expect(txns).toHaveLength(6);

    // Transfers are modeled via transferAccountId and never link to a payee row
    const transferRows = txns.filter((t) => t.transferAccountId != null);
    expect(transferRows.length).toBeGreaterThan(0);
    for (const t of transferRows) {
      expect(t.payeeId).toBeNull();
    }

    // Every non-transfer transaction carries a non-null payeeId pointing at
    // the payees row matching its payee text (regular, split parent + children)
    const nonTransferRows = txns.filter((t) => t.transferAccountId == null);
    expect(nonTransferRows.length).toBeGreaterThan(0);
    for (const t of nonTransferRows) {
      expect(t.payeeId).toBe(payeeIdByName.get(t.payee));
    }

    // Split children inherit the parent payee link
    const childRows = txns.filter((t) => t.parentId != null);
    expect(childRows).toHaveLength(2);
    for (const c of childRows) {
      expect(c.payeeId).toBe(payeeIdByName.get("Grocery Store"));
    }

    // Scheduled rows link via recurring.payeeId; transfer scheduled rows stay null
    const recs = await db.select().from(schema.recurring);
    expect(recs).toHaveLength(6);
    for (const r of recs) {
      if (r.transferAccountId != null) {
        expect(r.payeeId).toBeNull();
      } else {
        expect(r.payeeId).toBe(payeeIdByName.get(r.payee));
      }
    }
  });

  it("carries over YNAB4 auto-fill categories as payee defaults, with history fallback", async () => {
    const data = {
      accounts: [
        { entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true },
      ],
      payees: [
        { entityId: "p1", name: "AutoFill Store", autoFillCategoryId: "sc9" },
        { entityId: "p2", name: "History Cafe", autoFillCategoryId: null },
        { entityId: "p3", name: "Income Boss", autoFillCategoryId: "Category/__ImmediateIncome__" },
        { entityId: "p4", name: "Ghost", autoFillCategoryId: "sc-missing" },
        { entityId: "p6", name: "Drifter", autoFillCategoryId: null },
        { entityId: "p5", name: "Transfer : Savings", targetAccountId: "acc9", autoFillCategoryId: "sc1" },
      ],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Everyday",
          type: "OUTFLOW",
          subCategories: [
            { entityId: "sc1", name: "Groceries" },
            { entityId: "sc9", name: "Dining" },
          ],
        },
      ],
      transactions: [
        // History says Groceries, but the explicit auto-fill (Dining) wins.
        { entityId: "t1", accountId: "acc1", date: "2026-06-01", amount: -100, cleared: "Cleared", payeeId: "p1", categoryId: "sc1" },
        { entityId: "t2", accountId: "acc1", date: "2026-06-02", amount: -75, cleared: "Cleared", payeeId: "p1", categoryId: "sc1" },
        // No auto-fill: most-used category (Groceries x3 over Dining x1) wins.
        { entityId: "t3", accountId: "acc1", date: "2026-06-01", amount: -100, cleared: "Cleared", payeeId: "p2", categoryId: "sc1" },
        { entityId: "t4", accountId: "acc1", date: "2026-06-02", amount: -200, cleared: "Cleared", payeeId: "p2", categoryId: "sc1" },
        { entityId: "t5", accountId: "acc1", date: "2026-06-03", amount: -300, cleared: "Cleared", payeeId: "p2", categoryId: "sc9" },
        { entityId: "t5b", accountId: "acc1", date: "2026-06-04", amount: -400, cleared: "Cleared", payeeId: "p2", categoryId: "sc1" },
        // Special income marker maps to no default.
        { entityId: "t6", accountId: "acc1", date: "2026-06-01", amount: 3000, cleared: "Cleared", payeeId: "p3", categoryId: "Category/__ImmediateIncome__" },
        // Weak history signal (1-1 split) mints no default.
        { entityId: "t7", accountId: "acc1", date: "2026-06-01", amount: -100, cleared: "Cleared", payeeId: "p6", categoryId: "sc1" },
        { entityId: "t8", accountId: "acc1", date: "2026-06-02", amount: -200, cleared: "Cleared", payeeId: "p6", categoryId: "sc9" },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    };
    await importYnab4(db, data);
    const rows = await db.select().from(schema.payees);
    const byName = new Map(rows.map((p) => [p.name, p]));
    const cats = await db.select().from(schema.categories);
    const catId = new Map(cats.map((c) => [c.entityId, c.id]));
    expect(byName.get("AutoFill Store")?.autoCategoryId).toBe(catId.get("sc9"));
    expect(byName.get("History Cafe")?.autoCategoryId).toBe(catId.get("sc1"));
    expect(byName.get("Income Boss")?.autoCategoryId).toBeNull();
    expect(byName.get("Ghost")?.autoCategoryId).toBeNull();
    expect(byName.get("Drifter")?.autoCategoryId).toBeNull();
    expect(byName.has("Transfer : Savings")).toBe(false);
  });

  it("imports assignments only for non-zero budgeted amounts and ignores tombstones", async () => {
    await importYnab4(db, ynabData);
    const { assignments } = await getBudgetData(db);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ amount: "50000", month: "2026-06" });
  });

  it("normalizes scheduled frequencies, transfers, and split children", async () => {
    await importYnab4(db, ynabData);
    const { recurring } = await getBudgetData(db);
    expect(recurring).toHaveLength(6);

    const byPayee = new Map(recurring.map((r) => [r.payee, r]));
    expect(byPayee.get("Grocery Store")).toBeTruthy();
    // EVERYWEEK is not a supported frequency → falls back to monthly.
    expect(byPayee.get("Grocery Store")!.frequency).toBe("monthly");

    // The transfer scheduled row resolves the "Payee/Transfer:" convention.
    const transferR = recurring.find((r) => r.transferAccountId != null)!;
    expect(transferR.payee).toBe("Transfer : Visa");
    expect(transferR.frequency).toBe("biweekly");
    expect(transferR.categoryId).toBeNull();

    // Split scheduled: children imported, parent category forced null.
    const splitR = recurring.find((r) => r.subTransactions.length > 0)!;
    expect(splitR.categoryId).toBeNull();
    expect(splitR.subTransactions).toHaveLength(2);
    expect(Number(splitR.subTransactions[0]!.amount)).toBe(-20000);
    expect(Number(splitR.subTransactions[1]!.amount)).toBe(-10000);
    expect(splitR.subTransactions[1]!.transferAccountId).toBeTruthy();

    // EveryOtherYear maps to every2years, Never maps to never
    const biennial = recurring.find((r) => Number(r.amount) === -50000);
    expect(biennial).toBeTruthy();
    expect(biennial!.frequency).toBe("every2years");
    expect(biennial!.memo).toBe("Biennial policy");
    expect(biennial!.flagColor).toBe("blue");

    const groceriesR = recurring.find((r) => r.payee === "Grocery Store" && r.memo === "Monthly groceries recurring");
    expect(groceriesR).toBeTruthy();
    expect(groceriesR!.memo).toBe("Monthly groceries recurring");
    expect(groceriesR!.flagColor).toBe("red");

    expect(splitR.subTransactions[0]!.memo).toBe("Split recurring child 1");
    expect(splitR.subTransactions[1]!.memo).toBe("Split recurring child 2");

    const oneOff = recurring.find((r) => Number(r.amount) === -60000);
    expect(oneOff).toBeTruthy();
    expect(oneOff!.frequency).toBe("never");
  });

  it("orients liquidation transfers (off-budget→on-budget) to the on-budget account as source", async () => {
    // Regression: a liquidation/sale from an off-budget account to an
    // on-budget account should be stored with the on-budget account as
    // the source and a positive amount, so spending trends doesn't
    // count it as positive spending.
    const data = {
      accounts: [
        { entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true },
        { entityId: "acc2", accountName: "RRSP", accountType: "InvestmentAccount", onBudget: false },
      ],
      payees: [],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Savings, Investments",
          type: "OUTFLOW",
          subCategories: [{ entityId: "sc1", name: "Retirement" }],
        },
      ],
      transactions: [
        {
          entityId: "t1",
          accountId: "acc2",
          targetAccountId: "acc1",
          transferTransactionId: "t2",
          date: "2026-01-15",
          amount: -300,
          cleared: "Cleared",
          payeeId: "Payee/Transfer:acc1",
          categoryId: null,
        },
        {
          entityId: "t2",
          accountId: "acc1",
          targetAccountId: "acc2",
          transferTransactionId: "t1",
          date: "2026-01-15",
          amount: 300,
          cleared: "Cleared",
          payeeId: "Payee/Transfer:acc2",
          categoryId: "sc1",
        },
      ],
      scheduledTransactions: [],
      monthlyBudgets: [],
    };

    await importYnab4(db, data);
    const budget = await getBudgetData(db);

    // Should be exactly 1 transaction (the deduplicated transfer row)
    expect(budget.transactions).toHaveLength(1);
    const tx = budget.transactions[0]!;

    // The on-budget account (Chequing) should be the source with a
    // positive amount, and the category should be preserved.
    const chequing = budget.accounts.find((a) => a.name === "Chequing")!;
    const rrsp = budget.accounts.find((a) => a.name === "RRSP")!;
    expect(tx.accountId).toBe(chequing.id);
    expect(tx.transferAccountId).toBe(rrsp.id);
    expect(Number(tx.amount)).toBe(30000);
    expect(tx.categoryId).not.toBeNull();
    expect(tx.payee).toBe("Transfer : RRSP");
  });

  it("recomputes balances correctly without double-counting transfers or split parents", async () => {
    await importYnab4(db, ynabData);
    const { accounts } = await getBudgetData(db);
    const byName = new Map(accounts.map((a) => [a.name, a]));

    // Chequing: -10000 (t1) - 50000 (t2 transfer to Visa) + 300000 (t4) - 10000 - 5000 (t5 split children; parent excluded)
    // = 225000 cents ($2,250.00).
    // Visa: +50000 (from incoming transfer of -50000: 0 - (-50000) = 50000).
    // RRSP has no transactions = 0.
    expect(Number(byName.get("Chequing")!.balance)).toBe(225000);
    expect(Number(byName.get("Visa")!.balance)).toBe(50000);
    expect(Number(byName.get("RRSP")!.balance)).toBe(0);
  });

  it("initializes credit card payment category carryover from card starting balance (UNI-25 / BUG-29)", async () => {
    const dataWithStartingBalance = {
      ...ynabData,
      transactions: [
        ...ynabData.transactions,
        {
          entityId: "t_cc_start",
          accountId: "acc2",
          amount: -750, // -$750.00 starting debt on Visa
          date: "2026-05-31",
          payeeId: "p_start",
          cleared: "Cleared",
        },
      ],
      payees: [
        ...ynabData.payees,
        { entityId: "p_start", name: "Starting Balance" },
      ],
    };

    await importYnab4(db, dataWithStartingBalance);
    const { categories } = await getBudgetData(db);
    const visaPaymentCat = categories.find((c) => c.name === "Visa")!;
    expect(visaPaymentCat).toBeTruthy();
    expect(Number(visaPaymentCat.carryover)).toBe(-75000); // -75000 cents (-$750.00 debt)
  });

  it("initializes credit card payment category carryover when starting balance payee is renamed or localized (BUG-06)", async () => {
    const dataWithRenamedStartingBalance = {
      ...ynabData,
      transactions: [
        ...ynabData.transactions,
        {
          entityId: "t_cc_start_renamed",
          accountId: "acc2",
          amount: -620, // -$620.00 starting debt on Visa
          date: "2026-05-15",
          payeeId: "p_start_renamed",
          cleared: "Cleared",
        },
      ],
      payees: [
        ...ynabData.payees,
        { entityId: "p_start_renamed", name: "Solde initial / Ancien compte" },
      ],
    };

    await importYnab4(db, dataWithRenamedStartingBalance);
    const { categories } = await getBudgetData(db);
    const visaPaymentCat = categories.find((c) => c.name === "Visa")!;
    expect(visaPaymentCat).toBeTruthy();
    expect(Number(visaPaymentCat.carryover)).toBe(-62000); // -62000 cents (-$620.00 debt)
  });

  it("deterministically picks the earliest starting transaction when multiple uncategorized transactions exist (BUG-06)", async () => {
    const dataWithMultipleUncategorized = {
      ...ynabData,
      transactions: [
        ...ynabData.transactions,
        {
          entityId: "t_cc_later",
          accountId: "acc2",
          amount: -300,
          date: "2026-05-20",
          payeeId: "p_custom",
          cleared: "Cleared",
        },
        {
          entityId: "t_cc_earlier",
          accountId: "acc2",
          amount: -800,
          date: "2026-05-10",
          payeeId: "p_custom",
          cleared: "Cleared",
        },
      ],
      payees: [
        ...ynabData.payees,
        { entityId: "p_custom", name: "Old debt balance" },
      ],
    };

    await importYnab4(db, dataWithMultipleUncategorized);
    const { categories } = await getBudgetData(db);
    const visaPaymentCat = categories.find((c) => c.name === "Visa")!;
    expect(visaPaymentCat).toBeTruthy();
    expect(Number(visaPaymentCat.carryover)).toBe(-80000); // -80000 cents from earliest 2026-05-10
  });

  it("does not seed carryover when credit card has only categorized transactions (BUG-06)", async () => {
    const dataWithOnlyCategorized = {
      ...ynabData,
      transactions: [
        ...ynabData.transactions,
        {
          entityId: "t_cc_purchase",
          accountId: "acc2",
          amount: -50,
          date: "2026-05-01",
          payeeId: "p1",
          categoryId: "sc1",
          cleared: "Cleared",
        },
      ],
    };

    await importYnab4(db, dataWithOnlyCategorized);
    const { categories } = await getBudgetData(db);
    const visaPaymentCat = categories.find((c) => c.name === "Visa")!;
    expect(visaPaymentCat).toBeTruthy();
    expect(Number(visaPaymentCat.carryover)).toBe(0);
  });

  it("imports plain identical transactions within the backup and flags unreconciled duplicates", async () => {
    const dupData = {
      accounts: [{ entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true }],
      payees: [{ entityId: "p1", name: "Store" }],
      masterCategories: [],
      transactions: [
        {
          entityId: "a",
          accountId: "acc1",
          date: "2026-06-01",
          amount: -100,
          cleared: "Cleared",
          payeeId: "p1",
          categoryId: null,
        },
        {
          entityId: "b",
          accountId: "acc1",
          date: "2026-06-01",
          amount: -100,
          cleared: "Cleared",
          payeeId: "p1",
          categoryId: null,
        },
        {
          entityId: "c",
          accountId: "acc1",
          date: "2026-06-01",
          amount: -100,
          cleared: "Cleared",
          payeeId: "p1",
          categoryId: null,
          memo: "different",
        },
        {
          entityId: "d1",
          accountId: "acc1",
          date: "2026-06-02",
          amount: -3,
          cleared: "Reconciled",
          payeeId: "p1",
          categoryId: null,
        },
        {
          entityId: "d2",
          accountId: "acc1",
          date: "2026-06-02",
          amount: -3,
          cleared: "Reconciled",
          payeeId: "p1",
          categoryId: null,
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    };

    const result = await importYnab4(db, dupData);
    expect(result.transactions).toBe(5);
    expect(result.duplicatesSkipped).toHaveLength(0);

    const { transactions } = await getBudgetData(db);
    expect(transactions).toHaveLength(5);

    // First occurrence 'a' is unflagged
    const unflaggedJune1 = transactions.filter((t) => t.date === "2026-06-01" && t.memo === "" && t.flagColor === null);
    expect(unflaggedJune1).toHaveLength(1);

    // Second occurrence 'b' is flagged duplicate
    const flaggedJune1 = transactions.filter((t) => t.date === "2026-06-01" && t.memo === "" && t.flagColor === "duplicate");
    expect(flaggedJune1).toHaveLength(1);

    // Different memo 'c' is unflagged
    const txC = transactions.find((t) => t.memo === "different");
    expect(txC).toBeDefined();
    expect(txC!.flagColor).toBeNull();

    // Reconciled identical rows 'd1' and 'd2' are NOT flagged as duplicate
    const reconciledRows = transactions.filter((t) => t.date === "2026-06-02");
    expect(reconciledRows).toHaveLength(2);
    for (const r of reconciledRows) {
      expect(r.flagColor).toBeNull();
      expect(r.status).toBe("r");
    }
  });

  it("imports live side of transfer pair when partner account is missing/tombstoned", async () => {
    const dataWithMissingPartnerAcc = {
      accounts: [
        { entityId: "accLive", accountName: "Checking", accountType: "Checking", onBudget: true },
        { entityId: "accDead", accountName: "Deleted Savings", accountType: "Savings", onBudget: true, isTombstone: true },
      ],
      payees: [
        { entityId: "p-dead", name: "Transfer : Deleted Savings" },
        { entityId: "p-live", name: "Transfer : Checking" },
      ],
      masterCategories: [],
      transactions: [
        // Live side is positive (+500), missing partner side is negative (-500)
        {
          entityId: "t-pos-live",
          accountId: "accLive",
          date: "2026-06-10",
          amount: 500,
          cleared: "Cleared",
          payeeId: "p-dead",
          categoryId: null,
          targetAccountId: "accDead",
          transferTransactionId: "t-neg-dead",
        },
        {
          entityId: "t-neg-dead",
          accountId: "accDead",
          date: "2026-06-10",
          amount: -500,
          cleared: "Cleared",
          payeeId: "p-live",
          categoryId: null,
          targetAccountId: "accLive",
          transferTransactionId: "t-pos-live",
        },
        // Live side is negative (-300), missing partner side is positive (+300)
        {
          entityId: "t-neg-live",
          accountId: "accLive",
          date: "2026-06-11",
          amount: -300,
          cleared: "Cleared",
          payeeId: "p-dead",
          categoryId: null,
          targetAccountId: "accDead",
          transferTransactionId: "t-pos-dead",
        },
        {
          entityId: "t-pos-dead",
          accountId: "accDead",
          date: "2026-06-11",
          amount: 300,
          cleared: "Cleared",
          payeeId: "p-live",
          categoryId: null,
          targetAccountId: "accLive",
          transferTransactionId: "t-neg-live",
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    };

    const result = await importYnab4(db, dataWithMissingPartnerAcc);
    expect(result.accounts).toBe(1);
    expect(result.transactions).toBe(2);

    const { accounts, transactions } = await getBudgetData(db);
    expect(accounts).toHaveLength(1);
    // Net balance: +$500 - $300 = +$200 = 20000 cents
    expect(Number(accounts[0]?.balance)).toBe(20000);

    expect(transactions).toHaveLength(2);

    const posTx = transactions.find((t) => t.date === "2026-06-10");
    expect(posTx).toBeDefined();
    expect(Number(posTx?.amount)).toBe(50000);
    expect(posTx?.transferAccountId).toBeNull();
    expect(posTx?.isIncome).toBe(true);

    const negTx = transactions.find((t) => t.date === "2026-06-11");
    expect(negTx).toBeDefined();
    expect(Number(negTx?.amount)).toBe(-30000);
    expect(negTx?.transferAccountId).toBeNull();
    expect(negTx?.isIncome).toBe(false);
  });

  it("imports scheduled split paychecks with income legs (Category/__ImmediateIncome__) and balances sub-rows", async () => {
    const paycheckData = {
      accounts: [
        { entityId: "acc1", accountName: "Checking", accountType: "Checking", onBudget: true },
        { entityId: "acc2", accountName: "401k", accountType: "InvestmentAccount", onBudget: false },
      ],
      payees: [
        { entityId: "p-emp", name: "Acme Corp" },
      ],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Deductions",
          type: "OUTFLOW",
          subCategories: [
            { entityId: "sc-tax", name: "Taxes" },
          ],
        },
      ],
      transactions: [],
      monthlyBudgets: [],
      scheduledTransactions: [
        {
          entityId: "s-paycheck",
          accountId: "acc1",
          date: "2026-07-15",
          amount: 2500, // Net paycheck +$2,500.00
          frequency: "biweekly",
          payeeId: "p-emp",
          categoryId: "Category/__Split__",
          subTransactions: [
            // Income leg: +$3,000.00 gross pay
            { categoryId: "Category/__ImmediateIncome__", amount: 3000, memo: "Gross pay" },
            // Deduction: -$300.00 taxes
            { categoryId: "sc-tax", amount: -300, memo: "Federal tax" },
            // Transfer to 401k: -$200.00
            { categoryId: null, targetAccountId: "acc2", amount: -200, memo: "401k contribution" },
          ],
        },
      ],
    };

    await importYnab4(db, paycheckData);
    const { recurring } = await getBudgetData(db);
    expect(recurring).toHaveLength(1);

    const r = recurring[0]!;
    expect(r.payee).toBe("Acme Corp");
    expect(Number(r.amount)).toBe(250000); // 250000 cents
    expect(r.categoryId).toBeNull();
    expect(r.subTransactions).toHaveLength(3);

    // Verify sub-transactions
    const [subIncome, subTax, subTransfer] = r.subTransactions;
    expect(subIncome).toMatchObject({
      categoryId: null,
      transferAccountId: null,
      memo: "Gross pay",
    });
    expect(Number(subIncome!.amount)).toBe(300000); // +$3,000.00

    expect(subTax).toMatchObject({
      memo: "Federal tax",
    });
    expect(subTax!.categoryId).not.toBeNull();
    expect(Number(subTax!.amount)).toBe(-30000); // -$300.00

    expect(subTransfer).toMatchObject({
      memo: "401k contribution",
    });
    expect(subTransfer!.categoryId).not.toBeNull();
    expect(subTransfer!.transferAccountId).not.toBeNull();
    expect(Number(subTransfer!.amount)).toBe(-20000); // -$200.00

    // Sum of children matches parent amount
    const sum = r.subTransactions.reduce((acc, s) => acc + Number(s.amount), 0);
    expect(sum).toBe(Number(r.amount));
  });

  it("supports round-trip import, editing, and posting of income-leg recurring splits", async () => {
    const paycheckData = {
      accounts: [
        { entityId: "acc1", accountName: "Checking", accountType: "Checking", onBudget: true },
        { entityId: "acc2", accountName: "Savings", accountType: "Savings", onBudget: true },
      ],
      payees: [
        { entityId: "p-emp", name: "Acme Corp" },
      ],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Deductions",
          type: "OUTFLOW",
          subCategories: [
            { entityId: "sc-tax", name: "Taxes" },
          ],
        },
      ],
      transactions: [],
      monthlyBudgets: [],
      scheduledTransactions: [
        {
          entityId: "s-paycheck",
          accountId: "acc1",
          date: "2026-07-15",
          amount: 2500, // Net paycheck +$2,500.00
          frequency: "biweekly",
          payeeId: "p-emp",
          categoryId: "Category/__Split__",
          subTransactions: [
            { categoryId: "Category/__ImmediateIncome__", amount: 3000, memo: "Gross pay" },
            { categoryId: "sc-tax", amount: -300, memo: "Federal tax" },
            { categoryId: null, targetAccountId: "acc2", amount: -200, memo: "Savings transfer" },
          ],
        },
      ],
    };

    // 1. Import
    await importYnab4(db, paycheckData);
    let budget = await getBudgetData(db);
    expect(budget.recurring).toHaveLength(1);
    const recurringRow = budget.recurring[0]!;
    const taxCat = budget.categories.find((c) => c.name === "Taxes")!;
    const savings = budget.accounts.find((a) => a.name === "Savings")!;
    const checking = budget.accounts.find((a) => a.name === "Checking")!;

    // 2. Edit through updateRecurring (replaces subTransactions with updated income-leg split)
    const updated = await updateRecurring(db, recurringRow.id, {
      amount: 260000, // Updated net: +$2,600.00
      subTransactions: [
        { categoryId: null, amount: 320000, memo: "Gross pay (raised)" }, // Income leg: +$3,200.00
        { categoryId: taxCat.id, amount: -35000, memo: "Federal tax (adjusted)" }, // -$350.00
        { categoryId: null, transferAccountId: savings.id, amount: -25000, memo: "Savings transfer (raised)" }, // -$250.00
      ],
    });
    expect(updated).not.toBeNull();
    expect(Number(updated?.amount)).toBe(260000);

    // Verify DB state after edit
    budget = await getBudgetData(db);
    const editedRecurring = budget.recurring[0]!;
    expect(editedRecurring.subTransactions).toHaveLength(3);
    expect(editedRecurring.subTransactions[0]).toMatchObject({
      categoryId: null,
      transferAccountId: null,
      amount: "320000",
      memo: "Gross pay (raised)",
    });

    // 3. Post recurring transaction
    const postResult = await postRecurringTransaction(db, recurringRow.id);
    expect(postResult.transaction).toBeDefined();
    expect(postResult.nextDate).toBe("2026-07-29"); // Advanced by 2 weeks (biweekly)

    // 4. Verify posted split transactions in budget
    budget = await getBudgetData(db);
    expect(budget.transactions).toHaveLength(4); // 1 parent + 3 children

    const parentTx = budget.transactions.find((t) => t.parentId === null);
    expect(parentTx).toBeDefined();
    expect(Number(parentTx?.amount)).toBe(260000);
    expect(parentTx?.payee).toBe("Acme Corp");
    expect(parentTx?.date).toBe("2026-07-15");

    const children = budget.transactions.filter((t) => t.parentId === parentTx?.id);
    expect(children).toHaveLength(3);

    const incomeChild = children.find((c) => c.memo === "Gross pay (raised)");
    expect(incomeChild).toBeDefined();
    expect(Number(incomeChild?.amount)).toBe(320000);
    expect(incomeChild?.categoryId).toBeNull();
    expect(incomeChild?.transferAccountId).toBeNull();
    expect(incomeChild?.isIncome).toBe(true);

    const taxChild = children.find((c) => c.memo === "Federal tax (adjusted)");
    expect(taxChild).toBeDefined();
    expect(Number(taxChild?.amount)).toBe(-35000);
    expect(taxChild?.categoryId).toBe(taxCat.id);
    expect(taxChild?.isIncome).toBe(false);

    const transferChild = children.find((c) => c.memo === "Savings transfer (raised)");
    expect(transferChild).toBeDefined();
    expect(Number(transferChild?.amount)).toBe(-25000);
    expect(transferChild?.transferAccountId).toBe(savings.id);

    // 5. Verify account balances
    // Checking: +320000 (income) - 35000 (tax) - 25000 (transfer out) = +260000 cents ($2,600.00)
    // Savings: +25000 cents (incoming transfer from checking)
    const updatedChecking = budget.accounts.find((a) => a.id === checking.id)!;
    const updatedSavings = budget.accounts.find((a) => a.id === savings.id)!;
    expect(Number(updatedChecking.balance)).toBe(260000);
    expect(Number(updatedSavings.balance)).toBe(25000);
  });

  it("BUG-14: imports real reconciliations row, links transactions to reconciliationId, and unreconcile reliably unlocks all rows", async () => {
    const importData = {
      accounts: [
        {
          entityId: "acc_rec",
          accountName: "Reconciled Chequing",
          accountType: "Checking",
          onBudget: true,
          lastReconciledDate: "2026-05-15",
          lastReconciledBalance: 500, // $500.00 = 50000 cents
        },
      ],
      payees: [
        { entityId: "p1", name: "Store A" },
        { entityId: "p2", name: "Store B" },
      ],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Daily",
          type: "OUTFLOW",
          subCategories: [{ entityId: "sc1", name: "Food" }],
        },
      ],
      transactions: [
        {
          entityId: "tx_r1",
          accountId: "acc_rec",
          date: "2026-04-10",
          amount: 200,
          cleared: "Reconciled",
          payeeId: "p1",
          categoryId: "sc1",
        },
        {
          entityId: "tx_r2",
          accountId: "acc_rec",
          date: "2026-05-01",
          amount: 300,
          cleared: "Reconciled",
          payeeId: "p2",
          categoryId: "sc1",
        },
        {
          entityId: "tx_u1",
          accountId: "acc_rec",
          date: "2026-05-20",
          amount: -50,
          cleared: "Uncleared",
          payeeId: "p1",
          categoryId: "sc1",
        },
      ],
    };

    await importYnab4(db, importData);

    const [acc] = await db.select().from(schema.accounts);
    expect(acc).toBeDefined();
    expect(acc?.lastReconciledAt).toBe("2026-05-15");
    expect(acc?.lastReconciledBalance).toBe(50000);

    const recs = await db.select().from(schema.reconciliations);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      accountId: acc!.id,
      reconciledAt: "2026-05-15",
      statementDate: "2026-05-15",
      statementBalance: 50000,
      adjustmentTransactionId: null,
    });

    const txs = await db.select().from(schema.transactions);
    expect(txs).toHaveLength(3);

    const recTxs = txs.filter((t) => t.status === "r");
    expect(recTxs).toHaveLength(2);
    for (const rt of recTxs) {
      expect(rt.reconciliationId).toBe(recs[0]!.id);
      expect(rt.reconciledAt).toBe("2026-05-15");
    }

    // Now unreconcile the account
    const unrec = await unreconcileAccount(db, acc!.id);
    expect(unrec.flipped).toBe(2);
    expect(unrec.deletedAdjustmentId).toBeNull();

    // Verify all transactions are unlocked back to 'c'
    const updatedTxs = await db.select().from(schema.transactions);
    const flippedTxs = updatedTxs.filter((t) => t.id === recTxs[0]!.id || t.id === recTxs[1]!.id);
    for (const ft of flippedTxs) {
      expect(ft.status).toBe("c");
      expect(ft.reconciledAt).toBeNull();
      expect(ft.reconciliationId).toBeNull();
    }

    // Account metadata cleared
    const [clearedAcc] = await db.select().from(schema.accounts);
    expect(clearedAcc?.lastReconciledAt).toBeNull();
    expect(clearedAcc?.lastReconciledBalance).toBeNull();
  });

  it("BUG-03: imports boundary outflow transfers without category by assigning fallback category, preserving budget integrity", async () => {
    const backupData = {
      accounts: [
        { entityId: "acc_chk", accountName: "Checking", accountType: "Checking", onBudget: true },
        { entityId: "acc_inv", accountName: "Investments", accountType: "InvestmentAccount", onBudget: false },
      ],
      payees: [
        { entityId: "p_start", name: "Starting Balance" },
      ],
      masterCategories: [
        {
          entityId: "mc_main",
          name: "General",
          type: "OUTFLOW",
          subCategories: [{ entityId: "sc_gen", name: "General Exp" }],
        },
      ],
      transactions: [
        // Checking starting balance $1,000.00
        {
          entityId: "t_chk_start",
          accountId: "acc_chk",
          date: "2026-07-01",
          amount: 1000,
          cleared: "Cleared",
          payeeId: "p_start",
          categoryId: "Category/__ImmediateIncome__",
        },
        // Cross-boundary transfer from Checking (on-budget) to Investments (off-budget) of -$200.00 with NO category
        {
          entityId: "t_transfer_out",
          accountId: "acc_chk",
          date: "2026-07-15",
          amount: -200,
          cleared: "Cleared",
          targetAccountId: "acc_inv",
          transferTransactionId: "t_transfer_in",
          categoryId: null,
        },
        {
          entityId: "t_transfer_in",
          accountId: "acc_inv",
          date: "2026-07-15",
          amount: 200,
          cleared: "Cleared",
          targetAccountId: "acc_chk",
          transferTransactionId: "t_transfer_out",
          categoryId: null,
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    };

    await importYnab4(db, backupData);

    const budget = await getBudgetData(db);
    // Checking: 100000 - 20000 = 80000
    // Investments: 20000
    const chk = budget.accounts.find((a) => a.name === "Checking");
    expect(Number(chk?.balance)).toBe(80000);

    // The boundary outflow transfer should have been assigned a fallback category
    const transferTx = budget.transactions.find((t) => t.transferAccountId != null);
    expect(transferTx).toBeDefined();
    expect(transferTx?.categoryId).not.toBeNull();

    const fallbackCat = budget.categories.find((c) => c.id === transferTx?.categoryId);
    expect(fallbackCat?.name).toBe("Uncategorized Transfers");

    // Core budget integrity audit must be completely consistent
    const report = await verifyBudgetIntegrity(db, "2026-07");
    expect(report.difference).toBe(0);
  });

  it("BUG-01 / BUG-03: validates and rebalances scheduled split transactions on import", async () => {
    const backupData = {
      accounts: [
        { entityId: "acc1", accountName: "Checking", accountType: "Checking", onBudget: true },
        { entityId: "acc2", accountName: "OffBudget", accountType: "InvestmentAccount", onBudget: false },
      ],
      payees: [
        { entityId: "p_sched", name: "Scheduled Payee" },
      ],
      masterCategories: [
        {
          entityId: "mc_main",
          name: "Main",
          type: "OUTFLOW",
          subCategories: [{ entityId: "sc_cat1", name: "Cat 1" }],
        },
      ],
      transactions: [],
      monthlyBudgets: [],
      scheduledTransactions: [
        // Scheduled split with parent amount = -100, but subtransactions sum = -60 + -40 = -100
        // and child 2 transfers to off-budget without category
        {
          entityId: "s_split",
          accountId: "acc1",
          date: "2026-09-01",
          amount: -999, // Unbalanced parent amount in YNAB4 backup
          frequency: "monthly",
          payeeId: "p_sched",
          categoryId: "Category/__Split__",
          subTransactions: [
            { categoryId: "sc_cat1", amount: -60, memo: "Sub 1" },
            { categoryId: null, targetAccountId: "acc2", amount: -40, memo: "Sub 2" },
          ],
        },
      ],
    };

    await importYnab4(db, backupData);

    const budget = await getBudgetData(db);
    expect(budget.recurring).toHaveLength(1);
    const rec = budget.recurring[0]!;

    // Parent amount rebalanced to sum of children: -6000 + -4000 = -10000 cents
    expect(Number(rec.amount)).toBe(-10000);
    expect(rec.subTransactions).toHaveLength(2);
    // Boundary transfer child assigned fallback category
    const transferSub = rec.subTransactions.find((s) => s.transferAccountId != null);
    expect(transferSub).toBeDefined();
    expect(transferSub?.categoryId).not.toBeNull();
  });

  it("BUG-07: persists non-null anchorDay derived from date on YNAB4 import when anchorDay is missing", async () => {
    const backupData = {
      accounts: [
        { entityId: "acc_sched", accountName: "Chequing", accountType: "Checking", onBudget: true },
      ],
      payees: [{ entityId: "p_sched", name: "Gym" }],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Health",
          type: "OUTFLOW",
          subCategories: [{ entityId: "sc1", name: "Gym Membership" }],
        },
      ],
      transactions: [],
      monthlyBudgets: [],
      scheduledTransactions: [
        {
          entityId: "s_month_end",
          accountId: "acc_sched",
          date: "2026-01-31",
          amount: -50,
          frequency: "monthly",
          payeeId: "p_sched",
          categoryId: "sc1",
          // anchorDay omitted
        },
      ],
    };

    await importYnab4(db, backupData);

    const budget = await getBudgetData(db);
    expect(budget.recurring).toHaveLength(1);
    expect(budget.recurring[0]!.anchorDay).toBe(31);
  });

  it("BUG-08: imports reconciled split parent as 'r' with reconciliationId and allows unreconcileAccount to unlock it", async () => {
    const backupData = {
      accounts: [
        {
          entityId: "acc_rec_split",
          accountName: "Split Checking",
          accountType: "Checking",
          onBudget: true,
          // No lastReconciledDate provided; reconciliation record should be created from reconciled split
        },
      ],
      payees: [{ entityId: "p_split", name: "Supermarket" }],
      masterCategories: [
        {
          entityId: "mc_groceries",
          name: "Living",
          type: "OUTFLOW",
          subCategories: [
            { entityId: "sc_food", name: "Food" },
            { entityId: "sc_house", name: "Household" },
          ],
        },
      ],
      transactions: [
        {
          entityId: "tx_split_rec",
          accountId: "acc_rec_split",
          date: "2026-05-10",
          amount: -100,
          cleared: "Reconciled",
          payeeId: "p_split",
          categoryId: "Category/__Split__",
          subTransactions: [
            { entityId: "st1", categoryId: "sc_food", amount: -60, memo: "Groceries" },
            { entityId: "st2", categoryId: "sc_house", amount: -40, memo: "Cleaning" },
          ],
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    };

    await importYnab4(db, backupData);

    const [acc] = await db.select().from(schema.accounts);
    expect(acc).toBeDefined();
    expect(acc?.lastReconciledAt).toBe("2026-05-10");

    const recs = await db.select().from(schema.reconciliations);
    expect(recs).toHaveLength(1);
    const recId = recs[0]!.id;

    const txs = await db.select().from(schema.transactions);
    expect(txs).toHaveLength(3); // 1 parent + 2 children

    const parent = txs.find((t) => t.parentId === null);
    expect(parent).toBeDefined();
    expect(parent?.status).toBe("r");
    expect(parent?.reconciliationId).toBe(recId);
    expect(parent?.reconciledAt).toBe("2026-05-10");

    const children = txs.filter((t) => t.parentId !== null);
    expect(children).toHaveLength(2);
    for (const c of children) {
      expect(c.status).toBe("r");
      expect(c.reconciliationId).toBe(recId);
      expect(c.reconciledAt).toBe("2026-05-10");
    }

    // Now unreconcile the account
    const unrec = await unreconcileAccount(db, acc!.id);
    expect(unrec.flipped).toBe(2); // 2 children flipped

    // Verify all transactions (parent + children) are unlocked back to 'c'
    const updatedTxs = await db.select().from(schema.transactions);
    for (const t of updatedTxs) {
      expect(t.status).toBe("c");
      expect(t.reconciledAt).toBeNull();
      expect(t.reconciliationId).toBeNull();
    }
  });

  it("does not seed credit card payment carryover from arbitrary uncategorized purchases (BUG-18)", async () => {
    const db = openMigratedDb();
    const backupData = {
      accounts: [
        { entityId: "acc_cc", accountName: "Mastercard", accountType: "CreditCard", onBudget: true },
      ],
      payees: [
        { entityId: "p_apple", name: "Apple Store" },
        { entityId: "p_coffee", name: "Starbucks" },
      ],
      masterCategories: [
        {
          entityId: "mc_general",
          name: "General",
          type: "OUTFLOW",
          subCategories: [
            { entityId: "sc_coffee", name: "Coffee" },
          ],
        },
      ],
      transactions: [
        {
          entityId: "tx_apple",
          accountId: "acc_cc",
          date: "2024-01-01",
          amount: -500, // $500 uncategorized laptop purchase
          cleared: "Cleared",
          payeeId: "p_apple",
          categoryId: null,
        },
        {
          entityId: "tx_coffee",
          accountId: "acc_cc",
          date: "2024-01-02",
          amount: -5,
          cleared: "Cleared",
          payeeId: "p_coffee",
          categoryId: "sc_coffee",
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    };

    await importYnab4(db, backupData);

    const ccCat = await db.select().from(schema.categories).where(isNotNull(schema.categories.linkedAccountId));
    expect(ccCat).toHaveLength(1);
    // Carryover must NOT latch onto the $500 Apple Store purchase
    expect(ccCat[0]!.carryover).toBe(0);
  });

  it("seeds credit card payment carryover from multi-language starting payees and opening debt (BUG-18)", async () => {
    const db = openMigratedDb();
    const backupData = {
      accounts: [
        { entityId: "acc_french_card", accountName: "Carte Bleue", accountType: "CreditCard", onBudget: true },
        { entityId: "acc_german_card", accountName: "Kreditkarte", accountType: "CreditCard", onBudget: true },
      ],
      payees: [
        { entityId: "p_solde", name: "Solde initial" },
        { entityId: "p_anfang", name: "Anfangssaldo" },
      ],
      masterCategories: [],
      transactions: [
        {
          entityId: "tx_french_start",
          accountId: "acc_french_card",
          date: "2024-01-01",
          amount: -350, // 350 EUR starting debt
          cleared: "Cleared",
          payeeId: "p_solde",
          categoryId: null,
        },
        {
          entityId: "tx_german_start",
          accountId: "acc_german_card",
          date: "2024-01-01",
          amount: -420, // 420 EUR starting debt
          cleared: "Cleared",
          payeeId: "p_anfang",
          categoryId: null,
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    };

    await importYnab4(db, backupData);

    const ccCats = await db.select().from(schema.categories).where(isNotNull(schema.categories.linkedAccountId));
    expect(ccCats).toHaveLength(2);

    const frenchCat = ccCats.find((c) => c.name === "Carte Bleue");
    const germanCat = ccCats.find((c) => c.name === "Kreditkarte");

    expect(frenchCat).toBeDefined();
    expect(frenchCat!.carryover).toBe(-35000); // -350.00 -> -35000 cents

    expect(germanCat).toBeDefined();
    expect(germanCat!.carryover).toBe(-42000); // -420.00 -> -42000 cents
  });

  it("imports multiple explicit reconciliation rounds and links transactions (BUG-17)", async () => {
    const db = openMigratedDb();
    const backupData = {
      accounts: [
        { entityId: "acc_multi_rec", accountName: "Checking", accountType: "Checking", onBudget: true },
      ],
      payees: [
        { entityId: "p_rec1", name: "Store A" },
        { entityId: "p_rec2", name: "Store B" },
      ],
      masterCategories: [],
      reconciliations: [
        {
          entityId: "rec_round_1",
          accountId: "acc_multi_rec",
          reconciledAt: "2026-03-31",
          statementDate: "2026-03-31",
          statementBalance: 1000,
        },
        {
          entityId: "rec_round_2",
          accountId: "acc_multi_rec",
          reconciledAt: "2026-04-30",
          statementDate: "2026-04-30",
          statementBalance: 1200,
        },
      ],
      transactions: [
        {
          entityId: "tx_r1",
          accountId: "acc_multi_rec",
          date: "2026-03-15",
          amount: -50,
          cleared: "Reconciled",
          reconciliationId: "rec_round_1",
          reconciledAt: "2026-03-31",
          payeeId: "p_rec1",
          categoryId: null,
        },
        {
          entityId: "tx_r2",
          accountId: "acc_multi_rec",
          date: "2026-04-15",
          amount: -75,
          cleared: "Reconciled",
          reconciliationId: "rec_round_2",
          reconciledAt: "2026-04-30",
          payeeId: "p_rec2",
          categoryId: null,
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    };

    await importYnab4(db, backupData);

    const recs = await db.select().from(schema.reconciliations);
    expect(recs).toHaveLength(2);

    const rec1 = recs.find((r) => r.statementDate === "2026-03-31");
    const rec2 = recs.find((r) => r.statementDate === "2026-04-30");
    expect(rec1).toBeDefined();
    expect(rec2).toBeDefined();
    expect(rec1!.statementBalance).toBe(100000);
    expect(rec2!.statementBalance).toBe(120000);

    const txs = await db.select().from(schema.transactions);
    expect(txs).toHaveLength(2);

    const tx1 = txs.find((t) => t.payee === "Store A");
    const tx2 = txs.find((t) => t.payee === "Store B");
    expect(tx1?.reconciliationId).toBe(rec1!.id);
    expect(tx2?.reconciliationId).toBe(rec2!.id);
  });

  it("BUG-01: imports genuine milliunit-encoded YNAB4 data at correct scale (÷10 before dollarsToCents)", async () => {
    // Stock YNAB4 backups store amounts as integer milliunits (×1000).
    // A $45.00 grocery is stored as -45000, a $3,000.00 paycheck as 3000000.
    // After detection and conversion, amounts should be in cents:
    //   -45000 milliunits → -4500 cents (−$45.00)
    //   3000000 milliunits → 300000 cents ($3,000.00)
    const milliunitData = {
      accounts: [
        { entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true },
      ],
      payees: [
        { entityId: "p1", name: "Grocery Store" },
        { entityId: "p2", name: "Employer" },
      ],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Everyday",
          type: "OUTFLOW",
          subCategories: [{ entityId: "sc1", name: "Groceries" }],
        },
      ],
      transactions: [
        {
          entityId: "t1",
          accountId: "acc1",
          date: "2026-06-01",
          amount: -45000, // −$45.00 in milliunits
          cleared: "Cleared",
          payeeId: "p1",
          categoryId: "sc1",
        },
        {
          entityId: "t2",
          accountId: "acc1",
          date: "2026-06-02",
          amount: 3000000, // +$3,000.00 in milliunits → exceeds 1M threshold
          cleared: "Cleared",
          payeeId: "p2",
          categoryId: "Category/__ImmediateIncome__",
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    };

    await importYnab4(db, milliunitData);
    const { transactions } = await getBudgetData(db);

    expect(transactions).toHaveLength(2);

    const grocery = transactions.find((t) => t.payee === "Grocery Store");
    expect(grocery).toBeDefined();
    // -45000 milliunits → -4500 cents
    expect(Number(grocery!.amount)).toBe(-4500);

    const income = transactions.find((t) => t.payee === "Employer");
    expect(income).toBeDefined();
    // 3000000 milliunits → 300000 cents
    expect(Number(income!.amount)).toBe(300000);
  });

  it("BUG-01: still imports decimal-dollar data correctly (regression guard for backup.y4backup)", async () => {
    // Verify that decimal-dollar data (like the repo's own backup.y4backup)
    // still imports at the correct scale via the existing test baseline.
    const decimalData = {
      accounts: [
        { entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true },
      ],
      payees: [
        { entityId: "p1", name: "Store" },
      ],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Expenses",
          type: "OUTFLOW",
          subCategories: [{ entityId: "sc1", name: "Food" }],
        },
      ],
      transactions: [
        {
          entityId: "t1",
          accountId: "acc1",
          date: "2026-06-01",
          amount: -45.00, // −$45.00 in decimal dollars (has fractional part)
          cleared: "Cleared",
          payeeId: "p1",
          categoryId: "sc1",
        },
        {
          entityId: "t2",
          accountId: "acc1",
          date: "2026-06-02",
          amount: 3000.00, // +$3,000.00 in decimal dollars
          cleared: "Cleared",
          payeeId: "p1",
          categoryId: "Category/__ImmediateIncome__",
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [],
    };

    await importYnab4(db, decimalData);
    const { transactions } = await getBudgetData(db);

    expect(transactions).toHaveLength(2);

    const outflow = transactions.find((t) => Number(t.amount) < 0);
    expect(outflow).toBeDefined();
    // −45.00 dollars → −4500 cents
    expect(Number(outflow!.amount)).toBe(-4500);

    const inflow = transactions.find((t) => Number(t.amount) > 0);
    expect(inflow).toBeDefined();
    // 3000.00 dollars → 300000 cents
    expect(Number(inflow!.amount)).toBe(300000);
  });

  it("skips and reports zero-amount and zero-sum scheduled transactions without aborting import (BUG-14)", async () => {
    const backupWithZeroScheduled = {
      accounts: [
        {
          entityId: "acc1",
          accountName: "Checking",
          accountType: "Checking",
          onBudget: true,
          sortableIndex: 1,
        },
      ],
      payees: [
        { entityId: "p1", name: "Landlord" },
        { entityId: "p2", name: "Transfer Item" },
      ],
      masterCategories: [
        {
          entityId: "mc1",
          name: "Bills",
          type: "OUTFLOW",
          sortableIndex: 1,
          subCategories: [
            {
              entityId: "sc1",
              name: "Rent",
              sortableIndex: 1,
            },
          ],
        },
      ],
      transactions: [
        {
          entityId: "t1",
          accountId: "acc1",
          date: "2026-06-01",
          amount: -100.0,
          cleared: "Cleared",
          payeeId: "p1",
          categoryId: "sc1",
        },
      ],
      monthlyBudgets: [],
      scheduledTransactions: [
        // 1. Regular scheduled transaction with $0 amount
        {
          entityId: "sched1",
          accountId: "acc1",
          date: "2026-07-01",
          amount: 0,
          frequency: "monthly",
          payeeId: "p1",
          categoryId: "sc1",
          memo: "Zero amount reminder",
        },
        // 2. Split scheduled transaction with subtransactions that sum to $0
        {
          entityId: "sched2",
          accountId: "acc1",
          date: "2026-07-05",
          amount: 0,
          frequency: "monthly",
          payeeId: "p2",
          memo: "Zero-sum split schedule",
          subTransactions: [
            {
              entityId: "sub1",
              amount: 50.0,
              categoryId: "sc1",
              memo: "Plus 50",
            },
            {
              entityId: "sub2",
              amount: -50.0,
              categoryId: "sc1",
              memo: "Minus 50",
            },
          ],
        },
        // 3. Valid non-zero scheduled transaction
        {
          entityId: "sched3",
          accountId: "acc1",
          date: "2026-07-10",
          amount: -1200.0,
          frequency: "monthly",
          payeeId: "p1",
          categoryId: "sc1",
          memo: "Real rent payment",
        },
      ],
    };

    const summary = await importYnab4(db, backupWithZeroScheduled);
    expect(summary.accounts).toBe(1);
    expect(summary.transactions).toBe(1);
    expect(summary.duplicatesSkipped).toBeDefined();

    // Verify skipped duplicates contains the 2 zero-amount scheduled items
    const zeroSchedSkipped = summary.duplicatesSkipped?.filter(
      (s) => s.reason === "Zero-amount scheduled transaction"
    );
    expect(zeroSchedSkipped).toHaveLength(2);
    expect(zeroSchedSkipped?.some((s) => s.memo === "Zero amount reminder")).toBe(true);
    expect(zeroSchedSkipped?.some((s) => s.memo === "Zero-sum split schedule")).toBe(true);

    // Verify database state: only the valid non-zero scheduled transaction was inserted
    const budgetData = await getBudgetData(db);
    expect(budgetData.recurring).toHaveLength(1);
    expect(budgetData.recurring[0]!.memo).toBe("Real rent payment");
    expect(Number(budgetData.recurring[0]!.amount)).toBe(-120000);
  });
});
