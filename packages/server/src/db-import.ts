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

  console.log(`Reading backup file from ${backupPath}...`);
  const fileBuffer = fs.readFileSync(backupPath);
  const { ynabData } = extractYnab4DataFromZip(fileBuffer);
  const db = getDefaultDb();

  console.log("Starting YNAB4 import...");
  const summary = await importYnab4(db, ynabData);
  console.log("Import complete:", summary);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
