import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import {
  accounts,
  categories,
  createAccount,
  createCategory,
  createCategoryGroup,
  createTransaction,
  getDefaultDb,
  resetAndSeedDatabase,
  transactions,
} from "@ynab/server";
import { DELETE, PATCH, POST } from "../src/app/api/transactions/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("PATCH /api/transactions (BUG-19)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("BUG-19: preserves categoryId and amount when toggling status", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });
    const group = await createCategoryGroup(db, { name: "Living" });
    const category = await createCategory(db, { groupId: group!.id, name: "Groceries" });

    const txn = await createTransaction(db, {
      accountId: account!.id,
      categoryId: category!.id,
      amount: -4500,
      date: "2026-08-01",
      payee: "Supermarket",
      memo: "Weekly shop",
      status: "u",
    });
    expect(txn!.categoryId).toBe(category!.id);

    const req = new NextRequest("http://localhost:3000/api/transactions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: txn!.id, status: "c" }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(txn!.id);
    expect(json.status).toBe("c");
    expect(json.categoryId).toBe(category!.id);
    expect(json.amount).toBe(-4500);
    expect(json.payee).toBe("Supermarket");
    expect(json.memo).toBe("Weekly shop");
  });

  it("updates transaction to a transfer when transferAccountId is provided in PATCH", async () => {
    const db = getDefaultDb();
    const acct1 = await createAccount(db, { name: "Checking", kind: "liquid" });
    const acct2 = await createAccount(db, { name: "Savings", kind: "liquid" });

    const txn = await createTransaction(db, {
      accountId: acct1!.id,
      amount: -5000,
      date: "2026-08-01",
      payee: "Imported Txn",
      memo: "Transfer to savings",
    });

    const req = new NextRequest("http://localhost:3000/api/transactions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: txn!.id,
        transferAccountId: acct2!.id,
        payee: "Transfer : Savings",
      }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(txn!.id);
    expect(json.transferAccountId).toBe(acct2!.id);
    expect(json.payee).toBe("Transfer : Savings");
  });

  it("BUG-19: preserves categoryId when setting flagColor", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });
    const group = await createCategoryGroup(db, { name: "Living" });
    const category = await createCategory(db, { groupId: group!.id, name: "Groceries" });

    const txn = await createTransaction(db, {
      accountId: account!.id,
      categoryId: category!.id,
      amount: -2500,
      date: "2026-08-01",
      payee: "Bakery",
      memo: "",
    });
    expect(txn!.categoryId).toBe(category!.id);

    const req = new NextRequest("http://localhost:3000/api/transactions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: txn!.id, flagColor: "red" }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(txn!.id);
    expect(json.flagColor).toBe("red");
    expect(json.categoryId).toBe(category!.id);
  });

  it("explicitly clears categoryId when null is sent in PATCH", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });
    const group = await createCategoryGroup(db, { name: "Living" });
    const category = await createCategory(db, { groupId: group!.id, name: "Groceries" });

    const txn = await createTransaction(db, {
      accountId: account!.id,
      categoryId: category!.id,
      amount: -2500,
      date: "2026-08-01",
      payee: "",
      memo: "",
    });
    expect(txn!.categoryId).toBe(category!.id);

    const req = new NextRequest("http://localhost:3000/api/transactions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: txn!.id, categoryId: null }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categoryId).toBeNull();
  });

  describe("DELETE /api/transactions (BUG-24)", () => {
    it("returns 404 for nonexistent id", async () => {
      const req = new NextRequest("http://localhost:3000/api/transactions?id=999999", {
        method: "DELETE",
      });
      const res = await DELETE(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("not found");
    });

    it("returns 400 for invalid id", async () => {
      const req = new NextRequest("http://localhost:3000/api/transactions?id=invalid", {
        method: "DELETE",
      });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 for a garbage ids list instead of a silent no-op success", async () => {
      const req = new NextRequest("http://localhost:3000/api/transactions?ids=abc,,", {
        method: "DELETE",
      });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });

    it("returns 200 and deletes the transaction for valid id", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });
      const txn = await createTransaction(db, {
        accountId: account!.id,
        amount: -2500,
        date: "2026-08-01",
        payee: "Bakery",
      });

      const req = new NextRequest(`http://localhost:3000/api/transactions?id=${txn!.id}`, {
        method: "DELETE",
      });
      const res = await DELETE(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);

      // Verify second delete of same id returns 404
      const secondRes = await DELETE(req);
      expect(secondRes.status).toBe(404);
    });
  });

  describe("POST /api/transactions (BUG-25)", () => {
    it("creates transaction without misrouting to bulk-update", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });

      const req = new NextRequest("http://localhost:3000/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account!.id,
          date: "2026-08-01",
          amount: -3500,
          payee: "Coffee Shop",
          memo: "Latte",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.id).toBeDefined();
      expect(json.amount).toBe(-3500);
      expect(json.payee).toBe("Coffee Shop");
      expect(json.memo).toBe("Latte");
    });

    it("correctly handles bulk-update with action=bulk-update query parameter", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });
      const tx1 = await createTransaction(db, {
        accountId: account!.id,
        amount: -1000,
        date: "2026-08-01",
        payee: "Store A",
      });
      const tx2 = await createTransaction(db, {
        accountId: account!.id,
        amount: -2000,
        date: "2026-08-02",
        payee: "Store B",
      });

      const req = new NextRequest("http://localhost:3000/api/transactions?action=bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: [tx1!.id, tx2!.id],
          patch: { memo: "Bulk Note", status: "c" },
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.count).toBe(2);
    });

    it("correctly handles bulk-update with action in JSON body", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });
      const tx1 = await createTransaction(db, {
        accountId: account!.id,
        amount: -1000,
        date: "2026-08-01",
        payee: "Store A",
      });

      const req = new NextRequest("http://localhost:3000/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "bulk-update",
          ids: [tx1!.id],
          patch: { flagColor: "green" },
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.count).toBe(1);
    });

    it("merges two transactions with action=merge and rejects other id counts", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });
      const tx1 = await createTransaction(db, {
        accountId: account!.id,
        amount: -1000,
        date: "2026-08-01",
        payee: "Store A",
      });
      const tx2 = await createTransaction(db, {
        accountId: account!.id,
        amount: -1000,
        date: "2026-08-01",
        payee: "STORE A #1",
      });

      const req = new NextRequest("http://localhost:3000/api/transactions?action=merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [tx1!.id, tx2!.id] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.merged.id).toBe(tx1!.id);
      expect(json.deletedId).toBe(tx2!.id);

      const bad = new NextRequest("http://localhost:3000/api/transactions?action=merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [tx1!.id] }),
      });
      const badRes = await POST(bad);
      expect(badRes.status).toBe(400);
    });

    it("merges with a patch payload carrying the user's field edits", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });
      const tx1 = await createTransaction(db, {
        accountId: account!.id,
        amount: -1000,
        date: "2026-08-01",
        payee: "Store A",
      });
      const tx2 = await createTransaction(db, {
        accountId: account!.id,
        amount: -1000,
        date: "2026-08-01",
        payee: "STORE A #1",
      });

      const req = new NextRequest("http://localhost:3000/api/transactions?action=merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: [tx1!.id, tx2!.id],
          patch: { payee: "Store A (edited)", memo: "curated", amount: -1200 },
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.merged.id).toBe(tx1!.id);
      expect(json.deletedId).toBe(tx2!.id);
      expect(json.merged.payee).toBe("Store A (edited)");
      expect(json.merged.memo).toBe("curated");
      expect(json.merged.amount).toBe(-1200);

      const badPatch = new NextRequest("http://localhost:3000/api/transactions?action=merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [tx1!.id, tx2!.id], patch: { amount: 0 } }),
      });
      expect((await POST(badPatch)).status).toBe(400);
    });
  });

  describe("Parametrized State-Transition Tests", () => {
    const MODES = ["single", "transfer", "split"] as const;

    let db: ReturnType<typeof getDefaultDb>;
    let srcAccount: { id: number; name: string };
    let destAccount: { id: number; name: string };
    let otherAccount: { id: number; name: string };
    let cat1: { id: number; name: string };
    let cat2: { id: number; name: string };

    const INITIAL_SRC_BALANCE = 100000; // $1000.00
    const INITIAL_DEST_BALANCE = 50000; // $500.00
    const INITIAL_OTHER_BALANCE = 25000; // $250.00

    beforeEach(async () => {
      db = getDefaultDb();
      await resetAndSeedDatabase(db);
      await db.delete(transactions);

      const group = await createCategoryGroup(db, { name: "Living" });
      cat1 = (await createCategory(db, { groupId: group!.id, name: "Groceries" }))!;
      cat2 = (await createCategory(db, { groupId: group!.id, name: "Household" }))!;

      srcAccount = (await createAccount(db, {
        name: "Test Checking",
        kind: "liquid",
        balance: INITIAL_SRC_BALANCE,
      }))!;
      destAccount = (await createAccount(db, {
        name: "Test Savings",
        kind: "liquid",
        balance: INITIAL_DEST_BALANCE,
      }))!;
      otherAccount = (await createAccount(db, {
        name: "Test Other",
        kind: "liquid",
        balance: INITIAL_OTHER_BALANCE,
      }))!;
    });

    async function createInitial(fromMode: (typeof MODES)[number]) {
      let body: Record<string, unknown>;
      if (fromMode === "single") {
        body = {
          mode: "single",
          accountId: srcAccount.id,
          categoryId: cat1.id,
          amount: -5000,
          date: "2026-08-01",
          payee: "Initial Grocery Store",
          memo: "Initial single",
        };
      } else if (fromMode === "transfer") {
        body = {
          mode: "transfer",
          accountId: srcAccount.id,
          transferAccountId: destAccount.id,
          amount: -5000,
          date: "2026-08-01",
          payee: `Transfer : ${destAccount.name}`,
          memo: "Initial transfer",
        };
      } else {
        body = {
          mode: "split",
          accountId: srcAccount.id,
          amount: -5000,
          date: "2026-08-01",
          payee: "Initial Split Store",
          memo: "Initial split",
          subTransactions: [
            { categoryId: cat1.id, amount: -3000, memo: "sub 1" },
            { categoryId: cat2.id, amount: -2000, memo: "sub 2" },
          ],
        };
      }

      const req = new NextRequest("http://localhost:3000/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      const id = json.parent ? json.parent.id : json.id;
      return { id, json };
    }

    async function updateTo(id: number, toMode: (typeof MODES)[number]) {
      let body: Record<string, unknown>;
      if (toMode === "single") {
        body = {
          id,
          mode: "single",
          accountId: srcAccount.id,
          categoryId: cat2.id,
          amount: -6000,
          date: "2026-08-05",
          payee: "Updated Single Store",
          memo: "Updated to single",
        };
      } else if (toMode === "transfer") {
        body = {
          id,
          mode: "transfer",
          accountId: srcAccount.id,
          transferAccountId: destAccount.id,
          amount: -7000,
          date: "2026-08-05",
          payee: `Transfer : ${destAccount.name}`,
          memo: "Updated to transfer",
        };
      } else {
        body = {
          id,
          mode: "split",
          accountId: srcAccount.id,
          amount: -8000,
          date: "2026-08-05",
          payee: "Updated Split Store",
          memo: "Updated to split",
          subTransactions: [
            { categoryId: cat1.id, amount: -5000, memo: "split A" },
            { categoryId: cat2.id, amount: -3000, memo: "split B" },
          ],
        };
      }

      const req = new NextRequest("http://localhost:3000/api/transactions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const res = await PATCH(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      return json;
    }

    describe.each(MODES)("Transition from %s", (fromMode) => {
      describe.each(MODES)("to %s", (toMode) => {
        it(`handles ${fromMode} -> ${toMode} with correct balance ledgers`, async () => {
          const initial = await createInitial(fromMode);
          const res = await updateTo(initial.id, toMode);

          // 1. Fetch current balances of all accounts
          const [curSrc] = await db.select().from(accounts).where(eq(accounts.id, srcAccount.id));
          const [curDest] = await db.select().from(accounts).where(eq(accounts.id, destAccount.id));
          const [curOther] = await db.select().from(accounts).where(eq(accounts.id, otherAccount.id));

          const srcDelta = curSrc!.balance - INITIAL_SRC_BALANCE;
          const destDelta = curDest!.balance - INITIAL_DEST_BALANCE;
          const otherDelta = curOther!.balance - INITIAL_OTHER_BALANCE;

          // Assert balance ledger sum across all accounts
          if (toMode === "transfer") {
            // For a transfer: delta(src) + delta(dest) == 0 (zero-sum transfer ledger sum)
            expect(srcDelta + destDelta + otherDelta).toBe(0);
            expect(srcDelta).toBe(-7000);
            expect(destDelta).toBe(7000);
            expect(otherDelta).toBe(0);
          } else if (toMode === "single") {
            expect(srcDelta).toBe(-6000);
            expect(destDelta).toBe(0);
            expect(otherDelta).toBe(0);
            expect(srcDelta + destDelta + otherDelta - (-6000)).toBe(0);
          } else if (toMode === "split") {
            expect(srcDelta).toBe(-8000);
            expect(destDelta).toBe(0);
            expect(otherDelta).toBe(0);
            expect(srcDelta + destDelta + otherDelta - (-8000)).toBe(0);
          }

          // 2. Assert DB row fields match toMode requirements
          const [dbRow] = await db.select().from(transactions).where(eq(transactions.id, initial.id));
          expect(dbRow).toBeDefined();

          const dbChildren = await db
            .select()
            .from(transactions)
            .where(eq(transactions.parentId, initial.id));

          if (toMode === "single") {
            expect(dbRow?.amount).toBe(-6000);
            expect(dbRow?.categoryId).toBe(cat2.id);
            expect(dbRow?.transferAccountId).toBeNull();
            expect(dbRow?.parentId).toBeNull();
            expect(dbChildren).toHaveLength(0);
          } else if (toMode === "transfer") {
            expect(dbRow?.amount).toBe(-7000);
            expect(dbRow?.transferAccountId).toBe(destAccount.id);
            expect(dbRow?.categoryId).toBeNull();
            expect(dbRow?.parentId).toBeNull();
            expect(dbChildren).toHaveLength(0);
          } else if (toMode === "split") {
            expect(dbRow?.amount).toBe(-8000);
            expect(dbRow?.categoryId).toBeNull();
            expect(dbRow?.transferAccountId).toBeNull();
            expect(dbRow?.parentId).toBeNull();
            expect(dbChildren).toHaveLength(2);
            const childSum = dbChildren.reduce((sum, c) => sum + Number(c.amount), 0);
            expect(childSum).toBe(-8000);
          }
        });
      });
    });
  });
});
