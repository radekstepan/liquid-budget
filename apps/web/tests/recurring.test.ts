import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  createAccount,
  createCategory,
  createCategoryGroup,
  createRecurring,
  getDefaultDb,
  resetAndSeedDatabase,
} from "@ynab/server";
import { PATCH, POST } from "../src/app/api/recurring/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("PATCH & POST /api/recurring (BUG-19)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("BUG-19: preserves categoryId when setting flagColor on recurring rule", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });
    const group = await createCategoryGroup(db, { name: "Subscriptions" });
    const category = await createCategory(db, { groupId: group!.id, name: "Streaming" });

    const rec = await createRecurring(db, {
      accountId: account!.id,
      categoryId: category!.id,
      amount: -1500,
      frequency: "monthly",
      nextDate: "2026-09-01",
      payee: "Netflix",
    });
    expect(rec!.categoryId).toBe(category!.id);

    const req = new NextRequest("http://localhost:3000/api/recurring", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rec!.id, flagColor: "red" }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(rec!.id);
    expect(json.flagColor).toBe("red");
    expect(json.categoryId).toBe(category!.id);
    expect(json.amount).toBe(-1500);
    expect(json.payee).toBe("Netflix");
  });

  it("BUG-19: preserves categoryId during bulk-update", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });
    const group = await createCategoryGroup(db, { name: "Subscriptions" });
    const category = await createCategory(db, { groupId: group!.id, name: "Streaming" });

    const rec1 = await createRecurring(db, {
      accountId: account!.id,
      categoryId: category!.id,
      amount: -1500,
      frequency: "monthly",
      nextDate: "2026-09-01",
      payee: "Netflix",
    });
    const rec2 = await createRecurring(db, {
      accountId: account!.id,
      categoryId: category!.id,
      amount: -1000,
      frequency: "monthly",
      nextDate: "2026-09-01",
      payee: "Spotify",
    });

    const req = new NextRequest("http://localhost:3000/api/recurring", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "bulk-update",
        ids: [rec1!.id, rec2!.id],
        patch: { flagColor: "yellow" },
      }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.updatedCount).toBe(2);
  });

  it("BUG-19: rejects invalid calendar dates in recurring route actions", async () => {
    const db = getDefaultDb();
    const account = await createAccount(db, { name: "Checking", kind: "liquid" });

    // 1. Create with invalid nextDate
    const createReq = new NextRequest("http://localhost:3000/api/recurring", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: account!.id,
        amount: -1500,
        frequency: "monthly",
        nextDate: "2026-02-31",
      }),
    });
    const createRes = await POST(createReq);
    expect(createRes.status).toBe(400);

    // 2. Action post with invalid date query param
    const postQueryReq = new NextRequest("http://localhost:3000/api/recurring?action=post&id=1&date=2026-04-31", {
      method: "POST",
    });
    const postQueryRes = await POST(postQueryReq);
    expect(postQueryRes.status).toBe(400);

    // 3. Action autopost with invalid asOfDate
    const autopostReq = new NextRequest("http://localhost:3000/api/recurring", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "autopost",
        asOfDate: "2026-02-29",
      }),
    });
    const autopostRes = await POST(autopostReq);
    expect(autopostRes.status).toBe(400);

    // 4. Action bulk-update with invalid nextDate
    const bulkUpdateReq = new NextRequest("http://localhost:3000/api/recurring", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "bulk-update",
        ids: [1],
        patch: { nextDate: "2026-02-31" },
      }),
    });
    const bulkUpdateRes = await PATCH(bulkUpdateReq);
    expect(bulkUpdateRes.status).toBe(400);
  });
});
