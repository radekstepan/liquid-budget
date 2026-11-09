import type { TransactionDuplicateFlag, TransactionFlagColor, TransactionFlagState } from "@ynab/logic";
import { isValidISODate, isValidISOMonth, TRANSACTION_DUPLICATE_FLAG, TRANSACTION_FLAG_COLORS, TransactionError } from "@ynab/logic";

export function assertValidISODate(date: unknown, fieldName: string = "date"): string {
  if (!isValidISODate(date)) {
    throw new TransactionError(`Invalid calendar date for ${fieldName}: ${date}`, 400);
  }
  return date;
}

export function assertValidISOMonth(month: unknown, fieldName: string = "month"): string {
  if (!isValidISOMonth(month)) {
    throw new TransactionError(`Invalid month format for ${fieldName}: ${month}`, 400);
  }
  return month;
}

export function assertValidAmount(amount: unknown, options: { allowZero?: boolean } = {}): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    throw new TransactionError("Amount must be a valid number", 400);
  }
  if (!Number.isSafeInteger(Math.round(n)) || Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new TransactionError("Amount exceeds safe integer range", 400);
  }
  const rounded = Math.round(n);
  if (!options.allowZero && rounded === 0) {
    throw new TransactionError("Amount cannot be zero", 400);
  }
  return rounded;
}

/**
 * Coerce an arbitrary value into a valid user-facing flag color (or null).
 * Unknown values — including the internal "duplicate" marker — are treated
 * as "no flag" so rogue payloads never crash the register or trip the DB
 * CHECK. The duplicate marker is never writable through the transaction API.
 */
export function sanitizeFlagColor(value: unknown): TransactionFlagColor | null {
  if (typeof value !== "string") return null;
  return (TRANSACTION_FLAG_COLORS as readonly string[]).includes(value)
    ? (value as TransactionFlagColor)
    : null;
}

/**
 * Read-side coerce that additionally accepts the internal "duplicate"
 * marker the duplicate analyzer writes. Used when loading budget data so
 * the register can render the D badge without crashing on the value.
 */
export function sanitizeFlagState(value: unknown): TransactionFlagState {
  if (typeof value !== "string") return null;
  if (value === TRANSACTION_DUPLICATE_FLAG) return value as TransactionDuplicateFlag;
  return (TRANSACTION_FLAG_COLORS as readonly string[]).includes(value)
    ? (value as TransactionFlagColor)
    : null;
}

/**
 * Last category used with a payee name (YNAB4-style auto-fill).
 * Prefers the payee entity's default when set, else the most recent
 * categorized transaction with that exact name (excluding `excludeId`).
 * Returns null when the payee has no history.
 */
