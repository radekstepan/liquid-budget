import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  createAccount,
  createCategory,
  createCategoryGroup,
  createTransaction,
  getDefaultDb,
  resetAndSeedDatabase,
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
    it("creates transaction when payload includes a 'patch' key instead of misrouting to bulk-update", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });

      const req = new NextRequest("http://localhost:3000/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patch: null,
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
  });
});
