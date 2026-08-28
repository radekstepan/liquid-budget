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
import path from "path";
import { fileURLToPath } from "url";
import { importYnab4 } from "../src/import-ynab4.js";
import { getBudgetData } from "../src/queries/budget.js";
import { postRecurringTransaction, updateRecurring } from "../src/queries/recurring.js";
import { unreconcileAccount } from "../src/queries/reconcile.js";
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
    expect(Number(visaPaymentCat.carryover)).toBe(75000); // 75000 cents ($750.00)
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
    expect(Number(visaPaymentCat.carryover)).toBe(62000); // 62000 cents ($620.00)
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
    expect(Number(visaPaymentCat.carryover)).toBe(80000); // 80000 cents from earliest 2026-05-10
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
      categoryId: null,
      memo: "401k contribution",
    });
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
});
