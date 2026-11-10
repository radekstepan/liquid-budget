import AdmZip from "adm-zip";
import { assertYnab4BudgetDataVersion, collectYnab4VersionWarnings } from "./versions.js";
import { parseYnab4SettingsXml, parseYnab4BudgetMetaData } from "./settings-xml.js";
import type { ExtractedYnab4Data } from "./types.js";

/**
 * Stage 1: Extract and parse YNAB4 data from a .y4backup or .zip archive buffer.
 */
// TODO(P0) [import-caps]: cap entry count/size + ynab4 JSON size before AdmZip inflate/JSON.parse
// to prevent zip-bomb OOM; reject Content-Length > ~50MB at route layer first.
export function extractYnab4DataFromZip(buffer: Buffer | ArrayBuffer): ExtractedYnab4Data {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const zip = new AdmZip(buf);
  const zipEntries = zip.getEntries();

  let ynab4JsonStr = "";
  let settingsXml: string | undefined = undefined;

  for (const entry of zipEntries) {
    if (entry.entryName.endsWith(".ynab4")) {
      ynab4JsonStr = zip.readAsText(entry);
    } else if (entry.entryName.endsWith(".ybsettings")) {
      settingsXml = zip.readAsText(entry);
    }
  }

  if (!ynab4JsonStr) {
    throw new Error("Could not find .ynab4 data file inside the zip archive");
  }

  const ynabData = JSON.parse(ynab4JsonStr);
  // Version gate (G-01): reject backups that predate fileMetaData (4.0)
  // or the 2.6 floor before any import step can misparse them.
  assertYnab4BudgetDataVersion(ynabData);
  const warnings = [
    ...collectYnab4VersionWarnings(ynabData),
    ...collectYnab4PackageWarnings(zipEntries.map((e) => e.entryName)),
  ];
  const settings = settingsXml ? parseYnab4SettingsXml(settingsXml) : undefined;
  const budgetMetaData = parseYnab4BudgetMetaData(ynabData.budgetMetaData);
  return { ynabData, settingsXml, settings, budgetMetaData, warnings };
}

/**
 * Warn (never throw) when a backup archive carries multi-device sync
 * state alongside the main budget: stock YNAB4 packages hold a
 * `Budget.ymeta` pointer plus `devices/` diffs and `Snapshots/`, while
 * `.y4backup` exports zip the whole package. We import only the
 * `.ynab4` payload, so surface the skipped sync state explicitly.
 */
export function collectYnab4PackageWarnings(entryNames: string[]): string[] {
  const warnings: string[] = [];
  const normalized = entryNames.map((n) => n.replace(/\\/g, "/"));
  const hasDevices = normalized.some((n) => /(^|\/)devices(\/|$)/i.test(n));
  const hasSnapshots = normalized.some((n) => /(^|\/)snapshots(\/|$)/i.test(n));
  if (hasDevices) {
    warnings.push(
      'Backup archive contains multi-device sync state ("devices/" entries); only the main .ynab4 budget file was imported'
    );
  }
  if (hasSnapshots) {
    warnings.push(
      'Backup archive contains historic snapshots ("Snapshots/" entries); only the main .ynab4 budget file was imported'
    );
  }
  return warnings;
}
