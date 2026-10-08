import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import type { CsvImportRow } from "@ynab/logic";
import { importCsvTransactions } from "../src/import-csv.js";
import { getBudgetData } from "../src/queries/budget.js";
import {
  bulkUpdateTransactions,
  createTransfer,
  updateSplit,
  updateTransaction,
} from "../src/queries/transactions.js";
import {
  applyRenameRuleToExisting,
  createRenameRule,
  deleteRenameRule,
  getRenameRules,
  learnRenameRuleFromPayees,
  RenameRuleError,
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

  it("applies separator folding on import without any pattern", async () => {
    const accountId = await seedAccount();
    await createRenameRule(db, { sourcePattern: "AMZN*MKTP", targetPayee: "Amazon" });

    await importCsvTransactions(db, {
      accountId,
      rows: [row({ payee: "AMZN-MKTP", amountCents: -1000 })],
    });

    const data = await getBudgetData(db);
    expect(data.transactions.map((t) => t.payee)).toEqual(["Amazon"]);
  });

  it("applies a learned [X] pattern to the next import", async () => {
    const accountId = await seedAccount();
    await learnRenameRuleFromPayees(db, "AMZN Mktp US*RT3ABCD12", "Amazon");
    await learnRenameRuleFromPayees(db, "AMZN Mktp US*XY9ZZ", "Amazon");
    expect(getRenameRules(db)[0]!.sourcePattern).toContain("[X]");

    await importCsvTransactions(db, {
      accountId,
      rows: [row({ payee: "AMZN Mktp US*QQ1WW", amountCents: -1000 })],
    });

    const data = await getBudgetData(db);
    expect(data.transactions.map((t) => t.payee)).toEqual(["Amazon"]);
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

describe("transfer guards", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  async function seedTwoAccounts() {
    const mk = (name: string, sort: number) =>
      db
        .insert(schema.accounts)
        .values({ name, kind: "liquid", groupLabel: "Budget Accounts", balance: 0, onBudget: true, sort })
        .returning();
    const [src] = await mk("Chequing", 0);
    const [dst] = await mk("Savings", 1);
    return { srcId: src!.id, dstId: dst!.id };
  }

  it("learnRenameRuleFromPayees ignores a transfer source", async () => {
    const { generalised, rules } = await learnRenameRuleFromPayees(db, "Transfer : Savings", "Foobar");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(0);
    expect(getRenameRules(db)).toHaveLength(0);
  });

  it("learnRenameRuleFromPayees ignores a transfer target", async () => {
    const { generalised, rules } = await learnRenameRuleFromPayees(db, "BCF1", "Transfer : Savings");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(0);
    expect(getRenameRules(db)).toHaveLength(0);
  });

  it("createRenameRule rejects transfer-like sources and targets", async () => {
    await expect(
      createRenameRule(db, { sourcePattern: "Transfer : Savings", targetPayee: "Foobar" })
    ).rejects.toBeInstanceOf(RenameRuleError);
    await expect(
      createRenameRule(db, { sourcePattern: "BCF1", targetPayee: "Transfer : Savings" })
    ).rejects.toBeInstanceOf(RenameRuleError);
    expect(getRenameRules(db)).toHaveLength(0);
  });

  it("updateRenameRule rejects patching a rule into the transfer domain", async () => {
    const r = await createRenameRule(db, { sourcePattern: "BCF1", targetPayee: "BC Ferries" });
    await expect(updateRenameRule(db, r.id, { targetPayee: "Transfer : Savings" })).rejects.toBeInstanceOf(
      RenameRuleError
    );
    await expect(updateRenameRule(db, r.id, { sourcePattern: "Transfer : Savings" })).rejects.toBeInstanceOf(
      RenameRuleError
    );
    expect(getRenameRules(db)[0]).toMatchObject({
      sourcePattern: "BCF1",
      targetPayee: "BC Ferries",
    });
  });

  it("editing a transfer payee does not learn a rule", async () => {
    const { srcId, dstId } = await seedTwoAccounts();
    const t = await createTransfer(
      db,
      { accountId: srcId, date: "2026-08-13", payee: "", memo: "", amount: -5000 },
      dstId
    );
    expect(t.payee).toBe("Transfer : Savings");

    await updateTransaction(db, t.id, { payee: "Foobar" });
    expect(getRenameRules(db)).toHaveLength(0);
  });

  it("bulk editing a transfer payee does not learn a rule", async () => {
    const { srcId, dstId } = await seedTwoAccounts();
    const t = await createTransfer(
      db,
      { accountId: srcId, date: "2026-08-13", payee: "", memo: "", amount: -5000 },
      dstId
    );

    await bulkUpdateTransactions(db, [t.id], { payee: "Foobar" });
    expect(getRenameRules(db)).toHaveLength(0);
  });

  it("converting a transfer to a split does not learn a rule", async () => {
    const { srcId, dstId } = await seedTwoAccounts();
    const [group] = await db
      .insert(schema.categoryGroups)
      .values({ name: "Living", sort: 0 })
      .returning();
    const [cat] = await db
      .insert(schema.categories)
      .values({ groupId: group!.id, name: "Groceries", sort: 0 })
      .returning();
    const t = await createTransfer(
      db,
      { accountId: srcId, date: "2026-08-13", payee: "", memo: "", amount: -5000 },
      dstId
    );

    const res = await updateSplit(
      db,
      t.id,
      { payee: "Foobar" },
      [
        { categoryId: cat!.id, amount: -3000, memo: "a" },
        { categoryId: cat!.id, amount: -2000, memo: "b" },
      ]
    );
    expect(res.children).toHaveLength(2);
    expect(getRenameRules(db)).toHaveLength(0);
  });
});

describe("applyRenameRuleToExisting", () => {
  let db: Db;
  beforeEach(() => {
    db = openMigratedDb();
  });

  async function seedAccount(name = "Chequing") {
    const [a] = await db
      .insert(schema.accounts)
      .values({
        name,
        kind: "liquid",
        groupLabel: "Budget Accounts",
        balance: 100000,
        onBudget: true,
        sort: 0,
      })
      .returning();
    return a!.id;
  }

  function insertTx(
    accountId: number,
    over: {
      payee?: string;
      amount?: number;
      status?: string;
      transferAccountId?: number | null;
      parentId?: number | null;
      needsReview?: boolean;
    } = {}
  ) {
    const {
      payee = "BCF1",
      amount = -1000,
      status = "c",
      transferAccountId = null,
      parentId = null,
      needsReview = false,
    } = over;
    const row = db
      .insert(schema.transactions)
      .values({
        accountId,
        categoryId: null,
        date: "2026-08-13",
        payee,
        payeeId: null,
        memo: "",
        amount,
        status: status as "u" | "c" | "r",
        transferStatus: transferAccountId != null ? ("c" as const) : null,
        flagColor: null,
        transferAccountId,
        parentId,
        isIncome: false,
        incomeMonth: null,
        needsReview,
      })
      .returning()
      .get();
    return row!.id;
  }

  function payeesOf(accountId: number): string[] {
    return db
      .select({ payee: schema.transactions.payee })
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, accountId))
      .all()
      .map((r) => r.payee)
      .sort();
  }

  it("renames matching stored payees and links the target payee entity", async () => {
    const accountId = await seedAccount();
    insertTx(accountId, { payee: "BCF1", amount: -1000 });
    insertTx(accountId, { payee: "BCF2", amount: -2000 });
    insertTx(accountId, { payee: "UBER TRIP", amount: -500 });
    const rule = await createRenameRule(db, {
      sourcePattern: "BCF[N]",
      targetPayee: "BC Ferries",
    });

    const res = await applyRenameRuleToExisting(db, rule.id);

    expect(res).toMatchObject({ updated: 2, skippedLocked: 0 });
    expect(payeesOf(accountId)).toEqual(["BC Ferries", "BC Ferries", "UBER TRIP"]);

    const target = db
      .select()
      .from(schema.payees)
      .where(eq(schema.payees.name, "BC Ferries"))
      .get();
    expect(target).toBeTruthy();
    const linked = db
      .select({ payeeId: schema.transactions.payeeId })
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, accountId))
      .all();
    expect(linked.filter((r) => r.payeeId === target!.id)).toHaveLength(2);
  });

  it("is a no-op the second time (idempotent)", async () => {
    const accountId = await seedAccount();
    insertTx(accountId, { payee: "BCF1" });
    const rule = await createRenameRule(db, {
      sourcePattern: "BCF1",
      targetPayee: "BC Ferries",
    });

    expect(await applyRenameRuleToExisting(db, rule.id)).toMatchObject({
      updated: 1,
      skippedLocked: 0,
    });
    expect(await applyRenameRuleToExisting(db, rule.id)).toMatchObject({
      updated: 0,
      skippedLocked: 0,
    });
  });

  it("counts reconciled rows as skippedLocked instead of editing them", async () => {
    const accountId = await seedAccount();
    insertTx(accountId, { payee: "BCF1", amount: -1000, status: "c" });
    insertTx(accountId, { payee: "BCF2", amount: -2000, status: "r" });
    const rule = await createRenameRule(db, {
      sourcePattern: "BCF[N]",
      targetPayee: "BC Ferries",
    });

    const res = await applyRenameRuleToExisting(db, rule.id);

    expect(res).toMatchObject({ updated: 1, skippedLocked: 1 });
    expect(payeesOf(accountId)).toEqual(["BC Ferries", "BCF2"]);
  });

  it("never rewrites transfers or split children", async () => {
    const srcId = await seedAccount("Chequing");
    const dstId = await seedAccount("Savings");
    insertTx(srcId, { payee: "BCF1", transferAccountId: dstId });
    const parentId = insertTx(srcId, { payee: "Split parent" });
    insertTx(srcId, { payee: "BCF1", parentId });
    insertTx(srcId, { payee: "BCF2" });
    const rule = await createRenameRule(db, {
      sourcePattern: "BCF[N]",
      targetPayee: "BC Ferries",
    });

    const res = await applyRenameRuleToExisting(db, rule.id);

    expect(res).toMatchObject({ updated: 1, skippedLocked: 0 });
    expect(payeesOf(srcId).sort()).toEqual(
      ["BC Ferries", "BCF1", "BCF1", "Split parent"].sort()
    );
  });

  it("applies separator folding and [X] patterns to history too", async () => {
    const accountId = await seedAccount();
    insertTx(accountId, { payee: "AMZN*MKTP US*RT3ABCD12" });
    const rule = await createRenameRule(db, {
      sourcePattern: "AMZN Mktp US*[X]",
      targetPayee: "Amazon",
    });

    const res = await applyRenameRuleToExisting(db, rule.id);

    expect(res).toMatchObject({ updated: 1, skippedLocked: 0 });
    expect(payeesOf(accountId)).toEqual(["Amazon"]);
  });

  it("returns null for an unknown rule", async () => {
    await expect(applyRenameRuleToExisting(db, 4242)).resolves.toBeNull();
  });

  it("leaves the imported (needsReview) flag untouched on rewritten rows", async () => {
    const accountId = await seedAccount();
    const flagged = insertTx(accountId, { payee: "BCF1", needsReview: true });
    const unflagged = insertTx(accountId, { payee: "BCF2", needsReview: false });
    const rule = await createRenameRule(db, {
      sourcePattern: "BCF[N]",
      targetPayee: "BC Ferries",
    });

    const res = await applyRenameRuleToExisting(db, rule.id);

    expect(res).toMatchObject({ updated: 2, skippedLocked: 0 });
    // A rule backfill is automatic, not a user review: imported rows stay
    // bold until the user approves, edits, or reconciles them.
    const rows = db
      .select({ id: schema.transactions.id, needsReview: schema.transactions.needsReview })
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, accountId))
      .all();
    expect(rows.find((r) => r.id === flagged)?.needsReview).toBe(true);
    expect(rows.find((r) => r.id === unflagged)?.needsReview).toBe(false);
  });
});
