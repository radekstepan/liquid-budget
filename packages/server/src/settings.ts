import { settings } from "./schema.js";
import type { Db } from "./client.js";

/**
 * Budget-level settings keys (G-02). The `.ybsettings` half comes from
 * `parseYnab4SettingsXml`; the `budgetMetaData` half from the `.ynab4`
 * JSON root (`BudgetMetaDataVO`: budgetType, currencyISOSymbol,
 * currencyLocale, dateLocale, strictBudget).
 */
export const BUDGET_SETTING_KEYS = [
  "currencySymbol",
  "currencyISOSymbol",
  "decimalSeparator",
  "groupSeparator",
  "dateFormat",
  "budgetName",
  "budgetType",
  "currencyLocale",
  "dateLocale",
  "strictBudget",
] as const;

export type BudgetSettingKey = (typeof BUDGET_SETTING_KEYS)[number];

const KEY_SET = new Set<string>(BUDGET_SETTING_KEYS);

/** Read every stored budget setting as a plain key → value map. */
export async function getAllSettings(db: Db): Promise<Record<string, string>> {
  const rows = await db.select().from(settings);
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.key] = row.value;
  }
  return out;
}

/** Read one stored budget setting; undefined when never imported. */
export async function getSetting(db: Db, key: BudgetSettingKey): Promise<string | undefined> {
  const rows = await db.select().from(settings);
  return rows.find((r) => r.key === key)?.value;
}

/**
 * Persist budget settings. Only known keys with defined values are
 * written (unknown keys are ignored, undefined values are skipped so
 * a partial document never blanks a stored value via this path —
 * callers wipe the table first on full re-import).
 */
export async function setSettings(
  db: Db,
  values: Partial<Record<BudgetSettingKey, string | undefined>>
): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    if (!KEY_SET.has(key)) continue;
    if (value === undefined) continue;
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }
}
