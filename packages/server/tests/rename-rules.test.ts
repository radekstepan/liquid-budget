import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import type { CsvImportRow } from "@ynab/logic";
import { importCsvTransactions } from "../src/import-csv.js";
import { getBudgetData } from "../src/queries/budget.js";
import { updateTransaction } from "../src/queries/transactions.js";
import {
  createRenameRule,
  deleteRenameRule,
  getRenameRules,
  learnRenameRuleFromPayees,
  updateRenameRule,
} from "../src/queries/rename-rules.js";
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

const row = (over: Partial<CsvImportRow>): CsvImportRow => ({
  rowNumber: 2,
  date: "2026-08-13",
  payee: "Store",
  memo: "",
  category: "",
  amountCents: -2808,
  error: null,
  ...over,
});

describe("rename_rules table", () => {
  it("exists in the migration with a unique source+target constraint", async () => {
    const db = openMigratedDb();
    const created = await createRenameRule(db, { sourcePattern: "BCF1", targetPayee: "BC Ferries" });
    expect(created.id).toBeGreaterThan(0);

    await expect(
      createRenameRule(db, { sourcePattern: "BCF1", targetPayee: "BC Ferries" })
    ).rejects.toThrow();
  });
});

describe("rename rule CRUD", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("lists rules ordered by creation", async () => {
    await createRenameRule(db, { sourcePattern: "BCF2", targetPayee: "BC Ferries" });
    await createRenameRule(db, { sourcePattern: "UBER", targetPayee: "Uber" });
    const rules = getRenameRules(db);
    expect(rules.map((r) => r.sourcePattern)).toEqual(["BCF2", "UBER"]);
  });

  it("updates a rule's pattern and target", async () => {
    const r = await createRenameRule(db, { sourcePattern: "BCF1", targetPayee: "BC Ferries" });
    const updated = await updateRenameRule(db, r.id, { targetPayee: "BC Ferries West" });
    expect(updated?.targetPayee).toBe("BC Ferries West");
    expect(getRenameRules(db)[0]!.targetPayee).toBe("BC Ferries West");
  });

  it("deletes a rule", async () => {
    const r = await createRenameRule(db, { sourcePattern: "BCF1", targetPayee: "BC Ferries" });
    expect(deleteRenameRule(db, r.id)).toBe(true);
    expect(getRenameRules(db)).toHaveLength(0);
  });
});

describe("learnRenameRuleFromPayees", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  it("creates an exact rule from a single rename", async () => {
    const { generalised, rules } = await learnRenameRuleFromPayees(db, "BCF1", "BC Ferries");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      sourcePattern: "BCF1",
      targetPayee: "BC Ferries",
    });
  });

  it("generalises a second rename to BCF[N]", async () => {
    await learnRenameRuleFromPayees(db, "BCF1", "BC Ferries");
    const { generalised, rules } = await learnRenameRuleFromPayees(db, "BCF2", "BC Ferries");
    expect(generalised).toBe(true);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sourcePattern).toBe("BCF[N]");
    expect(rules[0]!.targetPayee).toBe("BC Ferries");
  });

  it("keeps different targets as separate exact rules", async () => {
    await learnRenameRuleFromPayees(db, "BCF1", "BC Ferries");
    const { generalised, rules } = await learnRenameRuleFromPayees(db, "BCF2", "BC Ferries Downtown");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(2);
  });
});

describe("CSV import applies rename rules", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  async function seedAccount(balance = 100000) {
    const [a] = await db
      .insert(schema.accounts)
      .values({
        name: "Chequing",
        kind: "liquid",
        groupLabel: "Budget Accounts",
        balance,
        onBudget: true,
        sort: 0,
      })
      .returning();
    return a!.id;
  }

  it("renames matching payees during import", async () => {
    const accountId = await seedAccount();
    await createRenameRule(db, { sourcePattern: "BCF[N]", targetPayee: "BC Ferries" });

    await importCsvTransactions(db, {
      accountId,
      rows: [
        row({ rowNumber: 2, payee: "BCF1", amountCents: -1000 }),
        row({ rowNumber: 3, payee: "UBER TRIP", amountCents: -500 }),
      ],
    });

    const data = await getBudgetData(db);
    const payees = data.transactions.map((t) => t.payee).sort();
    expect(payees).toEqual(["BC Ferries", "UBER TRIP"]);
  });

  it("uses renamed payees for duplicate detection on re-import", async () => {
    const accountId = await seedAccount();
    await createRenameRule(db, { sourcePattern: "BCF[N]", targetPayee: "BC Ferries" });

    const first = await importCsvTransactions(db, {
      accountId,
      rows: [row({ payee: "BCF1", amountCents: -1000 })],
    });
    expect(first.count).toBe(1);

    // The same raw BCF1 now matches the renamed transaction.
    const second = await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 2, payee: "BCF1", amountCents: -1000 })],
    });
    expect(second.count).toBe(0);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]!.reason).toBe("Matches an existing transaction");
  });

  it("a rename learned from an edit applies to the next import", async () => {
    const accountId = await seedAccount();
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ payee: "BCF1", amountCents: -1000 })],
    });

    const data = await getBudgetData(db);
    const txn = data.transactions[0]!;
    await learnRenameRuleFromPayees(db, txn.payee, "BC Ferries");

    // A later import of the same raw payee (different amount, so not a
    // duplicate) is renamed automatically by the learned rule.
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 3, payee: "BCF1", amountCents: -2000 })],
    });

    const after = await getBudgetData(db);
    const bcf2 = after.transactions.find((t) => t.amount === "-2000");
    expect(bcf2?.payee).toBe("BC Ferries");
  });

  it("editing a transaction payee through updateTransaction learns a rule", async () => {
    const accountId = await seedAccount();
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ payee: "BCF1", amountCents: -1000 })],
    });

    const data = await getBudgetData(db);
    const txn = data.transactions[0]!;
    await updateTransaction(db, txn.id, { payee: "BC Ferries" });

    const rules = getRenameRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sourcePattern).toBe("BCF1");
    expect(rules[0]!.targetPayee).toBe("BC Ferries");

    // A second rename on a sibling transaction generalises the rule.
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 3, payee: "BCF2", amountCents: -2000 })],
    });
    const after = await getBudgetData(db);
    const bcf2 = after.transactions.find((t) => t.amount === "-2000")!;
    await updateTransaction(db, bcf2.id, { payee: "BC Ferries" });

    const rulesAfter = getRenameRules(db);
    expect(rulesAfter).toHaveLength(1);
    expect(rulesAfter[0]!.sourcePattern).toBe("BCF[N]");
    expect(rulesAfter[0]!.targetPayee).toBe("BC Ferries");
  });

  it("updates rename rule and applies the newest target when an exact source is renamed again (BUG-23)", async () => {
    const accountId = await seedAccount();
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ payee: "BCF1", amountCents: -1000 })],
    });

    const data1 = await getBudgetData(db);
    const txn1 = data1.transactions[0]!;
    await updateTransaction(db, txn1.id, { payee: "Old" });

    let rules = getRenameRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sourcePattern).toBe("BCF1");
    expect(rules[0]!.targetPayee).toBe("Old");

    // Explicitly re-learn BCF1 -> New
    await learnRenameRuleFromPayees(db, "BCF1", "New");
    rules = getRenameRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sourcePattern).toBe("BCF1");
    expect(rules[0]!.targetPayee).toBe("New");

    // A later import of BCF1 must now be renamed to "New", not "Old"
    await importCsvTransactions(db, {
      accountId,
      rows: [row({ rowNumber: 3, payee: "BCF1", amountCents: -3000 })],
    });

    const after = await getBudgetData(db);
    const bcf3 = after.transactions.find((t) => t.amount === "-3000");
    expect(bcf3?.payee).toBe("New");
  });
});
