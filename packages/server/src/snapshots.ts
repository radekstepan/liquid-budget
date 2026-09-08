import { desc } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

/**
 * Replace the live database with a snapshot. Closes the shared connection,
 * copies the snapshot file over the database path, drops stale WAL sidecars,
 * and reopens (running migrations as a sanity check). Serialized on the
 * connection mutex so no write can interleave the swap.
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

  const meta =
    listSnapshots(dir).find((s) => s.id === id) ??
    ({ id, name: id, createdAt: stat.mtime.toISOString(), sizeBytes: stat.size } satisfies SnapshotMeta);

  const db = getDefaultDb();
  const release = await getDbMutex(db).acquire();
  try {
    try {
      db.$client.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort; the connection is closed immediately below regardless.
    }
    resetDefaultDb();
    const resolved = path.resolve(dbPath);
    fs.copyFileSync(src, resolved);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        fs.unlinkSync(`${resolved}${suffix}`);
      } catch {
        // Stale sidecars may not exist; the copy is authoritative either way.
      }
    }
    // Reopen to verify the restored file is a usable, migrated database.
    getDefaultDb();
  } finally {
    release();
  }
  return meta;
}

/** Test helper: fresh temporary directory for snapshot files. */
export function makeTempSnapshotsDir(prefix = "ynab-snapshots-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
