import AdmZip from "adm-zip";
import { getDefaultDb, importYnab4 } from "@ynab/server";
import path from "path";
import fs from "fs";

async function main() {
  const backupPath = path.resolve(process.cwd(), "../../backup.y4backup");
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found at ${backupPath}`);
  }

  const zip = new AdmZip(backupPath);
  let jsonStr = "";
  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith(".ynab4")) {
      jsonStr = zip.readAsText(entry);
      break;
    }
  }

  if (!jsonStr) {
    throw new Error("Could not find .ynab4 inside zip");
  }

  const ynabData = JSON.parse(jsonStr);
  const db = getDefaultDb();
  
  console.log("Starting import...");
  const summary = await importYnab4(db, ynabData);
  console.log("Import complete:", summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
