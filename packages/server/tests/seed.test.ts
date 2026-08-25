/**
 * seed.test.ts
 *
 * Behavioral test for the server-side demo seed. The seed fixture is
 * heavily exercised through `makeSeedBudgetData()` (logic package) and
 * `getBudgetData()` against a mock DB, but `seedDatabase` itself was
 * never executed by a test — these pin the demo data invariants the
 * e2e suite relies on (account/group/category counts, the TD
 * reconcile stamp, and idempotence).
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { seedDatabase, resetDatabase } from "../src/seed.js";
import { getBudgetData, isSeeded } from "../src/queries/budget.js";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openMigratedDb(): Db {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe("seedDatabase", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("seeds a fresh database", async () => {
    expect(await isSeeded(db)).toBe(false);
    await seedDatabase(db);
    expect(await isSeeded(db)).toBe(true);
  });

  it("creates the expected demo shape", async () => {
    await seedDatabase(db);
    const data = await getBudgetData(db);
    expect(data.accounts).toHaveLength(18);
    expect(data.groups).toHaveLength(5);
    expect(data.categories).toHaveLength(32);
    expect(data.recurring).toHaveLength(10);
    expect(data.transactions.length).toBeGreaterThan(50);
    expect(data.assignments.length).toBeGreaterThan(0);
  });

  it("stamps the TD chequing account as previously reconciled", async () => {
    await seedDatabase(db);
    const data = await getBudgetData(db);
    const td = data.accounts.find((a) => a.name === "TD Unlimited Chequing");
    expect(td).toBeTruthy();
    expect(td!.lastReconciledAt).toBe("2026-04-10");
    expect(Number(td!.lastReconciledBalance)).toBe(608358);
  });

  it("marks exactly one category group as credit-card payments", async () => {
    await seedDatabase(db);
    const data = await getBudgetData(db);
    const cc = data.groups.filter((g) => g.isCreditCardPayments);
    expect(cc).toHaveLength(1);
  });

  it("is idempotent — a second call does not duplicate data", async () => {
    await seedDatabase(db);
    await seedDatabase(db);
    const data = await getBudgetData(db);
    expect(data.accounts).toHaveLength(18);
    expect(data.categories).toHaveLength(32);
  });

  it("re-seeds after resetDatabase wipes all rows", async () => {
    await seedDatabase(db);
    await resetDatabase(db);
    expect(await isSeeded(db)).toBe(false);
    await seedDatabase(db);
    const data = await getBudgetData(db);
    expect(data.accounts).toHaveLength(18);
  });

  it("wipes payees and reconciliations on resetDatabase", async () => {
    await seedDatabase(db);
    const [acc] = await db.select().from(schema.accounts).limit(1);
    await db.insert(schema.payees).values({ name: "Test Payee" });
    await db.insert(schema.reconciliations).values({
      accountId: acc.id,
      reconciledAt: "2026-04-10",
      statementDate: "2026-04-10",
      statementBalance: 1000,
    });
    expect(await db.select().from(schema.payees)).toHaveLength(1);
    expect(await db.select().from(schema.reconciliations)).toHaveLength(1);

    await resetDatabase(db);

    expect(await db.select().from(schema.payees)).toHaveLength(0);
    expect(await db.select().from(schema.reconciliations)).toHaveLength(0);
  });
});
