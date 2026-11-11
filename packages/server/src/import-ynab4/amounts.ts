import { arrayField, asRecord, recordField } from "./guards.js";

/**
 * Detect whether YNAB4 amounts are stored as milliunits (integer × 1000) or
 * decimal dollars (float). Stock YNAB4 backups encode amounts as milliunits
 * (e.g. -45000 for −$45.00), but exported or converted backups may use decimal
 * dollars (e.g. -45.00 or integer whole dollars like 45).
 *
 * Detection algorithm:
 * 1. If any non-zero amount has a fractional part (e.g., 45.25, 0.5) -> decimal dollars.
 * 2. Analyze all-integer amounts:
 *    - In decimal dollars, everyday purchases are small integers: 1 to 999 (e.g. $5, $15, $45, $120).
 *      In milliunits, these values would represent tiny fractions of a cent ($0.001 to $0.999).
 *    - If there are non-multiple-of-10 values < 1000 (e.g. 15, 25, 45, 12, 1, 2) or if more than
 *      5% of non-zero amounts are < 1000, it is decimal dollars.
 *    - If virtually all (>= 95%) non-zero amounts are >= 1000 (e.g. 1000, 3990, 12500, 45000, 500000),
 *      it is milliunits.
 */
export function detectMilliunitScale(ynabData: unknown): boolean {
  const amounts: number[] = [];

  const collect = (v: unknown) => {
    if (v == null) return;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n !== 0) amounts.push(n);
  };

  /** Tombstoned rows and non-row junk contribute no amounts. */
  const isLive = (row: unknown): boolean => {
    const r = asRecord(row);
    return r != null && !r.isTombstone;
  };

  for (const t of arrayField(ynabData, "transactions")) {
    if (!isLive(t)) continue;
    collect(recordField(t, "amount"));
    for (const st of arrayField(t, "subTransactions")) {
      if (!isLive(st)) continue;
      collect(recordField(st, "amount"));
    }
  }
  for (const mb of arrayField(ynabData, "monthlyBudgets")) {
    if (!isLive(mb)) continue;
    for (const msb of arrayField(mb, "monthlySubCategoryBudgets")) {
      if (!isLive(msb)) continue;
      collect(recordField(msb, "budgeted"));
    }
  }
  for (const st of arrayField(ynabData, "scheduledTransactions")) {
    if (!isLive(st)) continue;
    collect(recordField(st, "amount"));
    for (const sub of arrayField(st, "subTransactions")) {
      if (!isLive(sub)) continue;
      collect(recordField(sub, "amount"));
    }
  }
  for (const r of arrayField(ynabData, "reconciliations")) {
    if (!isLive(r)) continue;
    collect(recordField(r, "statementBalance"));
  }
  for (const acc of arrayField(ynabData, "accounts")) {
    if (!isLive(acc)) continue;
    collect(recordField(acc, "lastReconciledBalance"));
  }

  if (amounts.length === 0) return false;

  // 1. If any amount has a fractional part → decimal dollars
  for (const a of amounts) {
    if (a % 1 !== 0) return false;
  }

  // 2. All amounts are integers. Analyze distribution of magnitudes.
  let smallCount = 0;
  let smallNonMultipleOf10Count = 0;

  for (const a of amounts) {
    const abs = Math.abs(a);
    if (abs < 1000) {
      smallCount++;
      if (abs % 10 !== 0) {
        smallNonMultipleOf10Count++;
      }
    }
  }

  // If there are values like 1, 2, 5, 12, 15, 45 (< 1000 and not multiples of 10),
  // in milliunits those would be 0.1¢ to 4.5¢, which are everyday dollar amounts in decimal budgets.
  if (smallNonMultipleOf10Count > 0) {
    return false;
  }

  // If more than 30% of amounts are < 1000 (sub-dollar in milliunits), it's decimal dollars.
  if (smallCount / amounts.length > 0.3) {
    return false;
  }

  // If all or virtually all amounts are >= 1000, it's milliunits.
  return true;
}
