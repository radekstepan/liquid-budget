import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createAccount, getDefaultDb, resetAndSeedDatabase } from "@ynab/server";
import { PATCH } from "../src/app/api/accounts/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("PATCH /api/accounts (BUG-04)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

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
});
