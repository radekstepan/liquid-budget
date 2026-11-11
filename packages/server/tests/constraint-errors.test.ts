import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { TransactionError } from "@ynab/logic";
import * as schema from "../src/schema.js";
import { ConstraintError, translateConstraintError } from "../src/errors.js";
import { withTransaction } from "../src/transaction.js";
import { createCategory, createCategoryGroup, updateCategory, updateCategoryGroup } from "../src/queries/categories.js";
import { createRenameRule } from "../src/queries/rename-rules.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

type TestDb = ReturnType<typeof openMigratedDb>;

function openMigratedDb() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

function sqliteError(code: string, message: string) {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("constraint translation at source (P1 layering)", () => {
  it("maps known SQLITE codes to ConstraintError with HTTP statuses", () => {
    const unique = translateConstraintError(
      sqliteError("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: payees.name")
    );
    expect(unique).toBeInstanceOf(ConstraintError);
    expect((unique as ConstraintError).status).toBe(409);
    expect((unique as ConstraintError).message).toBe("A record with these details already exists");

    const fk = translateConstraintError(
      sqliteError("SQLITE_CONSTRAINT_FOREIGNKEY", "FOREIGN KEY constraint failed")
    );
    expect(fk).toBeInstanceOf(ConstraintError);
    expect((fk as ConstraintError).status).toBe(400);

    const check = translateConstraintError(
      sqliteError("SQLITE_CONSTRAINT_CHECK", "CHECK constraint failed: transactions_transfer_not_self_check")
    );
    expect(check).toBeInstanceOf(ConstraintError);
    expect((check as ConstraintError).status).toBe(422);
  });

  it("also matches on message when the driver code is missing", () => {
    const err = translateConstraintError(new Error("UNIQUE constraint failed: category_groups.name"));
    expect(err).toBeInstanceOf(ConstraintError);
    expect((err as ConstraintError).status).toBe(409);
  });

  it("passes domain errors and unknown errors through untouched", () => {
    const domain = new TransactionError("nope", 422);
    expect(translateConstraintError(domain)).toBe(domain);
    const snap = Object.assign(new Error("boom"), { status: 429 });
    expect(translateConstraintError(snap)).toBe(snap);
    const other = new Error("something else");
    expect(translateConstraintError(other)).toBe(other);
  });

  it("withTransaction translates FK violations instead of leaking wire errors", async () => {
    const db = openMigratedDb();
    const err = await withTransaction(db, async () => {
      await db.insert(schema.transactions).values({
        accountId: 999999,
        date: "2026-01-01",
        payee: "ghost",
        amount: 100,
      });
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ConstraintError);
    expect((err as ConstraintError).status).toBe(400);
    expect(String((err as Error).message)).not.toContain("SQLITE");
  });

  it("withTransaction translates CHECK violations (self-transfer)", async () => {
    const db = openMigratedDb();
    const [account] = await db
      .insert(schema.accounts)
      .values({ name: "Checking", kind: "liquid", groupLabel: "Budget", balance: 0, onBudget: true, sort: 0 })
      .returning();
    const err = await withTransaction(db, async () => {
      await db.insert(schema.transactions).values({
        accountId: account!.id,
        date: "2026-01-01",
        payee: "self",
        amount: 100,
        transferAccountId: account!.id,
      });
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ConstraintError);
    expect((err as ConstraintError).status).toBe(422);
  });

  it("translation is idempotent across nested withTransaction", async () => {
    const db = openMigratedDb();
    const err = await withTransaction(db, async () => {
      await withTransaction(db, async () => {
        await db.insert(schema.transactions).values({
          accountId: 999999,
          date: "2026-01-01",
          payee: "ghost",
          amount: 100,
        });
      });
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ConstraintError);
    expect((err as ConstraintError).status).toBe(400);
  });

  it("non-transactional writes translate UNIQUE violations (category group)", async () => {
    const db = openMigratedDb();
    await createCategoryGroup(db, { name: "Living" });
    const other = await createCategoryGroup(db, { name: "Other" });
    const err = await updateCategoryGroup(db, other!.id, { name: "Living" }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ConstraintError);
    expect((err as ConstraintError).status).toBe(409);
  });

  it("non-transactional writes translate UNIQUE violations (category)", async () => {
    const db = openMigratedDb();
    const group = await createCategoryGroup(db, { name: "Living" });
    await createCategory(db, { groupId: group!.id, name: "Groceries" });
    const dining = await createCategory(db, { groupId: group!.id, name: "Dining" });
    const err = await updateCategory(db, dining!.id, { name: "Groceries" }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ConstraintError);
    expect((err as ConstraintError).status).toBe(409);
  });

  it("non-transactional writes translate UNIQUE violations (rename rule)", async () => {
    const db = openMigratedDb();
    await createRenameRule(db, { sourcePattern: "SPOTIFY*", targetPayee: "Spotify" });
    const err = await createRenameRule(db, { sourcePattern: "SPOTIFY*", targetPayee: "Spotify" }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ConstraintError);
    expect((err as ConstraintError).status).toBe(409);
    expect((err as ConstraintError).message).toContain("already exists");
  });
});
