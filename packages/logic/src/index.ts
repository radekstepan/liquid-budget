export * from "./types.js";
export * from "./action-payloads.js";
export * from "./payload-builders.js";
export * from "./format.js";
export * from "./split.js";
export * from "./recurring.js";
export * from "./csv-import.js";
export * from "./reconcile.js";
export * from "./transfers.js";
// Full YNAB4 engine
export {
  computeBudget,
  buildBudgetIndex,
  invalidateBudgetIndex,
  isIncomeTransaction,
  getMonthsWithData,
  BUDGET_INDEX_VERSION,
} from "./budget-engine.js";
// Register (per-row running balance)
export { computeRunningBalances } from "./register.js";
export type { RegisterRow, RegisterInputRow } from "./register.js";
export { makeSeedBudgetData, DEMO_MONTH } from "./seed-fixture.js";
export * from "./reports.js";
export * from "./duplicates.js";
export * from "./rename-rules.js";

/**
 * YNAB4's six flag colours, in canonical display order.
 */
export const TRANSACTION_FLAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;

/**
 * Hex swatches for the six YNAB4 flag colours. Mirrors the palette YNAB4
 * uses for its register flag column so imported flags look native.
 */
export const TRANSACTION_FLAG_HEX: Record<(typeof TRANSACTION_FLAG_COLORS)[number], string> = {
  red: "#d65a3a",
  orange: "#e0903a",
  yellow: "#d6b73a",
  green: "#5aa84a",
  blue: "#3a7bd6",
  purple: "#7c5fb6",
};

export type TransactionFlagColor = (typeof TRANSACTION_FLAG_COLORS)[number];

/**
 * Internal flag the duplicate analyzer writes onto rows that match another
 * transaction. Not part of the YNAB4 palette: users cannot select it, but
 * can switch away from it (to a color or to none).
 */
export const TRANSACTION_DUPLICATE_FLAG = "duplicate";
export type TransactionDuplicateFlag = typeof TRANSACTION_DUPLICATE_FLAG;
