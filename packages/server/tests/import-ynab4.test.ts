/**
 * import-ynab4.test.ts
 *
 * Covers the per-account balance recomputation step in the YNAB4 importer.
 * The bug being guarded: the old code only summed `transactions.accountId`,
 * which silently dropped every incoming transfer and left imported
 * destination-account balances permanently low. (Source rows are stored
 * against the source account; the destination's balance must subtract
 * the transfer amount, mirroring `createTransfer`'s destination update.)
 *
 * The actual end-to-end import is large and integration-tested elsewhere
 * (it touches accounts, categories, assignments, transactions, scheduled).
 * The interesting logic — "given N transactions, compute balances" — is
 * extracted into `recomputeAccountBalances` and tested directly here.
 *
 * Also covers the BEGIN/COMMIT/ROLLBACK transaction that wraps the
 * entire import (see `importYnab4` in import-ynab4.ts) — a critical
 * data-safety guard against partial imports leaving the user with a
 * wiped, corrupt database.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { importYnab4, parseYnab4SettingsXml, recomputeAccountBalances } from "../src/import-ynab4.js";
import { createMockDb, type MockDb } from "./mock-db.js";

describe("recomputeAccountBalances (importer transfer-math fix)", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  it("sums only own transactions when an account has no transfers", async () => {
    // Two accounts: A (no transfers), B (no transfers).
    mock.respondWith("select:accounts", [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
    ]);
    // Account 1: outflows = -100, no transfers in.
    mock.respondWith("select:transactions#1", [{ sum: -100 }]);
    mock.respondWith("select:transactions#2", [{ sum: 0 }]);
    mock.respondWith("update:accounts#1", [{}]);
    // Account 2: outflows = +250, no transfers in.
    mock.respondWith("select:transactions#3", [{ sum: 250 }]);
    mock.respondWith("select:transactions#4", [{ sum: 0 }]);
    mock.respondWith("update:accounts#2", [{}]);

    await recomputeAccountBalances(mock.db);

    const updates = mock.calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(2);
    expect(updates[0]?.set).toEqual({ balance: -100 });
    expect(updates[1]?.set).toEqual({ balance: 250 });
  });

  it("credits an account that is the destination of a transfer", async () => {
    // Account 1 is the SOURCE of a -$200 transfer to Account 2.
    // Source side: row stored against accountId=1, amount=-200.
    // Destination side: same row's transferAccountId=2, amount=-200.
    // Source's balance = -200 (outgoing).
    // Destination's balance = 0 - (-200) = +200 (incoming).
    mock.respondWith("select:accounts", [
      { id: 1, name: "Source" },
      { id: 2, name: "Destination" },
    ]);
    // Account 1 (source): outflow=-200, transfers-in=0.
    mock.respondWith("select:transactions#1", [{ sum: -200 }]);
    mock.respondWith("select:transactions#2", [{ sum: 0 }]);
    mock.respondWith("update:accounts#1", [{}]);
    // Account 2 (destination): outflow=0, transfers-in=-200.
    mock.respondWith("select:transactions#3", [{ sum: 0 }]);
    mock.respondWith("select:transactions#4", [{ sum: -200 }]);
    mock.respondWith("update:accounts#2", [{}]);

    await recomputeAccountBalances(mock.db);

    const updates = mock.calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(2);
    expect(updates[0]?.set).toEqual({ balance: -200 });
    // The fix: destination reflects +200, NOT 0.
    expect(updates[1]?.set).toEqual({ balance: 200 });
  });

  it("nets multiple incoming and outgoing transfers on a single account", async () => {
    // Account C is the destination of a $500 transfer in
    // and the source of a $150 transfer out.
    // Account C is both the source of a $150 transfer out AND the
    // destination of a $500 transfer in. Two rows in the transactions
    // table are involved:
    //
    //   1. Source-side row of the $150 outgoing transfer:
    //      accountId=C, transferAccountId=Other, amount=-150
    //   2. Source-side row of the $500 incoming transfer:
    //      accountId=Other, transferAccountId=C, amount=-500
    //
    // For C:
    //   outgoing       = -150  (C's own rows)
    //   incomingTrans  = -500  (the row stored on Other where C is the destination)
    //   balance        = -150 - (-500) = -150 + 500 = +350
    mock.respondWith("select:accounts", [{ id: 3, name: "Mixed" }]);
    mock.respondWith("select:transactions#1", [{ sum: -150 }]);
    mock.respondWith("select:transactions#2", [{ sum: -500 }]);
    mock.respondWith("update:accounts#1", [{}]);

    await recomputeAccountBalances(mock.db);

    const updates = mock.calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.set).toEqual({ balance: 350 });
  });

  it("combines regular transactions and incoming transfers on the same account", async () => {
    // Account D has two regular postings (-30 and +10) and is the
    // destination of a $100 transfer (source amount = -100).
    // Expected: (-30 + 10) - (-100) = -20 + 100 = +80.
    mock.respondWith("select:accounts", [{ id: 4, name: "D" }]);
    mock.respondWith("select:transactions#1", [{ sum: -20 }]);
    mock.respondWith("select:transactions#2", [{ sum: -100 }]);
    mock.respondWith("update:accounts#1", [{}]);

    await recomputeAccountBalances(mock.db);

    const updates = mock.calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.set).toEqual({ balance: 80 });
  });

  it("treats a missing transfer-sum as 0 (no incoming transfers)", async () => {
    // The query result is undefined; we still want a clean numeric result.
    mock.respondWith("select:accounts", [{ id: 5, name: "Lonely" }]);
    mock.respondWith("select:transactions#1", [{ sum: -50 }]);
    // Simulate the empty result that the mock returns by default.
    mock.respondWith("select:transactions#2", []);
    mock.respondWith("update:accounts#1", [{}]);

    await recomputeAccountBalances(mock.db);

    const updates = mock.calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.set).toEqual({ balance: -50 });
  });
});

// ---------------------------------------------------------------------------
// Transaction wrapping (data-loss safety)
// ---------------------------------------------------------------------------
//
// The YNAB4 importer wipes the existing DB and then bulk-inserts accounts,
// categories, assignments, transactions, and scheduled transactions. If any
// insert throws mid-flight, the user would be left with a wiped but
// incomplete budget. The whole flow is wrapped in BEGIN/COMMIT, with
// ROLLBACK on any thrown error. These tests pin that contract.
describe("importYnab4 transaction wrapping", () => {
  let mock: MockDb;
  beforeEach(() => {
    mock = createMockDb();
  });

  it("issues BEGIN before any insert and COMMIT on success", async () => {
    // Minimal payload: one account, one transaction, no budgets, no
    // scheduled. The control flow hits every section of importYnab4.
    const ynabData = {
      accounts: [{ entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true }],
      payees: [],
      masterCategories: [],
      transactions: [
        {
          entityId: "t1",
          accountId: "acc1",
          date: "2026-01-01",
          amount: -100,
          cleared: "Cleared",
          payeeId: null,
          categoryId: null,
        },
      ],
      scheduledTransactions: [],
      monthlyBudgets: [],
    };

    // Reset/seed calls (resetDatabase) + insert account + insert tx +
    // recompute select accounts.
    mock.respondWith("select:accounts", []);
    mock.respondWith("insert:accounts", [{ id: 1 }]);
    mock.respondWith("select:accounts#2", [{ id: 1, name: "Chequing" }]);
    mock.respondWith("insert:transactions", [{ id: 1 }]);
    // recomputeAccountBalances: select accounts, then per-account select/update.
    mock.respondWith("select:accounts#3", [{ id: 1, name: "Chequing" }]);
    mock.respondWith("select:transactions#1", [{ sum: -10000 }]);
    mock.respondWith("select:transactions#2", [{ sum: 0 }]);
    mock.respondWith("update:accounts#1", [{}]);

    const result = await importYnab4(mock.db, ynabData);
    expect(result.accounts).toBe(1);

    const runCalls = mock.calls.filter((c) => c.op === "run");
    const sqls = runCalls.map((c) => (c.sql ?? "").trim().toUpperCase());
    // The first run must be BEGIN and the last must be COMMIT,
    // with no ROLLBACK in between.
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    expect(sqls).not.toContain("ROLLBACK");
  });

  it("marks hidden/closed accounts as archived: true on import", async () => {
    const ynabData = {
      accounts: [
        { entityId: "acc1", accountName: "Old TD", accountType: "Checking", onBudget: true, hidden: true },
      ],
      payees: [],
      masterCategories: [],
      transactions: [],
      scheduledTransactions: [],
      monthlyBudgets: [],
    };

    mock.respondWith("select:accounts", []);
    mock.respondWith("insert:accounts", [{ id: 1, archived: true }]);
    mock.respondWith("select:accounts#2", [{ id: 1, name: "Old TD" }]);
    mock.respondWith("select:accounts#3", [{ id: 1, name: "Old TD" }]);
    mock.respondWith("select:transactions#1", [{ sum: 0 }]);
    mock.respondWith("select:transactions#2", [{ sum: 0 }]);
    mock.respondWith("update:accounts#1", [{}]);

    await importYnab4(mock.db, ynabData);

    const accountInsert = mock.calls.find((c) => c.op === "insert");
    expect(accountInsert?.values).toMatchObject({
      name: "Old TD",
      archived: true,
    });
  });

  it("issues ROLLBACK (not COMMIT) when the body throws", async () => {
    // Same minimal payload, but the first insert (accounts) fails.
    // Without a transaction this would leave the DB wiped; the test
    // asserts that ROLLBACK is issued so the wipe is undone.
    const ynabData = {
      accounts: [{ entityId: "acc1", accountName: "Chequing", accountType: "Checking", onBudget: true }],
      payees: [],
      masterCategories: [],
      transactions: [],
      scheduledTransactions: [],
      monthlyBudgets: [],
    };

    // resetDatabase's pre-insert `select:accounts` for sqlite_sequence bookkeeping.
    mock.respondWith("select:accounts", []);
    // The first insert (the account) rejects.
    const accountsInsert = mock.calls.find; // (placeholder — used below)
    void accountsInsert;
    mock.respondWith("insert:accounts", []);
    // We need insert:accounts to throw. Override the chain so the next
    // insert:accounts call resolves to nothing AND we throw from it.
    // The mock chain's `then` resolves whatever the response map says;
    // we want a rejection. Easiest: pre-set the response to a value that
    // we can detect, and have the function fall through to a state that
    // throws. In practice, the simplest is to make `returning()` throw.
    // The mock's `returning` doesn't throw — so instead, we trigger an
    // exception by making the next select (after the insert) throw via
    // a malformed payload that the JS engine can't access (not realistic
    // in this mock). Instead, register a response that causes
    // `insertedT.id` (line ~193) to dereference `undefined`, throwing.
    // We achieve that by returning [] from insert:transactions once we
    // reach the transactions loop — but we never reach there. Use a
    // different approach: have the FIRST insert:accounts returning()
    // return [] and the code path uses `row!.id` → TypeError. Mock
    // does not enforce this. Instead, we'll throw explicitly by
    // making the next select throw — but the mock's select resolves
    // gracefully. So we use a different strategy: make
    // `resetDatabase` (which the function calls first) fail by
    // throwing inside a select. The mock's `then` always resolves.
    //
    // Simplest robust path: we use a wrapper around mock.db that
    // intercepts the *first* `insert:accounts` call and throws.
    // (See `throwingInsertAccounts` below.)
    const wrapped = throwOnInsertAccounts(mock);

    await expect(importYnab4(wrapped.db, ynabData)).rejects.toBeDefined();

    const runCalls = wrapped.calls.filter((c) => c.op === "run");
    const sqls = runCalls.map((c) => (c.sql ?? "").trim().toUpperCase());
    // The first run must be BEGIN, and the last must be ROLLBACK.
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });

  it("preserves categoryId on transfers to off-budget accounts", async () => {
    const ynabData = {
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
          accountId: "acc1",
          targetAccountId: "acc2",
          transferTransactionId: "t2",
          date: "2026-01-15",
          amount: -500,
          cleared: "Cleared",
          payeeId: "Payee/Transfer:acc2",
          categoryId: "sc1",
        },
        {
          entityId: "t2",
          accountId: "acc2",
          targetAccountId: "acc1",
          transferTransactionId: "t1",
          date: "2026-01-15",
          amount: 500,
          cleared: "Cleared",
          payeeId: "Payee/Transfer:acc1",
          categoryId: null,
        },
      ],
      scheduledTransactions: [],
      monthlyBudgets: [],
    };

    mock.respondWith("select:accounts", []);
    mock.respondWith("insert:accounts#1", [{ id: 1 }]);
    mock.respondWith("insert:accounts#2", [{ id: 2 }]);
    mock.respondWith("insert:category_groups", [{ id: 1 }]);
    mock.respondWith("insert:categories", [{ id: 10 }]);
    mock.respondWith("insert:category_groups#2", [{ id: 2 }]);
    mock.respondWith("select:accounts#2", []);
    mock.respondWith("select:accounts#3", [
      { id: 1, name: "Chequing" },
      { id: 2, name: "RRSP" },
    ]);
    mock.respondWith("insert:transactions", [{ id: 1 }]);
    mock.respondWith("select:accounts#4", [
      { id: 1, name: "Chequing" },
      { id: 2, name: "RRSP" },
    ]);
    mock.respondWith("select:transactions#1", [{ sum: -50000 }]);
    mock.respondWith("select:transactions#2", [{ sum: 0 }]);
    mock.respondWith("update:accounts#1", [{}]);
    mock.respondWith("select:transactions#3", [{ sum: 0 }]);
    mock.respondWith("select:transactions#4", [{ sum: -50000 }]);
    mock.respondWith("update:accounts#2", [{}]);
    mock.respondWith("select:accounts#5", []);

    await importYnab4(mock.db, ynabData);

    const txInsert = mock.calls.find((c) => c.op === "insert" && (c as any).table === "transactions" || ((c.values as any)?.amount === -50000));
    expect(txInsert?.values).toMatchObject({
      accountId: 1,
      transferAccountId: 2,
      categoryId: 10,
      amount: -50000,
    });
  });

  it("orients liquidation transfers (off-budget→on-budget) to the on-budget account as source", async () => {
    // Regression test for the bug where an off-budget→on-budget transfer
    // (liquidation/sale) was stored with the off-budget account as the
    // source and a negative amount, causing spending trends to count it
    // as positive spending. The fix should orient the single stored row
    // so the on-budget account is the source with a positive amount.
    //
    // YNAB4 transfer pair (off-budget side encountered FIRST):
    //   t1: RRSP (off-budget) → Chequing (on-budget), amount=-300, categoryId=null
    //   t2: Chequing (on-budget) → RRSP (off-budget), amount=+300, categoryId="sc1"
    const ynabData = {
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

    mock.respondWith("select:accounts", []);
    mock.respondWith("insert:accounts#1", [{ id: 1 }]);
    mock.respondWith("insert:accounts#2", [{ id: 2 }]);
    mock.respondWith("insert:category_groups", [{ id: 1 }]);
    mock.respondWith("insert:categories", [{ id: 10 }]);
    mock.respondWith("insert:category_groups#2", [{ id: 2 }]);
    mock.respondWith("select:accounts#2", []);
    mock.respondWith("select:accounts#3", [
      { id: 1, name: "Chequing" },
      { id: 2, name: "RRSP" },
    ]);
    mock.respondWith("insert:transactions", [{ id: 1 }]);
    mock.respondWith("select:accounts#4", [
      { id: 1, name: "Chequing" },
      { id: 2, name: "RRSP" },
    ]);
    mock.respondWith("select:transactions#1", [{ sum: 30000 }]);
    mock.respondWith("select:transactions#2", [{ sum: 0 }]);
    mock.respondWith("update:accounts#1", [{}]);
    mock.respondWith("select:transactions#3", [{ sum: 0 }]);
    mock.respondWith("select:transactions#4", [{ sum: 30000 }]);
    mock.respondWith("update:accounts#2", [{}]);
    mock.respondWith("select:accounts#5", []);

    await importYnab4(mock.db, ynabData);

    const txInsert = mock.calls.find(
      (c) => c.op === "insert" && ((c as any).table === "transactions" || ((c.values as any)?.amount === 30000))
    );
    expect(txInsert?.values).toMatchObject({
      accountId: 1,
      transferAccountId: 2,
      categoryId: 10,
      amount: 30000,
    });
  });
});

describe("parseYnab4SettingsXml (UNI-26 / BUG-30)", () => {
  it("parses settings XML with currency and date preferences", () => {
    const xml = `
      <budgetSettings>
        <currencySymbol>$</currencySymbol>
        <currencyISOSymbol>USD</currencyISOSymbol>
        <decimalSeparator>.</decimalSeparator>
        <groupSeparator>,</groupSeparator>
        <dateFormat>YYYY-MM-DD</dateFormat>
        <budgetName>Family Finances</budgetName>
      </budgetSettings>
    `;

    const settings = parseYnab4SettingsXml(xml);
    expect(settings).toEqual({
      currencySymbol: "$",
      currencyISOSymbol: "USD",
      decimalSeparator: ".",
      groupSeparator: ",",
      dateFormat: "YYYY-MM-DD",
      budgetName: "Family Finances",
    });
  });

  it("handles empty or missing xml gracefully", () => {
    expect(parseYnab4SettingsXml(undefined)).toEqual({});
    expect(parseYnab4SettingsXml("")).toEqual({});
  });
});

/**
 * Wrap a MockDb so that the first `insert:accounts` call throws.
 * The real better-sqlite3 driver would surface FK violations, NOT NULL
 * failures, or unique-constraint hits as synchronous exceptions —
 * our mock resolves gracefully, so we patch around it for this
 * regression test. The mock's call recorder (`mock.calls`) and the
 * `execute` recorder still pass through unchanged.
 */
function throwOnInsertAccounts(mock: MockDb): MockDb {
  const realInsert = (mock.db.insert as unknown as (t: unknown) => unknown);
  let fired = false;
  (mock.db as unknown as { insert: (t: unknown) => unknown }).insert = (t: unknown) => {
    const tableName = (t as { _: { name: string } })._?.name;
    if (!fired && tableName === "accounts") {
      fired = true;
      throw new Error("synthetic FK violation on insert:accounts");
    }
    return realInsert(t);
  };
  return mock;
}
