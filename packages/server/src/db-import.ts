#!/usr/bin/env node
/**
 * db-import.ts
 *
 * CLI script: import backup.y4backup into the database.
 * Run via:  yarn workspace @ynab/server db:import
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDefaultDb, importYnab4, extractYnab4DataFromZip } from "./index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const candidatePaths = [
    path.resolve(process.cwd(), "backup.y4backup"),
    path.resolve(__dirname, "../../..", "backup.y4backup"),
    path.resolve(__dirname, "../..", "backup.y4backup"),
    path.resolve(__dirname, "..", "backup.y4backup"),
  ];
  const backupPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!backupPath) {
    throw new Error(`Backup file not found in any candidate path: ${candidatePaths.join(", ")}`);
  }

  // Note: CLI entry point — output goes through process.stdout/stderr
  // directly. `console.*` is banned in code under test (every Vitest config
  // throws on it via onConsoleLog), so these scripts never use it.
  process.stdout.write(`Reading backup file from ${backupPath}...\n`);
  const fileBuffer = fs.readFileSync(backupPath);
  const { ynabData, settingsXml, warnings, budgetMetaData } = extractYnab4DataFromZip(fileBuffer);
  const db = getDefaultDb();

  process.stdout.write("Starting YNAB4 import...\n");
  const summary = await importYnab4(db, ynabData, settingsXml, { warnings, budgetMetaData });
  process.stdout.write(`Import complete: ${JSON.stringify(summary)}\n`);
}

main().catch((err) => {
  process.stderr.write(`Import failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
