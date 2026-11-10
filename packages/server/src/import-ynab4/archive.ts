import AdmZip from "adm-zip";
import { assertYnab4BudgetDataVersion, collectYnab4VersionWarnings } from "./versions.js";
import { parseYnab4SettingsXml, parseYnab4BudgetMetaData } from "./settings-xml.js";
import type { ExtractedYnab4Data } from "./types.js";

/**
 * Stage 1: Extract and parse YNAB4 data from a .y4backup or .zip archive buffer.
 *
 * Zip-bomb guards: the raw upload is capped before inflate, entry count and
 * per-entry uncompressed sizes are capped before readAsText, and the inflated
 * .ynab4 JSON text is capped before JSON.parse. All caps throw plain Errors
 * surfaced by routes as 400/413.
 */
export const MAX_YNAB4_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_YNAB4_JSON_CHARS = 100_000_000;
export const MAX_ENTRY_UNCOMPRESSED_BYTES = 100_000_000;
export const MAX_SETTINGS_XML_CHARS = 5_000_000;

export function extractYnab4DataFromZip(buffer: Buffer | ArrayBuffer): ExtractedYnab4Data {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length > MAX_YNAB4_UPLOAD_BYTES) {
    throw new Error("Backup archive exceeds the 50MB upload limit");
  }
  const zip = new AdmZip(buf);
  const zipEntries = zip.getEntries();
  if (zipEntries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`Backup archive has too many entries (${zipEntries.length}; limit ${MAX_ZIP_ENTRIES})`);
  }
  for (const entry of zipEntries) {
    const uncompressed = entry.header.size;
    if (typeof uncompressed === "number" && uncompressed > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error(`Backup archive entry "${entry.entryName}" exceeds the size limit`);
    }
  }

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
  if (ynab4JsonStr.length > MAX_YNAB4_JSON_CHARS) {
    throw new Error("Backup .ynab4 payload exceeds the size limit");
  }
  if (settingsXml && settingsXml.length > MAX_SETTINGS_XML_CHARS) {
    throw new Error("Backup settings payload exceeds the size limit");
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
