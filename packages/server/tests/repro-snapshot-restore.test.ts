/**
 * REPRO ONLY — snapshot restore has no pre-flight version check.
 *
 * Our side (`packages/server/src/snapshots.ts:197-244`):
 * - `restoreSnapshot` copies the snapshot file over the live database and
 *   THEN reopens it via `getDefaultDb()`, which silently migrates forward
 *   (`packages/server/src/client.ts:62-86`: `bootstrapMigrationJournal` +
 *   `migrate()` run on every open). There is no check that the snapshot's
 *   migration lineage matches the running app — no version recorded,
 *   compared, or reported.
 * - So restoring a snapshot taken before the current migration head
 *   succeeds silently (the copy is upgraded in place with no notice), and
 *   a snapshot the migrator cannot apply fails midway with a raw
 *   drizzle/sqlite error AFTER the live database has already been
 *   replaced — a cryptic crash on top of data loss. The safe contract is
 *   a clear `SnapshotError` BEFORE the live database is touched.
 *
 * Round-trip fidelity (snapshot -> mutate transactions, budgets,
 * rename rules, duplicate ignores, needsReview, goal targets -> restore
 * -> full logical dump equality) was verified GREEN — a snapshot is a
 * `VACUUM INTO` file copy covering every app table, so it is not pinned
 * here. Only the missing pre-migration guard is pinned below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";
import { getDefaultDb, resetDefaultDb } from "../src/client.js";
import { restoreSnapshot, SnapshotError } from "../src/snapshots.js";
import { createTransaction } from "../src/queries/transactions.js";
import * as schema from "../src/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

const APP_TABLES = [
  "accounts",
  "category_groups",
  "categories",
  "assignments",
  "settings",
  "payees",
  "transactions",
  "reconciliations",
  "recurring",
  "recurring_sub_transactions",
  "scheduled_postings",
  "rename_rules",
  "duplicate_ignores",
] as const;

function dumpAll(): Record<string, unknown[]> {
  const client = getDefaultDb().$client;
  const out: Record<string, unknown[]> = {};
  for (const table of APP_TABLES) {
    out[table] = client.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  }
  return out;
}

/**
 * Build a database file migrated to exactly one migration behind the
 * current head — i.e. a faithful "snapshot taken pre-migration". Applies
 * the migration SQL files in journal order and records their hashes the
 * same way drizzle does, so the result is what an older app version
 * would have snapshotted.
 */
function buildOneBehindHeadDb(filePath: string): void {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")
  ) as { entries: Array<{ tag: string; idx: number; when: number }> };
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  expect(entries.length).toBeGreaterThan(1);
  const raw = new Database(filePath);
  try {
    for (const entry of entries.slice(0, -1)) {
      const sqlText = fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8");
      raw.exec(sqlText);
      const hash = createHash("sha256").update(sqlText).digest("hex");
      raw.exec(
        "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);" +
          `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hash}', ${entry.when});`
      );
    }
  } finally {
    raw.close();
  }
}

describe("repro: snapshot restore of a pre-migration snapshot", () => {
  let tmpRoot: string;
  let snapsDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ynab-snap-repro-"));
    snapsDir = path.join(tmpRoot, "snaps");
    vi.stubEnv("DATABASE_URL", path.join(tmpRoot, "budget.db"));
    vi.stubEnv("SNAPSHOTS_DIR", snapsDir);
    resetDefaultDb();
  });

  afterEach(() => {
    resetDefaultDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function seedLiveDb(): Promise<void> {
    const db = getDefaultDb();
    const [account] = await db
      .insert(schema.accounts)
      .values({ name: "Checking", kind: "liquid", groupLabel: "Budget Accounts", balance: 0, onBudget: true, sort: 0 })
      .returning();
    await createTransaction(db, {
      accountId: account!.id,
      date: "2026-09-01",
      payee: "Live Data",
      amount: -100,
    });
  }

  function installOldSnapshot(id: string): void {
    fs.mkdirSync(snapsDir, { recursive: true });
    buildOneBehindHeadDb(path.join(snapsDir, `${id}.db`));
    fs.writeFileSync(
      path.join(snapsDir, `${id}.json`),
      JSON.stringify({ name: "old snapshot", createdAt: "2020-01-01T00:00:00.000Z" })
    );
  }

  it("rejects a snapshot taken before the current migration head with a clear error", async () => {
    await seedLiveDb();
    const id = "20200101-000000-oldver";
    installOldSnapshot(id);

    // FAILS today: restore succeeds silently (the old copy is migrated
    // forward in place with no notice) instead of rejecting.
    await expect(restoreSnapshot(id)).rejects.toThrowError(SnapshotError);
  });

  it("validates before replacing the live database", async () => {
    await seedLiveDb();
    const before = dumpAll();
    const id = "20200101-000001-oldver";
    installOldSnapshot(id);

    // FAILS today: no rejection (see above), and the live database has
    // already been replaced by the snapshot copy.
    await expect(restoreSnapshot(id)).rejects.toThrowError(SnapshotError);
    expect(dumpAll()).toEqual(before);
  });
});
