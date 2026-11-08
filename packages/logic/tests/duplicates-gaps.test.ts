/**
 * duplicates-gaps.test.ts
 *
 * Focused coverage for import-dedup branches: FITID near-miss misses,
 * rename-rule fingerprints on transfer legs, and the bare-Set tracker path.
 */
import { describe, expect, it } from "vitest";
import {
  buildExistingImportFingerprints,
  duplicateFingerprint,
  ExistingImportFingerprints,
  identifyImportDuplicates,
} from "../src/duplicates.js";
import type { RenameRule } from "../src/types.js";

const rule = (over: Partial<RenameRule> & { sourcePattern: string; targetPayee: string }): RenameRule => ({
  id: 1,
  operator: "is",
  ...over,
});

describe("ExistingImportFingerprints FITID near-miss", () => {
  it("returns false when no FITID entry matches", () => {
    const tracker = buildExistingImportFingerprints(1, [
      { accountId: 1, date: "2026-06-01", payee: "Store", amount: -1000, fitId: "FIT-1" },
    ]);
    expect(tracker).toBeInstanceOf(ExistingImportFingerprints);
    // Wrong id, wrong amount, and far date all miss.
    expect(tracker.matchFitIdAndConsume("FIT-9", -1000, "2026-06-01")).toBe(false);
    expect(tracker.matchFitIdAndConsume("FIT-1", -2000, "2026-06-01")).toBe(false);
    expect(tracker.matchFitIdAndConsume("FIT-1", -1000, "2026-07-01")).toBe(false);
    // The recorded entry still matches afterwards (misses consume nothing).
    expect(tracker.matchFitIdAndConsume("FIT-1", -1000, "2026-06-02")).toBe(true);
  });
});

describe("buildExistingImportFingerprints rename rules on transfers", () => {
  // Stored transfer: $50 outflow from Savings(2) into Checking(1). Importing
  // into Checking(1) sees the destination leg as a +5000 inflow.
  const stored = {
    accountId: 2,
    transferAccountId: 1,
    date: "2026-06-01",
    payee: "AMZN*MKTP",
    amount: -5000,
  };
  const names = new Map([[2, "Savings"]]);

  function incoming(payee: string) {
    return [{ rowNumber: 7, date: "2026-06-01", payee, memo: "", amountCents: 5000 }];
  }

  it("matches the renamed stored payee on a transfer destination leg", () => {
    const tracker = buildExistingImportFingerprints(1, [stored], names, [
      rule({ sourcePattern: "AMZN*MKTP", targetPayee: "Amazon" }),
    ]);
    const { duplicateRowNumbers } = identifyImportDuplicates(1, tracker, incoming("Amazon"));
    expect(duplicateRowNumbers.has(7)).toBe(true);
  });

  it("matches the renamed synthesized Transfer payee", () => {
    const tracker = buildExistingImportFingerprints(1, [stored], names, [
      rule({ sourcePattern: "Transfer : Savings", targetPayee: "Xfer" }),
    ]);
    const { duplicateRowNumbers } = identifyImportDuplicates(1, tracker, incoming("Xfer"));
    expect(duplicateRowNumbers.has(7)).toBe(true);
  });
});

describe("identifyImportDuplicates with a bare fingerprint set", () => {
  it("flags rows whose fingerprint is in the set", () => {
    const fp = duplicateFingerprint({
      accountId: 1,
      date: "2026-06-01",
      payee: "Store",
      memo: "",
      amount: -1000,
    });
    const { duplicateRowNumbers, duplicates } = identifyImportDuplicates(
      1,
      new Set([fp]),
      [
        { rowNumber: 1, date: "2026-06-01", payee: "Store", memo: "", amountCents: -1000 },
        { rowNumber: 2, date: "2026-06-01", payee: "Other", memo: "", amountCents: -1000 },
      ]
    );
    expect(duplicateRowNumbers.has(1)).toBe(true);
    expect(duplicateRowNumbers.has(2)).toBe(false);
    expect(duplicates.map((d) => d.rowNumber)).toEqual([1]);
  });
});
