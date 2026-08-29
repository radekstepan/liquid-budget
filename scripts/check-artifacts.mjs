#!/usr/bin/env node
/**
 * BUG-18.6 repository-hygiene guard: fails if any database, SQLite sidecar,
 * YNAB4 backup, import CSV or OS artifact is tracked in git. Intended for
 * CI / pre-commit use: `yarn check:artifacts`.
 */
import { execSync } from "node:child_process";

const BAD_PATH = /\.(db|db-wal|db-shm|sqlite|sqlite-wal|sqlite-shm|y4backup)$/i;
const BAD_NAME = /(^|\/)(\.DS_Store|import\.csv)$/i;

const files = execSync("git ls-files -z", { encoding: "buffer" })
  .toString()
  .split("\0")
  .filter(Boolean);

const bad = files.filter((f) => BAD_PATH.test(f) || BAD_NAME.test(f));

if (bad.length > 0) {
  console.error(
    "ERROR: database/backup artifacts are tracked in git:\n" +
      bad.map((f) => `  ${f}`).join("\n") +
      "\nUntrack them with: git rm --cached <file>"
  );
  process.exit(1);
}

console.log("OK: no database/backup artifacts are tracked in git.");
