/**
 * REPRO ONLY — OFX near-miss dedupe gap (not yet fixed; do not promote).
 *
 * Diverges: YNAB4 dedupes an imported OFX row when its FITID matches an
 * existing row with the SAME amount inside a ±4-day date window, regardless
 * of payee/memo text. Ours requires an exact fingerprint match (same date,
 * amount, normalized payee/memo), so bank-posting-date shifts and
 * payee renames slip through as new transactions.
 *
 * YNAB4: dataAccess/importing/ImportUtilities.as:326-336
 *   (`getTransactionByFITID` + `existingTransaction.amount == ...` +
 *   `areDatesWithinDays(4, ...)` → skip as duplicate).
 * Ours: packages/logic/src/duplicates.ts:128-152 (`duplicateFingerprint`
 *   embeds the exact date/payee/memo) + :390-440 (`identifyImportDuplicates`
 *   only tests that exact fingerprint).
 */
import { describe, expect, it } from "vitest";
import {
  buildExistingImportFingerprints,
  identifyImportDuplicates,
} from "../src/duplicates.js";

const ACCOUNT_ID = 1;

function incoming(overrides: Record<string, unknown> = {}) {
  return {
    rowNumber: 2,
    date: "2026-03-11",
    payee: "Starbucks",
    memo: "",
    amountCents: -500,
    fitId: "ABC123",
    ...overrides,
  };
}

function existingLedger(overrides: Record<string, unknown> = {}) {
  return [
    {
      accountId: ACCOUNT_ID,
      date: "2026-03-10",
      payee: "Starbucks",
      memo: "",
      amount: -500,
      fitId: "ABC123",
      ...overrides,
    },
  ];
}

describe("ynab4 parity: OFX FITID ±4-day near-miss dedupe", () => {
  it("same FITID + amount, import date +1 day: YNAB4 skips, ours misses", () => {
    const fps = buildExistingImportFingerprints(ACCOUNT_ID, existingLedger());
    const { duplicateRowNumbers } = identifyImportDuplicates(ACCOUNT_ID, fps, [incoming()]);
    // FAILS today: exact-date fingerprint misses the ±1-day near miss.
    expect(duplicateRowNumbers.has(2)).toBe(true);
  });

  it("same FITID + amount + date, renamed payee: YNAB4 skips (FITID path ignores payee), ours misses", () => {
    const fps = buildExistingImportFingerprints(ACCOUNT_ID, existingLedger());
    const { duplicateRowNumbers } = identifyImportDuplicates(ACCOUNT_ID, fps, [
      incoming({ date: "2026-03-10", payee: "STARBUCKS #42" }),
    ]);
    // FAILS today: fingerprint embeds normalized payee, YNAB4 FITID branch does not compare payee.
    expect(duplicateRowNumbers.has(2)).toBe(true);
  });

  it("same FITID + amount, import date +4 days (window edge): YNAB4 still matches, ours misses", () => {
    const fps = buildExistingImportFingerprints(ACCOUNT_ID, existingLedger());
    const { duplicateRowNumbers } = identifyImportDuplicates(ACCOUNT_ID, fps, [
      incoming({ date: "2026-03-14" }),
    ]);
    // FAILS today: areDatesWithinDays(4) is inclusive, exact-date fingerprint misses it.
    expect(duplicateRowNumbers.has(2)).toBe(true);
  });
});
