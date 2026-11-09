import type { Ynab4Settings, Ynab4BudgetMetaData } from "./types.js";

function unescapeXml(str: string | null | undefined): string {
  if (str == null) return "";
  return String(str)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function parseYnab4SettingsXml(xmlStr?: string): Ynab4Settings {
  const settings: Ynab4Settings = {};
  if (!xmlStr) return settings;

  const matchTag = (tag: string) => {
    const match = xmlStr.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i"));
    if (!match) return undefined;
    const raw = unescapeXml(match[1]);
    const trimmed = raw.trim();
    // G-02: a whitespace-only value is significant for separators
    // (e.g. cs_CZ uses a space group separator) — only trim when
    // something non-whitespace remains.
    return trimmed !== "" ? trimmed : raw;
  };

  settings.currencySymbol = matchTag("currencySymbol");
  settings.currencyISOSymbol = matchTag("currencyISOSymbol") || matchTag("currencyISO");
  settings.decimalSeparator = matchTag("decimalSeparator") || matchTag("currencyDecimalSeparator");
  settings.groupSeparator = matchTag("groupSeparator") || matchTag("currencyGroupSeparator");
  settings.dateFormat = matchTag("dateFormat") || matchTag("shortDateFormat");
  settings.budgetName = matchTag("budgetName") || matchTag("budgetTitle");

  return settings;
}

/**
 * Whitelist-parse the `.ynab4` JSON root's `budgetMetaData` (G-02).
 * Only known string fields survive; anything else (arrays, objects,
 * numbers) is dropped so a hostile backup can't smuggle junk into
 * the settings table.
 */
export function parseYnab4BudgetMetaData(raw: unknown): Ynab4BudgetMetaData {
  const meta: Ynab4BudgetMetaData = {};
  if (raw == null || typeof raw !== "object") return meta;
  const src = raw as Record<string, unknown>;
  for (const key of ["budgetType", "currencyISOSymbol", "currencyLocale", "dateLocale", "strictBudget"] as const) {
    const v = src[key];
    if (typeof v === "string" && v.trim() !== "") {
      meta[key] = v.trim();
    }
  }
  return meta;
}
