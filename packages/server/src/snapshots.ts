import { desc } from "drizzle-orm";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDbMutex, getDbPath, getDefaultDb, resetDefaultDb, type Db } from "./client.js";
import { transactions } from "./schema.js";

export class SnapshotError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "SnapshotError";
  }
}

export type SnapshotMeta = {
  /** Filename-safe id (the snapshot file stem). */
  id: string;
  /** User-visible label. Editable; prefilled from the last transaction. */
  name: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Size of the snapshot `.db` file in bytes. */
  sizeBytes: number;
};

/** Allowed snapshot ids — no dots, slashes, or whitespace, so ids can never escape the snapshots dir. */
export const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const MAX_SNAPSHOT_NAME_LENGTH = 120;

/** Cap on stored snapshots: each is a full-DB VACUUM INTO copy, so unbounded
 * creation fills disk. Enforced in createSnapshot with a 429 SnapshotError. */
export const MAX_SNAPSHOTS = 50;

/** Sliding-window throttle on snapshot creation: each call copies the whole
 * DB via VACUUM INTO, so rapid-fire creation stalls the single writer.
 * Enforced in createSnapshot with a 429 SnapshotError. */
export const MAX_SNAPSHOT_CREATES_PER_MINUTE = 10;

const snapshotCreateStamps: number[] = [];

/** Test helper: clear the in-memory creation throttle (module state is fresh
 * per test file under vitest isolation, but tests within one file share it). */
export function __resetSnapshotRateLimitForTests(): void {
  snapshotCreateStamps.length = 0;
}

function assertSnapshotRateLimit(): void {
  const now = Date.now();
  while (snapshotCreateStamps.length > 0 && now - snapshotCreateStamps[0]! > 60_000) {
    snapshotCreateStamps.shift();
  }
  if (snapshotCreateStamps.length >= MAX_SNAPSHOT_CREATES_PER_MINUTE) {
    throw new SnapshotError("Snapshot creation rate limit exceeded; try again shortly", 429);
  }
  snapshotCreateStamps.push(now);
}

function assertValidSnapshotId(id: string): void {
  if (typeof id !== "string" || !SNAPSHOT_ID_PATTERN.test(id)) {
    throw new SnapshotError("Invalid snapshot id", 400);
  }
}

/**
 * Directory holding snapshot files. Defaults to a `snapshots/` folder next to
 * the database file; overridable via `SNAPSHOTS_DIR` (used by tests).
 */
export function getSnapshotsDir(snapshotsDir?: string): string {
  if (snapshotsDir && snapshotsDir.trim() !== "") return path.resolve(snapshotsDir);
  const override = process.env.SNAPSHOTS_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  const dbPath = getDbPath();
  if (dbPath === ":memory:") return path.resolve("snapshots");
  return path.join(path.dirname(path.resolve(dbPath)), "snapshots");
}

function formatSignedCents(cents: number): string {
  const sign = cents < 0 ? "-" : "+";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * Build the default snapshot name from the most recently dated transaction:
 * `"<payee> <signed amount> (<date>)"`, e.g. `"Whole Foods -$84.20 (2026-09-06)"`.
 * Falls back to the memo, then "Untitled", then "Empty budget" when there are
 * no transactions at all. Purely a label — callers leave it editable.
 */
export async function suggestSnapshotName(db: Db): Promise<string> {
  const rows = await db
    .select({
      payee: transactions.payee,
      memo: transactions.memo,
      amount: transactions.amount,
      date: transactions.date,
    })
    .from(transactions)
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(1);
  const last = rows[0];
  if (!last) return "Empty budget";
  const label = (last.payee?.trim() || last.memo?.trim() || "Untitled").slice(0, 50);
  return `${label} ${formatSignedCents(last.amount)} (${last.date})`;
}

function makeSnapshotId(createdAt: string): string {
  const stamp = createdAt
    .slice(0, 19)
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${stamp}-${rand}`;
}

function readSidecar(dir: string, id: string): { name?: unknown; createdAt?: unknown } {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Save a snapshot of the live database as a standalone SQLite file plus a
 * small JSON sidecar carrying the user-visible name. The snapshot is a
 * consistent copy (`VACUUM INTO`); concurrent writers are serialized by the
 * connection mutex via a checkpoint, and `VACUUM INTO` itself reads a stable
 * view of the source.
 */
export async function createSnapshot(
  db: Db,
  opts?: { name?: string; snapshotsDir?: string }
): Promise<SnapshotMeta> {
  const dir = getSnapshotsDir(opts?.snapshotsDir);
  fs.mkdirSync(dir, { recursive: true });
  if (listSnapshots(dir).length >= MAX_SNAPSHOTS) {
    throw new SnapshotError(
      `Snapshot limit reached (${MAX_SNAPSHOTS}); delete old snapshots before creating new ones`,
      429
    );
  }
  assertSnapshotRateLimit();

  let name = (opts?.name ?? "").trim();
  if (!name) name = await suggestSnapshotName(db);
  name = name.slice(0, MAX_SNAPSHOT_NAME_LENGTH);
  if (!name) name = "Snapshot";

  const createdAt = new Date().toISOString();
  let id = makeSnapshotId(createdAt);
  while (fs.existsSync(path.join(dir, `${id}.db`))) {
    id = makeSnapshotId(createdAt);
  }
  const filePath = path.join(dir, `${id}.db`);

  try {
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Checkpoint is best-effort (e.g. no WAL frames pending); VACUUM INTO
    // still produces a consistent copy without it.
  }
  db.$client.exec(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ name, createdAt }, null, 2));
  return { id, name, createdAt, sizeBytes: fs.statSync(filePath).size };
}

/** List snapshots newest-first. Returns [] when the directory doesn't exist yet. */
export function listSnapshots(snapshotsDir?: string): SnapshotMeta[] {
  const dir = getSnapshotsDir(snapshotsDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  const out: SnapshotMeta[] = [];
  for (const file of entries) {
    if (!file.endsWith(".db")) continue;
    const id = file.slice(0, -".db".length);
    if (!SNAPSHOT_ID_PATTERN.test(id)) continue;
    const filePath = path.join(dir, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const sidecar = readSidecar(dir, id);
    const name =
      typeof sidecar.name === "string" && sidecar.name.trim() !== ""
        ? sidecar.name.slice(0, MAX_SNAPSHOT_NAME_LENGTH)
        : id;
    const createdAt =
      typeof sidecar.createdAt === "string" && !Number.isNaN(Date.parse(sidecar.createdAt))
        ? sidecar.createdAt
        : stat.mtime.toISOString();
    out.push({ id, name, createdAt, sizeBytes: stat.size });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return out;
}

/** Delete a snapshot file and its sidecar. Missing snapshots report 404. */
export function deleteSnapshot(id: string, snapshotsDir?: string): void {
  assertValidSnapshotId(id);
  const dir = getSnapshotsDir(snapshotsDir);
  const filePath = path.join(dir, `${id}.db`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new SnapshotError("Snapshot not found", 404);
  }
  if (!stat.isFile()) throw new SnapshotError("Snapshot not found", 404);
  fs.unlinkSync(filePath);
  try {
    fs.unlinkSync(path.join(dir, `${id}.json`));
  } catch {
    // Sidecar is optional; the snapshot itself is already gone.
  }
}

function getMigrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "migrations");
}

function readCurrentMigrationHashes(): { hashes: string[]; head: string } {
  const folder = getMigrationsFolder();
  const journal = JSON.parse(
    fs.readFileSync(path.join(folder, "meta/_journal.json"), "utf8")
  ) as { entries: Array<{ tag: string; idx: number }> };
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const hashes = entries.map((entry) => {
    const sqlText = fs.readFileSync(path.join(folder, `${entry.tag}.sql`), "utf8");
    return createHash("sha256").update(sqlText).digest("hex");
  });
  return { hashes, head: hashes[hashes.length - 1]! };
}

function readSnapshotMigrationHashes(snapshotPath: string, id: string): Set<string> {
  let raw: Database.Database;
  try {
    raw = new Database(snapshotPath, { readonly: true });
  } catch {
    throw new SnapshotError(`Cannot restore snapshot "${id}": snapshot file is not a readable database`, 422);
  }
  try {
    assertSnapshotIntegrityRaw(raw, id);
    let rows: Array<{ hash: string }>;
    try {
      rows = raw.prepare("SELECT hash FROM __drizzle_migrations").all() as Array<{ hash: string }>;
    } catch {
      throw new SnapshotError(
        `Cannot restore snapshot "${id}": snapshot was taken before the current migration history (missing migration journal)`,
        422
      );
    }
    return new Set(rows.map((r) => r.hash));
  } finally {
    try {
      raw.close();
    } catch {
      // Best-effort close of the read-only handle.
    }
  }
}

/**
 * Reject corrupt/truncated snapshot files even when the migration journal
 * table itself is intact. Runs on the already-open read-only handle so the
 * pre-flight needs a single open per restore.
 */
function assertSnapshotIntegrityRaw(raw: Database.Database, id: string): void {
  let rows: unknown;
  try {
    rows = raw.prepare("PRAGMA integrity_check").all();
  } catch {
    throw new SnapshotError(`Cannot restore snapshot "${id}": snapshot failed integrity check`, 422);
  }
  const values = (rows as Array<Record<string, unknown> | string>).map((r) =>
    typeof r === "string" ? r : String(Object.values(r)[0] ?? "")
  );
  const ok = values.length === 1 && values[0]!.toLowerCase() === "ok";
  if (!ok) {
    const detail = values.slice(0, 3).join("; ").slice(0, 300);
    throw new SnapshotError(
      `Cannot restore snapshot "${id}": snapshot failed integrity check${detail ? ` (${detail})` : ""}`,
      422
    );
  }
}

/**
 * Pre-flight version check for `restoreSnapshot`. Compares the snapshot
 * file's applied-migration hashes against the running app's journal
 * without touching the live database. Rejects snapshots that are behind
 * (missing the current head) or ahead (containing unknown migrations).
 */
function assertSnapshotMatchesCurrentMigrations(snapshotPath: string, id: string): void {
  const { hashes: currentHashes, head } = readCurrentMigrationHashes();
  const current = new Set(currentHashes);
  const snapshot = readSnapshotMigrationHashes(snapshotPath, id);
  if (!snapshot.has(head)) {
    throw new SnapshotError(
      `Cannot restore snapshot "${id}": snapshot was taken before the current migration head and cannot be restored safely`,
      422
    );
  }
  for (const hash of snapshot) {
    if (!current.has(hash)) {
      throw new SnapshotError(
        `Cannot restore snapshot "${id}": snapshot was taken with a newer app version and cannot be restored safely`,
        422
      );
    }
  }
}

/**
 * Replace the live database with a snapshot. Crash-safe: pre-flight
 * `integrity_check` + migration-lineage checks run BEFORE the live database
 * is touched; the live file is backed up to `<db>.pre-restore-<ts>.db`, the
 * snapshot is staged to a temp file and atomically renamed over the live
 * path, and the backup is deleted only after the restored database reopens
 * cleanly. On failure the backup is rolled back and the live database is
 * reopened. Serialized on the connection mutex so no write can interleave
 * the swap.
 */
export async function restoreSnapshot(
  id: string,
  opts?: { snapshotsDir?: string }
): Promise<SnapshotMeta> {
  assertValidSnapshotId(id);
  const dbPath = getDbPath();
  if (dbPath === ":memory:") {
    throw new SnapshotError("Cannot restore a snapshot into an in-memory database", 400);
  }
  const dir = getSnapshotsDir(opts?.snapshotsDir);
  const src = path.join(dir, `${id}.db`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(src);
  } catch {
    throw new SnapshotError("Snapshot not found", 404);
  }
  if (!stat.isFile()) throw new SnapshotError("Snapshot not found", 404);

  // Pre-flight migration-lineage check — before the live DB is touched.
  assertSnapshotMatchesCurrentMigrations(src, id);

  const meta =
    listSnapshots(dir).find((s) => s.id === id) ??
    ({ id, name: id, createdAt: stat.mtime.toISOString(), sizeBytes: stat.size } satisfies SnapshotMeta);

  const db = getDefaultDb();
  const release = await getDbMutex(db).acquire();
  let stagingPath: string | null = null;
  let backupPath: string | null = null;
  try {
    try {
      db.$client.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort; the connection is closed immediately below regardless.
    }
    resetDefaultDb();
    const resolved = path.resolve(dbPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.random().toString(36).slice(2, 8);
    stagingPath = `${resolved}.restore-tmp-${process.pid}-${rand}.db`;
    if (fs.existsSync(resolved)) {
      backupPath = `${resolved}.pre-restore-${stamp}.db`;
      fs.copyFileSync(resolved, backupPath);
    }
    // Stage + atomic rename: a crash between copy and rename leaves the live
    // DB untouched; rename on the same directory is atomic.
    fs.copyFileSync(src, stagingPath);
    fs.renameSync(stagingPath, resolved);
    stagingPath = null;
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        fs.unlinkSync(`${resolved}${suffix}`);
      } catch {
        // Stale sidecars may not exist; the copy is authoritative either way.
      }
    }
    // Reopen to verify the restored file is a usable, migrated database.
    // Throws (raw sqlite error) when the staged file is unusable — roll back below.
    getDefaultDb();
    // Success: backup is redundant; remove it so pre-restore files don't accumulate.
    if (backupPath) {
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // Best-effort cleanup; a leftover .pre-restore file is harmless.
      }
      backupPath = null;
    }
  } catch (e) {
    // Roll back to the pre-restore backup when the swap or reopen failed.
    try {
      if (backupPath && fs.existsSync(backupPath)) {
        const resolved = path.resolve(dbPath);
        const rollbackStage = `${resolved}.rollback-tmp-${process.pid}.db`;
        fs.copyFileSync(backupPath, rollbackStage);
        fs.renameSync(rollbackStage, resolved);
      }
    } catch {
      // Rollback is best-effort; surface the original failure below.
    }
    try {
      if (stagingPath && fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath);
    } catch {
      // Best-effort temp cleanup.
    }
    try {
      getDefaultDb();
    } catch {
      // Reopen is best-effort here; the original error carries the signal.
    }
    if (e instanceof SnapshotError) throw e;
    throw new SnapshotError(
      `Cannot restore snapshot "${id}": restored database failed to reopen (${e instanceof Error ? e.message : String(e ?? "")})`,
      422
    );
  } finally {
    release();
  }
  return meta;
}

/** Test helper: fresh temporary directory for snapshot files. */
export function makeTempSnapshotsDir(prefix = "ynab-snapshots-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
