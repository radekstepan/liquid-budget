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
import { PATCH } from "../src/app/api/transactions/route";

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
});
