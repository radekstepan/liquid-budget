/**
 * contracts.test.ts
 *
 * Pins the server -> UI wire agreement: real query output must satisfy the
 * response contracts in @ynab/logic. If a serializer changes shape (e.g. a
 * raw drizzle row with numeric money leaks into a response), these fail
 * here instead of surfacing as a runtime parse error in the client.
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";
import { getBudgetData } from "../src/queries/budget.js";
import { getReconcileState } from "../src/queries/reconcile.js";
import { upsertAssignment } from "../src/queries/assignments.js";
import { seedDatabase } from "../src/seed.js";
import {
  parseAssignmentResponse,
  parseBudgetDataResponse,
  parseReconcileStateResponse,
} from "@ynab/logic";

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

describe("server response contracts", () => {
  let db: Db;
  beforeEach(async () => {
    db = openMigratedDb();
    await seedDatabase(db);
  });

  it("getBudgetData output satisfies the /api/budget response contract", async () => {
    const data = await getBudgetData(db);
    const parsed = parseBudgetDataResponse(data);
    expect(parsed.transactions.length).toBeGreaterThan(0);
    expect(parsed.accounts.length).toBeGreaterThan(0);
    expect(parsed).toEqual(data);
  });

  it("rejects budget data with numeric money (wire convention is strings)", async () => {
    const data = await getBudgetData(db);
    const tampered = {
      ...data,
      accounts: data.accounts.map((a, i) => (i === 0 ? { ...a, balance: 123 } : a)),
    };
    expect(() => parseBudgetDataResponse(tampered)).toThrow(/Invalid budget response/);
  });

  it("upsertAssignment raw row satisfies the assignment response contract", async () => {
    // The row carries numeric money (drizzle integer); the contract
    // normalizes it to the string convention the UI reads.
    const [cat] = await db.select().from(schema.categories).limit(1);
    const row = await upsertAssignment(db, {
      categoryId: cat!.id,
      month: "2026-06",
      amount: 1500,
    });
    expect(typeof row.amount).toBe("number");
    const parsed = parseAssignmentResponse(row);
    expect(parsed.amount).toBe("1500");
    expect(parsed.id).toBe(row.id);
  });

  it("getReconcileState output satisfies the reconcile response contract", async () => {
    const [acct] = await db.select().from(schema.accounts).limit(1);
    const state = await getReconcileState(db, acct!.id);
    const parsed = parseReconcileStateResponse(state);
    expect(parsed.accountId).toBe(acct!.id);
    expect(typeof parsed.workingBalance).toBe("number");
  });
});
