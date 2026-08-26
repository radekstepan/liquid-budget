import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createAccount, getDefaultDb, resetAndSeedDatabase } from "@ynab/server";
import { PATCH, POST } from "../src/app/api/accounts/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("Account API routes", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  describe("PATCH /api/accounts (BUG-04 & BUG-15)", () => {
    it("handles empty patch for account without throwing 'No values to set' (BUG-04)", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Savings", kind: "liquid" });

      const req = new NextRequest("http://localhost:3000/api/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: account!.id }),
      });
      const res = await PATCH(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.id).toBe(account!.id);
      expect(json.name).toBe("Savings");
    });

    it("updates specified fields on account", async () => {
      const db = getDefaultDb();
      const account = await createAccount(db, { name: "Checking", kind: "liquid" });

      const req = new NextRequest("http://localhost:3000/api/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: account!.id, name: "Primary Checking" }),
      });
      const res = await PATCH(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.id).toBe(account!.id);
      expect(json.name).toBe("Primary Checking");
    });

    it("BUG-15: returns 422 when attempting to change kind on an account with transactions", async () => {
      const db = getDefaultDb();
      // balance creates a starting balance transaction
      const account = await createAccount(db, { name: "Checking", kind: "liquid", balance: 50000 });

      const req = new NextRequest("http://localhost:3000/api/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: account!.id, kind: "offbudget" }),
      });
      const res = await PATCH(req);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain("Cannot change account type");
    });
  });

  describe("POST /api/accounts (BUG-15)", () => {
    it("creates off-budget account with default onBudget: false", async () => {
      const req = new NextRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Vanguard ETF",
          kind: "offbudget",
          groupLabel: "Tracking Accounts",
          balance: 200000,
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.kind).toBe("offbudget");
      expect(json.onBudget).toBe(false);
    });
  });
});
