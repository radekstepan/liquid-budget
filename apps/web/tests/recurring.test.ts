import { describe, expect, it, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  createAccount,
  createCategory,
  createCategoryGroup,
  createRecurring,
  getDefaultDb,
  recurring,
  resetAndSeedDatabase,
  transactions,
} from "@ynab/server";
import { DELETE, PATCH, POST } from "../src/app/api/recurring/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("Recurring API routes (BUG-19, BUG-41, BUG-42)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  describe("BUG-19 & BUG-41: Split recurring updates & empty array rejection", () => {
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

    it("BUG-41: rejects updating recurring split with empty subTransactions array", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });
      const group = await createCategoryGroup(db, { name: "Expenses" });
      const cat1 = await createCategory(db, { groupId: group!.id, name: "Groceries" });
      const cat2 = await createCategory(db, { groupId: group!.id, name: "Household" });

      const splitRec = await createRecurring(db, {
        accountId: account!.id,
        categoryId: null,
        payee: "Supermarket",
        amount: -5000,
        frequency: "monthly",
        nextDate: "2026-09-01",
        subTransactions: [
          { categoryId: cat1!.id, amount: -3000 },
          { categoryId: cat2!.id, amount: -2000 },
        ],
      });

      const req = new NextRequest("http://localhost:3000/api/recurring", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: splitRec!.id,
          subTransactions: [],
        }),
      });
      const res = await PATCH(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });

    it("BUG-41: rejects creating recurring with empty subTransactions array", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });

      const req = new NextRequest("http://localhost:3000/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account!.id,
          amount: -5000,
          frequency: "monthly",
          nextDate: "2026-09-01",
          subTransactions: [],
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("BUG-42: Action endpoint validation and accurate counts", () => {
    it("rejects invalid id in query action=post", async () => {
      const req1 = new NextRequest("http://localhost:3000/api/recurring?action=post&id=not-an-id", {
        method: "POST",
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(400);

      const req2 = new NextRequest("http://localhost:3000/api/recurring?action=post&id=-5", {
        method: "POST",
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(400);
    });

    it("rejects invalid dates in query action=post and action=autopost", async () => {
      const postQueryReq = new NextRequest("http://localhost:3000/api/recurring?action=post&id=1&date=2026-04-31", {
        method: "POST",
      });
      const postQueryRes = await POST(postQueryReq);
      expect(postQueryRes.status).toBe(400);

      const autopostReq = new NextRequest("http://localhost:3000/api/recurring?action=autopost&asOfDate=2026-02-29", {
        method: "POST",
      });
      const autopostRes = await POST(autopostReq);
      expect(autopostRes.status).toBe(400);
    });

    it("bulk-update validates IDs and accurately reports updatedCount for mixed IDs", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });
      const rec = await createRecurring(db, {
        accountId: account!.id,
        categoryId: null,
        amount: -1500,
        frequency: "monthly",
        nextDate: "2026-09-01",
        payee: "Netflix",
      });

      // 1. Malformed string ID in list
      const invalidReq = new NextRequest("http://localhost:3000/api/recurring", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "bulk-update",
          ids: ["not-an-id"],
          patch: { flagColor: "green" },
        }),
      });
      const invalidRes = await PATCH(invalidReq);
      expect(invalidRes.status).toBe(400);

      // 2. Mixed valid ID and non-existent ID
      const mixedReq = new NextRequest("http://localhost:3000/api/recurring", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "bulk-update",
          ids: [rec!.id, 99999],
          patch: { flagColor: "green" },
        }),
      });
      const mixedRes = await PATCH(mixedReq);
      expect(mixedRes.status).toBe(200);
      const mixedJson = await mixedRes.json();
      expect(mixedJson.updatedCount).toBe(1);
    });

    it("bulk-delete validates IDs and accurately reports deletedCount for mixed IDs", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });
      const rec = await createRecurring(db, {
        accountId: account!.id,
        categoryId: null,
        amount: -1500,
        frequency: "monthly",
        nextDate: "2026-09-01",
        payee: "Netflix",
      });

      // 1. Malformed IDs
      const invalidReq = new NextRequest("http://localhost:3000/api/recurring", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: ["not-an-id"],
        }),
      });
      const invalidRes = await DELETE(invalidReq);
      expect(invalidRes.status).toBe(400);

      // 2. Mixed valid ID and non-existent ID
      const mixedReq = new NextRequest("http://localhost:3000/api/recurring", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: [rec!.id, 99999],
        }),
      });
      const mixedRes = await DELETE(mixedReq);
      expect(mixedRes.status).toBe(200);
      const mixedJson = await mixedRes.json();
      expect(mixedJson.deletedCount).toBe(1);
    });

    it("DELETE with query id validates id parameter", async () => {
      const req = new NextRequest("http://localhost:3000/api/recurring?id=not-a-number", {
        method: "DELETE",
      });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });

    it("DELETE with query id returns 404 for non-existent recurring", async () => {
      const req = new NextRequest("http://localhost:3000/api/recurring?id=99999", {
        method: "DELETE",
      });
      const res = await DELETE(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("not found");
    });

    it("PATCH on non-existent recurring returns 404", async () => {
      const req = new NextRequest("http://localhost:3000/api/recurring", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 99999, payee: "Nobody" }),
      });
      const res = await PATCH(req);
      expect(res.status).toBe(404);
    });
  });

  describe("BUG-18.5: bulk operations use per-item isolation", () => {
    it("bulk-post commits the valid ids even when a middle id fails", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });
      const rec1 = await createRecurring(db, {
        accountId: account!.id,
        categoryId: null,
        amount: -1000,
        frequency: "monthly",
        nextDate: "2026-09-01",
        payee: "First",
      });
      const rec2 = await createRecurring(db, {
        accountId: account!.id,
        categoryId: null,
        amount: -2000,
        frequency: "monthly",
        nextDate: "2026-09-01",
        payee: "Third",
      });

      // The 2nd id in the batch does not exist → its post fails; the 1st
      // and 3rd must still be committed.
      const req = new NextRequest("http://localhost:3000/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk-post", ids: [rec1!.id, 999999, rec2!.id] }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.postedCount).toBe(2);
      expect(json.failures).toEqual([
        { id: 999999, error: "Recurring transaction not found" },
      ]);

      // Both valid posts were committed: schedules advanced and transaction
      // rows exist on the fresh account.
      const [r1] = await db.select().from(recurring).where(eq(recurring.id, rec1!.id));
      const [r2] = await db.select().from(recurring).where(eq(recurring.id, rec2!.id));
      expect(r1?.nextDate).toBe("2026-10-01");
      expect(r2?.nextDate).toBe("2026-10-01");
      const posted = await db.select().from(transactions).where(eq(transactions.accountId, account!.id));
      expect(posted).toHaveLength(2);
    });

    it("bulk-delete deletes the valid ids even when a middle id is missing", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });
      const rec1 = await createRecurring(db, {
        accountId: account!.id,
        categoryId: null,
        amount: -1000,
        frequency: "monthly",
        nextDate: "2026-09-01",
        payee: "First",
      });
      const rec2 = await createRecurring(db, {
        accountId: account!.id,
        categoryId: null,
        amount: -2000,
        frequency: "monthly",
        nextDate: "2026-09-01",
        payee: "Third",
      });

      const req = new NextRequest("http://localhost:3000/api/recurring", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [rec1!.id, 999999, rec2!.id] }),
      });
      const res = await DELETE(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.deletedCount).toBe(2);

      const remaining = await db.select().from(recurring).where(eq(recurring.accountId, account!.id));
      expect(remaining).toHaveLength(0);
    });
  });
});
