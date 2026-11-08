/**
 * Regression: rename-rule learning on merge/approve + casing drift.
 *
 * Pins the learning wiring: `learnRenameRuleFromPayees` is called from
 * `mergeTransactions` (transactions.ts:1659-1831) in addition to the
 * single-rename paths (transactions.ts:1124-1126, 1393-1395, 2128-2130;
 * payees.ts:181, 271-273; rename-suggest.ts:147), and case-only renames
 * ("starbucks" -> "Starbucks") learn a rule so stored rows converge
 * (logic/.../rename-rules.ts).
 *
 * Fix commit: dbd85b8 (g-rename-learn).
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import {
  createTransaction,
  mergeTransactions,
  updateTransaction,
} from "../src/queries/transactions.js";
import { getRenameRules } from "../src/queries/rename-rules.js";
import * as schema from "../src/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openMigratedDb() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

async function seedAccount(db: ReturnType<typeof openMigratedDb>) {
  const [account] = await db
    .insert(schema.accounts)
    .values({
      name: "Checking",
      kind: "liquid",
      groupLabel: "Budget Accounts",
      balance: 0,
      onBudget: true,
      sort: 0,
    })
    .returning();
  return account!.id;
}

describe("ynab4 parity: rename learning on merge/approve + casing drift", () => {
  it("merge/approve path creates a rename rule from old -> new payee", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    const a = await createTransaction(db, {
      accountId,
      date: "2026-09-01",
      payee: "STARBUCKS #12",
      amount: -450,
      status: "u",
    });
    const b = await createTransaction(db, {
      accountId,
      date: "2026-09-02",
      payee: "Starbucks",
      amount: -450,
      status: "u",
    });
    await mergeTransactions(db, [a.id, b.id]);
    const rules = getRenameRules(db);
    // mergeTransactions (1659-1831) calls learnRenameRuleFromPayees,
    // so a rule is learned.
    expect(rules.length).toBeGreaterThan(0);
  });

  it('case-only rename "starbucks" -> "Starbucks" auto-converges', async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    const t = await createTransaction(db, {
      accountId,
      date: "2026-09-03",
      payee: "starbucks",
      amount: -450,
      status: "u",
    });
    await updateTransaction(db, t.id, { payee: "Starbucks" });
    const rules = getRenameRules(db);
    // Case-only differences learn a rule so stored rows converge
    // to "Starbucks".
    expect(rules.some((r) => r.targetPayee === "Starbucks")).toBe(true);
  });
});
