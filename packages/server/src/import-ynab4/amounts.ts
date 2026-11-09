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
export function detectMilliunitScale(ynabData: any): boolean {
  const amounts: number[] = [];

  const collect = (v: unknown) => {
    if (v == null) return;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n !== 0) amounts.push(n);
  };

  for (const t of ynabData.transactions || []) {
    if (t.isTombstone) continue;
    collect(t.amount);
    for (const st of t.subTransactions || []) {
      if (st.isTombstone) continue;
      collect(st.amount);
    }
  }
  for (const mb of ynabData.monthlyBudgets || []) {
    if (mb.isTombstone) continue;
    for (const msb of mb.monthlySubCategoryBudgets || []) {
      if (msb.isTombstone) continue;
      collect(msb.budgeted);
    }
  }
  for (const st of ynabData.scheduledTransactions || []) {
    if (st.isTombstone) continue;
    collect(st.amount);
    for (const sub of st.subTransactions || []) {
      if (sub.isTombstone) continue;
      collect(sub.amount);
    }
  }
  for (const r of ynabData.reconciliations || []) {
    if (r.isTombstone) continue;
    collect(r.statementBalance);
  }
  for (const acc of ynabData.accounts || []) {
    if (acc.isTombstone) continue;
    collect(acc.lastReconciledBalance);
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
