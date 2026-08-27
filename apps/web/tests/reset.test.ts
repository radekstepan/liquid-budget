import { describe, expect, it, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { accounts, getDefaultDb, resetAndSeedDatabase } from "@ynab/server";
import { POST } from "../src/app/api/reset/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("POST /api/reset (BUG-03)", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  it("resets and reseeds database atomically returning 200", async () => {
    const db = getDefaultDb();
    // Add custom account before reset
    await db.insert(accounts).values({
      name: "Custom Account Before Reset",
      kind: "liquid",
      groupLabel: "Budget Accounts",
      balance: 50000,
      onBudget: true,
      sort: 99,
    });

    const res = await POST();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.message).toBe("Database reset and re-seeded.");

    // Demo data is seeded and custom account is gone
    const allAccounts = await db.select().from(accounts);
    expect(allAccounts).toHaveLength(18);
    expect(allAccounts.some((a) => a.name === "Custom Account Before Reset")).toBe(false);
    expect(allAccounts.some((a) => a.name === "TD Unlimited Chequing")).toBe(true);
  });

  it("rolls back wipe and preserves pre-existing database on seed failure", async () => {
    const db = getDefaultDb();
    // Add custom account before reset
    await db.insert(accounts).values({
      name: "Important User Account",
      kind: "liquid",
      groupLabel: "Budget Accounts",
      balance: 77700,
      onBudget: true,
      sort: 99,
    });

    // Create a temporary SQLite trigger to inject a failure during the seed phase (inserting category_groups)
    await db.run(
      sql`CREATE TRIGGER fail_seed_trigger BEFORE INSERT ON category_groups BEGIN SELECT RAISE(ABORT, 'Injected seed trigger failure'); END;`
    );

    // Temporarily spy on console.error to keep test output clean
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.message).toContain("Injected seed trigger failure");

    consoleSpy.mockRestore();

    // Clean up trigger
    await db.run(sql`DROP TRIGGER IF EXISTS fail_seed_trigger`);

    // Verify all original data was preserved due to atomic rollback
    const allAccounts = await db.select().from(accounts);
    expect(allAccounts).toHaveLength(19);
    expect(allAccounts.some((a) => a.name === "Important User Account")).toBe(true);
  });
});
