import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";
import {
  createAccount,
  getAccount,
  updateAccount,
} from "../src/queries/accounts.js";
import {
  bulkUpdateTransactions,
  createSplitWithChildren,
  createTransaction,
  updateTransaction,
} from "../src/queries/transactions.js";
import { createRecurring } from "../src/queries/recurring.js";
import { importCsvTransactions } from "../src/import-csv.js";

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

async function closeAccount(db: Db, id: number) {
  return updateAccount(db, id, { archived: true });
}

describe("account notes + close/reopen polish", () => {
  let db: Db;

  beforeEach(() => {
    db = openMigratedDb();
  });

  describe("notes", () => {
    it("defaults to empty string and round-trips through create/update", async () => {
      const created = await createAccount(db, { name: "Checking", kind: "liquid" });
      expect(created.notes).toBe("");

      await updateAccount(db, created.id, { notes: "Why this account exists" });
      expect((await getAccount(db, created.id))?.notes).toBe("Why this account exists");

      await updateAccount(db, created.id, { name: "Renamed" });
      expect((await getAccount(db, created.id))?.notes).toBe("Why this account exists");

      await updateAccount(db, created.id, { notes: "" });
      expect((await getAccount(db, created.id))?.notes).toBe("");
    });

    it("persists notes passed at creation", async () => {
      const created = await createAccount(db, {
        name: "Savings",
        kind: "liquid",
        notes: "Emergency fund",
      });
      expect((await getAccount(db, created.id))?.notes).toBe("Emergency fund");
    });
  });

  describe("closed-account guards", () => {
    it("blocks new transactions and transfers involving a closed account", async () => {
      const open = await createAccount(db, { name: "Open", kind: "liquid" });
      const closed = await createAccount(db, { name: "Closed", kind: "liquid" });
      await closeAccount(db, closed.id);

      await expect(
        createTransaction(db, {
          accountId: closed.id,
          date: "2026-06-01",
          payee: "Store",
          amount: -1000,
        })
      ).rejects.toThrow(/closed/i);

      await expect(
        createTransaction(db, {
          accountId: open.id,
          date: "2026-06-01",
          payee: "Transfer",
          amount: -1000,
          transferAccountId: closed.id,
        })
      ).rejects.toThrow(/closed/i);

      await expect(
        createTransaction(db, {
          accountId: closed.id,
          date: "2026-06-01",
          payee: "Transfer",
          amount: -1000,
          transferAccountId: open.id,
        })
      ).rejects.toThrow(/closed/i);
    });

    it("blocks split children targeting a closed account", async () => {
      const open = await createAccount(db, { name: "Open", kind: "liquid" });
      const closed = await createAccount(db, { name: "Closed", kind: "liquid" });
      await closeAccount(db, closed.id);
      const [group] = await db
        .insert(schema.categoryGroups)
        .values({ name: "General", sort: 0 })
        .returning();
      const [cat] = await db
        .insert(schema.categories)
        .values({ groupId: group.id, name: "Groceries", sort: 0 })
        .returning();

      await expect(
        createSplitWithChildren(
          db,
          { accountId: open.id, date: "2026-06-01", payee: "Store", memo: "", amount: -2000 },
          [
            { categoryId: cat.id, amount: -1000, memo: "a" },
            { categoryId: null, amount: -1000, memo: "b", transferAccountId: closed.id },
          ]
        )
      ).rejects.toThrow(/closed/i);
    });

    it("blocks new recurring schedules on a closed account", async () => {
      const closed = await createAccount(db, { name: "Closed", kind: "liquid" });
      await closeAccount(db, closed.id);

      await expect(
        createRecurring(db, {
          accountId: closed.id,
          categoryId: null,
          payee: "Rent",
          amount: -100000,
          frequency: "monthly",
          nextDate: "2026-07-01",
        })
      ).rejects.toThrow(/closed/i);
    });

    it("blocks moving a row onto a closed account but allows in-place edits", async () => {
      const open = await createAccount(db, { name: "Open", kind: "liquid" });
      const closed = await createAccount(db, { name: "Closed", kind: "liquid" });
      const row = await createTransaction(db, {
        accountId: open.id,
        date: "2026-06-01",
        payee: "Store",
        amount: -1000,
      });
      await closeAccount(db, closed.id);

      await expect(updateTransaction(db, row.id, { accountId: closed.id })).rejects.toThrow(
        /closed/i
      );

      const closedRow = await createTransaction(db, {
        accountId: open.id,
        date: "2026-06-02",
        payee: "Other",
        amount: -500,
      });
      // Sanity: in-place memo edit on an open account works; moving is what is blocked.
      await updateTransaction(db, closedRow.id, { memo: "fixed" });
      await expect(
        bulkUpdateTransactions(db, [closedRow.id], { accountId: closed.id })
      ).rejects.toThrow(/closed/i);
    });

    it("rejects CSV imports targeting a closed account", async () => {
      const closed = await createAccount(db, { name: "Closed", kind: "liquid" });
      await closeAccount(db, closed.id);

      await expect(
        importCsvTransactions(db, {
          accountId: closed.id,
          rows: [
            {
              rowNumber: 2,
              date: "2026-06-01",
              payee: "Store",
              memo: "",
              category: "",
              amountCents: -1000,
              error: null,
            },
          ],
        })
      ).rejects.toThrow(/closed/i);
    });
  });
});
