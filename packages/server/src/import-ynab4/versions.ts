import { recordField } from "./guards.js";

/**
 * YNAB4 data-version policy (see docs/ynab4-import-gaps.md G-01).
 *
 * Stock YNAB4 rejects budgets older than 2.6 and treats 4.2.0 as current.
 * Backups without `fileMetaData.budgetDataVersion` predate the 4.0
 * migration (or are legacy-XML conversions) and cannot be trusted to
 * parse, so the zip boundary rejects them instead of misparsing.
 */

export const MIN_SUPPORTED_BUDGET_DATA_VERSION: [number, number, number] = [2, 6, 0];
export const CURRENT_BUDGET_DATA_VERSION = "4.2.0";
const CURRENT_BUDGET_DATA_VERSION_TUPLE: [number, number, number] = [4, 2, 0];

/**
 * Parse a `budgetDataVersion` value (string like "4.2.0"/"4.2" or a
 * plain number like 4.2) into a [major, minor, patch] tuple.
 * Returns null when the value is missing or unparseable.
 */
export function parseBudgetDataVersion(value: unknown): [number, number, number] | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return parseBudgetDataVersion(String(value));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(".");
  if (parts.length < 1 || parts.length > 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  while (nums.length < 3) nums.push(0);
  return [nums[0]!, nums[1]!, nums[2]!];
}

function compareVersionTuples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

function formatVersionTuple(t: [number, number, number]): string {
  return `${t[0]}.${t[1]}.${t[2]}`;
}

/**
 * Enforce the version gate: throw a descriptive error when
 * `fileMetaData.budgetDataVersion` is missing/unparseable or older
 * than 2.6. Returns the normalized version string on success.
 */
export function assertYnab4BudgetDataVersion(ynabData: unknown): string {
  const raw = recordField(recordField(ynabData, "fileMetaData"), "budgetDataVersion");
  const parsed = parseBudgetDataVersion(raw);
  if (parsed == null) {
    throw new Error(
      "Could not determine YNAB4 budgetDataVersion (missing fileMetaData.budgetDataVersion); " +
        "refusing to import a backup that may predate YNAB4 2.6"
    );
  }
  if (compareVersionTuples(parsed, MIN_SUPPORTED_BUDGET_DATA_VERSION) < 0) {
    throw new Error(
      `Unsupported YNAB4 budgetDataVersion "${String(raw).trim()}"; minimum supported version is 2.6`
    );
  }
  return formatVersionTuple(parsed);
}

/**
 * Collect non-fatal version warnings for data that passed the gate:
 * a single notice when the version is older than the current 4.2.0.
 */
export function collectYnab4VersionWarnings(ynabData: unknown): string[] {
  const raw = recordField(recordField(ynabData, "fileMetaData"), "budgetDataVersion");
  const parsed = parseBudgetDataVersion(raw);
  if (parsed == null) return [];
  if (compareVersionTuples(parsed, CURRENT_BUDGET_DATA_VERSION_TUPLE) < 0) {
    return [
      `YNAB4 budgetDataVersion "${String(raw).trim()}" is older than ${CURRENT_BUDGET_DATA_VERSION}; ` +
        "some newer fields may be missing after import",
    ];
  }
  return [];
}
