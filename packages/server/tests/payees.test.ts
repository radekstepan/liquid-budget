import path from "path";
import { fileURLToPath } from "url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, beforeEach } from "vitest";
import { openDb, type Db } from "../src/client.js";
import {
  payees,
  accounts,
  categories,
  categoryGroups,
  transactions,
  recurring,
} from "../src/schema.js";
import {
  getPayees,
  getPayeeById,
  getPayeeByName,
  findOrCreatePayee,
  updatePayee,
  deletePayee,
  mergePayees,
  PayeeError,
} from "../src/queries/payees.js";
import { getRenameRules } from "../src/queries/rename-rules.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

describe("Payees Entity & Management (UNI-38 / F-19)", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    db.run(`INSERT INTO accounts (id, name, kind, group_label, balance, on_budget, sort, archived) VALUES (1, 'Checking', 'liquid', 'Budget', 100000, 1, 0, 0);`);
    db.run(`INSERT INTO accounts (id, name, kind, group_label, balance, on_budget, sort, archived) VALUES (2, 'Savings', 'liquid', 'Budget', 50000, 1, 1, 0);`);
    db.run(`INSERT INTO category_groups (id, name, sort, is_credit_card_payments) VALUES (1, 'Daily', 0, 0);`);
    db.run(`INSERT INTO categories (id, group_id, name, sort, carryover) VALUES (10, 1, 'Groceries', 0, 0);`);
  });

  it("creates and retrieves payees", () => {
    const p1 = findOrCreatePayee(db, "Target", 10);
    expect(p1.id).toBeDefined();
    expect(p1.name).toBe("Target");
    expect(p1.autoCategoryId).toBe(10);

    const all = getPayees(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe("Target");

    const fetched = getPayeeById(db, p1.id);
    expect(fetched?.name).toBe("Target");

    const byName = getPayeeByName(db, "Target");
    expect(byName?.id).toBe(p1.id);
  });

  it("deduplicates payee creation when found by name", () => {
    const p1 = findOrCreatePayee(db, "Trader Joe's", 10);
    const p2 = findOrCreatePayee(db, "Trader Joe's");
    expect(p1.id).toBe(p2.id);
    expect(getPayees(db)).toHaveLength(1);
  });

  it("updates payee name and propagates to transactions and recurring rules", async () => {
    const p = findOrCreatePayee(db, "Whole Foods", 10);

    db.run(
      `INSERT INTO transactions (account_id, category_id, date, payee, payee_id, memo, amount, status, created_at, is_income) VALUES (1, 10, '2026-06-01', 'Whole Foods', ${p.id}, '', -5000, 'c', '', 0);`
    );
    db.run(
      `INSERT INTO recurring (account_id, category_id, payee, payee_id, amount, frequency, next_date, active) VALUES (1, 10, 'Whole Foods', ${p.id}, -5000, 'monthly', '2026-07-01', 1);`
    );

    const updated = await updatePayee(db, p.id, { name: "Whole Foods Market" });
    expect(updated?.name).toBe("Whole Foods Market");

    const tx = db.select().from(transactions).all()[0]!;
    expect(tx.payee).toBe("Whole Foods Market");

    const rec = db.select().from(recurring).all()[0]!;
    expect(rec.payee).toBe("Whole Foods Market");
  });

  it("updates payee name and propagates to transactions and recurring with null payee_id by name", async () => {
    const p = findOrCreatePayee(db, "Target Superstore", 10);

    db.run(
      `INSERT INTO transactions (account_id, category_id, date, payee, memo, amount, status, created_at, is_income) VALUES (1, 10, '2026-06-01', 'Target Superstore', '', -5000, 'c', '', 0);`
    );
    db.run(
      `INSERT INTO recurring (account_id, category_id, payee, amount, frequency, next_date, active) VALUES (1, 10, 'Target Superstore', -5000, 'monthly', '2026-07-01', 1);`
    );

    const updated = await updatePayee(db, p.id, { name: "Target" });
    expect(updated?.name).toBe("Target");

    const tx = db.select().from(transactions).all()[0]!;
    expect(tx.payee).toBe("Target");

    const rec = db.select().from(recurring).all()[0]!;
    expect(rec.payee).toBe("Target");
  });

  it("BUG-22: does not cascade payee name to split children or transfer rows by raw text match", async () => {
    const p = findOrCreatePayee(db, "Landlord", 10);

    // 1. Regular transaction with matching text (legacy, null payeeId) -> SHOULD update
    db.run(
      `INSERT INTO transactions (account_id, category_id, date, payee, memo, amount, status, created_at, is_income) VALUES (1, 10, '2026-06-01', 'Landlord', '', -5000, 'c', '', 0);`
    );

    // 2. Split parent row with matching text (null payeeId) -> SHOULD update
    db.run(
      `INSERT INTO transactions (id, account_id, date, payee, memo, amount, status, created_at, is_income) VALUES (100, 1, '2026-06-01', 'Landlord', '', -10000, 'c', '', 0);`
    );

    // 3. Split child row with matching text (null payeeId, parent_id = 100) -> should NOT update
    db.run(
      `INSERT INTO transactions (id, account_id, parent_id, date, payee, memo, amount, status, created_at, is_income) VALUES (101, 1, 100, '2026-06-01', 'Landlord', '', -5000, 'c', '', 0);`
    );

    // 4. Transfer row with matching text (null payeeId, transfer_account_id = 1) -> should NOT update
    db.run(
      `INSERT INTO transactions (id, account_id, transfer_account_id, date, payee, memo, amount, status, created_at, is_income) VALUES (102, 1, 2, '2026-06-01', 'Landlord', '', -2000, 'c', '', 0);`
    );

    // 5. Transfer recurring row with matching text (null payeeId, transfer_account_id = 1) -> should NOT update
    db.run(
      `INSERT INTO recurring (account_id, transfer_account_id, payee, amount, frequency, next_date, active) VALUES (1, 2, 'Landlord', -2000, 'monthly', '2026-07-01', 1);`
    );

    // 6. Split child row WITH explicit payee_id -> SHOULD update
    db.run(
      `INSERT INTO transactions (id, account_id, parent_id, payee_id, date, payee, memo, amount, status, created_at, is_income) VALUES (103, 1, 100, ${p.id}, '2026-06-01', 'Landlord', '', -5000, 'c', '', 0);`
    );

    const updated = await updatePayee(db, p.id, { name: "Property Management Co" });
    expect(updated?.name).toBe("Property Management Co");

    const allTx = db.select().from(transactions).all();
    const regularTx = allTx.find((t) => t.id === 1)!;
    expect(regularTx.payee).toBe("Property Management Co");

    const splitParent = allTx.find((t) => t.id === 100)!;
    expect(splitParent.payee).toBe("Property Management Co");

    const unlinkedChild = allTx.find((t) => t.id === 101)!;
    expect(unlinkedChild.payee).toBe("Landlord"); // Kept unchanged

    const unlinkedTransfer = allTx.find((t) => t.id === 102)!;
    expect(unlinkedTransfer.payee).toBe("Landlord"); // Kept unchanged

    const linkedChild = allTx.find((t) => t.id === 103)!;
    expect(linkedChild.payee).toBe("Property Management Co"); // Updated because of explicit payeeId

    const allRec = db.select().from(recurring).all();
    const unlinkedRecTransfer = allRec[0]!;
    expect(unlinkedRecTransfer.payee).toBe("Landlord"); // Kept unchanged
  });

  it("BUG-05: updates payee inside an existing withTransaction block without throwing", async () => {
    const { withTransaction } = await import("../src/transaction.js");
    const p = findOrCreatePayee(db, "Coffee Shop", 10);

    const result = await withTransaction(db, async () => {
      return await updatePayee(db, p.id, { name: "Specialty Coffee" });
    });

    expect(result?.name).toBe("Specialty Coffee");
    const fetched = getPayeeById(db, p.id);
    expect(fetched?.name).toBe("Specialty Coffee");
  });

  it("deletes a payee", () => {
    const p = findOrCreatePayee(db, "Gas Station");
    expect(getPayees(db)).toHaveLength(1);

    const deleted = deletePayee(db, p.id);
    expect(deleted).toBe(true);
    expect(getPayees(db)).toHaveLength(0);
  });

  it("sets and clears the default category", async () => {
    const p = findOrCreatePayee(db, "Safeway");
    const updated = await updatePayee(db, p.id, { autoCategoryId: 10 });
    expect(updated?.autoCategoryId).toBe(10);

    const cleared = await updatePayee(db, p.id, { autoCategoryId: null });
    expect(cleared?.autoCategoryId).toBeNull();
  });

  it("rejects a default category that does not exist", async () => {
    const p = findOrCreatePayee(db, "Safeway");
    await expect(updatePayee(db, p.id, { autoCategoryId: 999 })).rejects.toBeInstanceOf(PayeeError);
  });

  it("rejects empty, transfer, and clashing renames", async () => {
    const p = findOrCreatePayee(db, "Safeway");
    findOrCreatePayee(db, "Whole Foods");

    await expect(updatePayee(db, p.id, { name: "   " })).rejects.toBeInstanceOf(PayeeError);
    await expect(updatePayee(db, p.id, { name: "Transfer : Savings" })).rejects.toBeInstanceOf(
      PayeeError
    );
    const clash = updatePayee(db, p.id, { name: "Whole Foods" });
    await expect(clash).rejects.toMatchObject({ status: 409 });
  });

  it("merges source payees into the target and repoints their rows", async () => {
    const target = findOrCreatePayee(db, "Starbucks", 10);
    const source = findOrCreatePayee(db, "Starbucks #123");

    db.run(
      `INSERT INTO transactions (account_id, category_id, date, payee, payee_id, memo, amount, status, created_at, is_income) VALUES (1, 10, '2026-06-01', 'Starbucks #123', ${source.id}, '', -600, 'c', '', 0);`
    );
    db.run(
      `INSERT INTO recurring (account_id, category_id, payee, payee_id, amount, frequency, next_date, active) VALUES (1, 10, 'Starbucks #123', ${source.id}, -600, 'monthly', '2026-07-01', 1);`
    );

    const merged = await mergePayees(db, target.id, [source.id]);
    expect(merged?.id).toBe(target.id);
    expect(getPayeeById(db, source.id)).toBeNull();

    const tx = db.select().from(transactions).all()[0]!;
    expect(tx.payee).toBe("Starbucks");
    expect(tx.payeeId).toBe(target.id);

    const rec = db.select().from(recurring).all()[0]!;
    expect(rec.payee).toBe("Starbucks");
    expect(rec.payeeId).toBe(target.id);
  });

  it("merge also adopts legacy text-only rows matching the source name", async () => {
    const target = findOrCreatePayee(db, "Amazon");
    const source = findOrCreatePayee(db, "AMZN");

    db.run(
      `INSERT INTO transactions (account_id, category_id, date, payee, memo, amount, status, created_at, is_income) VALUES (1, 10, '2026-06-01', 'AMZN', '', -2000, 'c', '', 0);`
    );

    await mergePayees(db, target.id, [source.id]);

    const tx = db.select().from(transactions).all()[0]!;
    expect(tx.payee).toBe("Amazon");
    expect(tx.payeeId).toBe(target.id);
    expect(getPayeeById(db, source.id)).toBeNull();
  });

  it("merge rejects empty sources, self-merge, and unknown payees", async () => {
    const target = findOrCreatePayee(db, "Amazon");

    await expect(mergePayees(db, target.id, [])).rejects.toBeInstanceOf(PayeeError);
    await expect(mergePayees(db, target.id, [target.id])).rejects.toBeInstanceOf(PayeeError);
    await expect(mergePayees(db, target.id, [4242])).rejects.toMatchObject({ status: 404 });
    expect(await mergePayees(db, 4242, [target.id])).toBeNull();
  });

  it("renaming a payee seeds an exact rename rule for future imports", async () => {
    const p = findOrCreatePayee(db, "BCF1");

    await updatePayee(db, p.id, { name: "BC Ferries" });

    const rules = getRenameRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      sourcePattern: "BCF1",
      targetPayee: "BC Ferries",
    });
  });

  it("a payee rename plus a merge generalises into a pattern rule", async () => {
    const p1 = findOrCreatePayee(db, "BCF1");
    const p2 = findOrCreatePayee(db, "BCF2");

    await updatePayee(db, p1.id, { name: "BC Ferries" });
    // A second entity cannot take the same name (409) — the user merges
    // instead, and the merge seeds the sibling rule that generalises.
    const target = getPayeeByName(db, "BC Ferries")!;
    await mergePayees(db, target.id, [p2.id]);

    const rules = getRenameRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      sourcePattern: "BCF[N]",
      targetPayee: "BC Ferries",
    });
  });

  it("changing only the default category seeds no rule", async () => {
    const p = findOrCreatePayee(db, "BCF1");

    await updatePayee(db, p.id, { autoCategoryId: 10 });

    expect(getRenameRules(db)).toHaveLength(0);
  });

  it("merging sources into a target seeds exact rename rules", async () => {
    const target = findOrCreatePayee(db, "Amazon");
    const s1 = findOrCreatePayee(db, "AMZN Mktp");
    const s2 = findOrCreatePayee(db, "AMZN Market");

    await mergePayees(db, target.id, [s1.id, s2.id]);

    const rules = getRenameRules(db);
    expect(rules.map((r) => r.sourcePattern).sort()).toEqual([
      "AMZN Market",
      "AMZN Mktp",
    ]);
    expect(rules.every((r) => r.targetPayee === "Amazon")).toBe(true);
  });

  it("merging a numbered family generalises into a pattern rule", async () => {
    const target = findOrCreatePayee(db, "BC Ferries");
    const s1 = findOrCreatePayee(db, "BCF1");
    const s2 = findOrCreatePayee(db, "BCF2");

    await mergePayees(db, target.id, [s1.id, s2.id]);

    const rules = getRenameRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      sourcePattern: "BCF[N]",
      targetPayee: "BC Ferries",
    });
  });
});
