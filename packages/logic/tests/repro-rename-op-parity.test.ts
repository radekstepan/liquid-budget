/**
 * REPRO ONLY — rename substring-operator punctuation parity (not yet fixed;
 * do not promote).
 *
 * Diverges: YNAB4 `StringCondition.evaluate` compares with
 * `toLocaleLowerCase` ONLY — separator punctuation (`*`, `-`, `.`, `/`)
 * is significant. Ours folds those separators to spaces in
 * `normalizeRenameText`, so operands match across punctuation where YNAB4
 * would not. Case-only drift agrees in both (drop: no test).
 *
 * YNAB4: data/StringCondition.as:87-119 (`evaluate`; Contains → :99-109,
 *   EndsWith → :110-111, StartsWith → :112-113, Is → :114-115) +
 *   com/ynab/utilities/StringUtilities.as:211 (`localeIndexOf`), :229
 *   (`localeEquals`), :303 (`localeEndsWith`), :396 (`localeStartsWith`).
 * Ours: packages/logic/src/rename-rules.ts:134-141 (`normalizeRenameText`
 *   folds separators) + :321-350 (`matchesRenameRule`).
 */
import { describe, expect, it } from "vitest";
import { matchesRenameRule } from "../src/rename-rules.js";
import type { RenameRule } from "../src/types.js";

function rule(sourcePattern: string, operator: RenameRule["operator"]): RenameRule {
  return { id: 1, sourcePattern, targetPayee: "Target", operator, createdAt: "2026-01-01" };
}

describe("ynab4 parity: rename operators keep punctuation significant", () => {
  it("Is: operand `AMZN MKTP` does NOT equal payee `AMZN*MKTP` in YNAB4", () => {
    // FAILS today: separator folding makes them equal here.
    expect(matchesRenameRule(rule("AMZN MKTP", "is"), "AMZN*MKTP")).toBe(false);
  });

  it("Contains: operand `AMZN MKTP` is NOT inside `AMZN*MKTP US` in YNAB4", () => {
    // FAILS today: folded payee contains the folded operand.
    expect(matchesRenameRule(rule("AMZN MKTP", "contains"), "AMZN*MKTP US")).toBe(false);
  });

  it("StartsWith: operand `AMZN-MKTP` does NOT prefix `AMZN MKTP STORE` in YNAB4", () => {
    // FAILS today: folded prefix comparison succeeds.
    expect(matchesRenameRule(rule("AMZN-MKTP", "startsWith"), "AMZN MKTP STORE")).toBe(false);
  });

  it("EndsWith: operand `KTP-STORE` does NOT suffix `AMZN MKTP STORE` in YNAB4", () => {
    // FAILS today: folded suffix comparison succeeds.
    expect(matchesRenameRule(rule("KTP-STORE", "endsWith"), "AMZN MKTP STORE")).toBe(false);
  });
});
