import AdmZip from "adm-zip";
import { getDefaultDb, importYnab4 } from "@ynab/server";
import path from "path";
import fs from "fs";

import { fileURLToPath } from "url";

async function main() {
  const candidatePaths = [
    path.resolve(process.cwd(), "backup.y4backup"),
    path.resolve(process.cwd(), "../../backup.y4backup"),
    path.resolve(process.cwd(), "../backup.y4backup"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../backup.y4backup"),
  ];
  const backupPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!backupPath) {
    throw new Error(`Backup file not found in any candidate path: ${candidatePaths.join(", ")}`);
  }

  const fileBuffer = fs.readFileSync(backupPath);
  const { ynabData } = extractYnab4DataFromZip(fileBuffer);
  const db = getDefaultDb();
  
  console.log("Starting import...");
  const summary = await importYnab4(db, ynabData);
  console.log("Import complete:", summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
