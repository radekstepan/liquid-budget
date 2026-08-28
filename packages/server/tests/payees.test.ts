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
} from "../src/queries/payees.js";

describe("Payees Entity & Management (UNI-38 / F-19)", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(":memory:");
    // Setup tables manually for isolated in-memory test
    db.run(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, kind TEXT, group_label TEXT, balance INTEGER, on_budget INTEGER, sort INTEGER, archived INTEGER);`);
    db.run(`CREATE TABLE category_groups (id INTEGER PRIMARY KEY, name TEXT, sort INTEGER, is_credit_card_payments INTEGER);`);
    db.run(`CREATE TABLE categories (id INTEGER PRIMARY KEY, group_id INTEGER, name TEXT, sort INTEGER, carryover INTEGER, goal_target INTEGER, linked_account_id INTEGER, overspend_carries_over INTEGER);`);
    db.run(`CREATE TABLE payees (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, auto_category_id INTEGER, created_at TEXT NOT NULL);`);
    db.run(`CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, category_id INTEGER, date TEXT NOT NULL, payee TEXT NOT NULL, payee_id INTEGER, memo TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, flag_color TEXT, created_at TEXT NOT NULL, parent_id INTEGER, transfer_account_id INTEGER, is_income INTEGER NOT NULL, income_month TEXT, reconciled_at TEXT, reconciliation_id INTEGER);`);
    db.run(`CREATE TABLE recurring (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, category_id INTEGER, payee TEXT NOT NULL, payee_id INTEGER, memo TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL, frequency TEXT NOT NULL, next_date TEXT NOT NULL, anchor_day INTEGER, active INTEGER NOT NULL, flag_color TEXT, transfer_account_id INTEGER);`);

    db.run(`INSERT INTO accounts (id, name, kind, group_label, balance, on_budget, sort, archived) VALUES (1, 'Checking', 'liquid', 'Budget', 100000, 1, 0, 0);`);
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

  it("updates payee name and propagates to transactions and recurring rules", () => {
    const p = findOrCreatePayee(db, "Whole Foods", 10);

    db.run(
      `INSERT INTO transactions (account_id, category_id, date, payee, payee_id, memo, amount, status, created_at, is_income) VALUES (1, 10, '2026-06-01', 'Whole Foods', ${p.id}, '', -5000, 'c', '', 0);`
    );
    db.run(
      `INSERT INTO recurring (account_id, category_id, payee, payee_id, amount, frequency, next_date, active) VALUES (1, 10, 'Whole Foods', ${p.id}, -5000, 'monthly', '2026-07-01', 1);`
    );

    const updated = updatePayee(db, p.id, { name: "Whole Foods Market" });
    expect(updated?.name).toBe("Whole Foods Market");

    const tx = db.select().from(transactions).all()[0]!;
    expect(tx.payee).toBe("Whole Foods Market");

    const rec = db.select().from(recurring).all()[0]!;
    expect(rec.payee).toBe("Whole Foods Market");
  });

  it("updates payee name and propagates to transactions and recurring with null payee_id by name", () => {
    const p = findOrCreatePayee(db, "Target Superstore", 10);

    db.run(
      `INSERT INTO transactions (account_id, category_id, date, payee, memo, amount, status, created_at, is_income) VALUES (1, 10, '2026-06-01', 'Target Superstore', '', -5000, 'c', '', 0);`
    );
    db.run(
      `INSERT INTO recurring (account_id, category_id, payee, amount, frequency, next_date, active) VALUES (1, 10, 'Target Superstore', -5000, 'monthly', '2026-07-01', 1);`
    );

    const updated = updatePayee(db, p.id, { name: "Target" });
    expect(updated?.name).toBe("Target");

    const tx = db.select().from(transactions).all()[0]!;
    expect(tx.payee).toBe("Target");

    const rec = db.select().from(recurring).all()[0]!;
    expect(rec.payee).toBe("Target");
  });

  it("BUG-22: does not cascade payee name to split children or transfer rows by raw text match", () => {
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

    const updated = updatePayee(db, p.id, { name: "Property Management Co" });
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

  it("deletes a payee", () => {
    const p = findOrCreatePayee(db, "Gas Station");
    expect(getPayees(db)).toHaveLength(1);

    const deleted = deletePayee(db, p.id);
    expect(deleted).toBe(true);
    expect(getPayees(db)).toHaveLength(0);
  });
});
