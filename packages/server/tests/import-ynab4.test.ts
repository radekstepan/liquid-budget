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
 */
import { describe, expect, it, beforeEach } from "vitest";
import { recomputeAccountBalances } from "../src/import-ynab4.js";
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
