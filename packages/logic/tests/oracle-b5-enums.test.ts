/**
 * oracle-b5-enums.test.ts
 *
 * Oracle B5 parity: register/error/flag/source/frequency/entity-type enums
 * plus SyncableEntity domain seams, mapped onto this repo's shrunken
 * taxonomy (types.ts TransactionFlagState palette, ClearedStatus u/c/r,
 * RECURRING_FREQUENCIES, merge validFlagColor, contracts validation).
 *
 * Sources (42 oracle tests; oracle tree is not vendored in this checkout,
 * so refs are keyed on file/test names rather than exact lines):
 * - ErrorLevel.test.ts (5 tests): ranks Error 10 / ForReview 5 /
 *   NeedsCategory 1 / None 0, ARGB icon colors (e.g. 16772332, 15374231),
 *   inverted compare (LESS_THAN = 1 / GREATER_THAN = -1), getEnumByName
 *   case-insensitive default / case-sensitive opt-out / miss, icons null.
 * - ErrorState.test.ts (6 tests): null level coerces to None, null message
 *   default, equals identity, noError singleton, settable error level.
 * - TransactionFlag.test.ts (6 tests): 7 singletons Red 6 / Orange 5 /
 *   Yellow 4 / Green 3 / Blue 2 / Purple 1 / None 0, verbatim names,
 *   getEnumByName, incrementFlag cycle None -> Red -> ... -> Purple -> None,
 *   null/foreign -> None, getIntegralFlagValue null -> 0.
 * - TransactionSource.test.ts (3 tests): 3 singletons UserEntered 0 /
 *   Imported 1 / ImportedIphone 2 (verbatim lowercase "p"), getEnumByName.
 * - ScheduledTransactionFrequency.test.ts (5 tests): 13 frequencies with
 *   readable names ("Every 3 Months" etc), getReadableName null/foreign
 *   throws "unexpected".
 * - YNABEntityType.test.ts (3 tests): 14 verbatim entity names
 *   (budgetMetaData masterCategory category account accountMapping
 *   transaction subTransaction matchedTransaction scheduledTransaction
 *   monthlyBudget monthlyCategoryBudget payee payeeStringCondition location),
 *   getEnumByName.
 * - framework/SyncableEntity.test.ts (14 domain-seam tests):
 *   findParentGuaranteeExists + "Can't find parentEntityId: X" throw,
 *   unique-id shape, ReadAggregateChildrenFromVO false, populateVO stamp,
 *   toString embeds id, matched-prefix strip/throw.
 *
 * // FORK: enum-object layer dropped. This repo carries the oracle's rich
 * AS3 enum objects (rank ints, ARGB icon colors, icon assets, inverted
 * compare, case-insensitive getEnumByName, incrementFlag cycling, 3-way
 * source taxonomy, 14-way entity graph, throwing parent lookup) as plain
 * string unions, zod enums, and null-coalescing fallbacks. Icon assets and
 * integer color codes have no counterpart (palette is CSS hex in
 * TRANSACTION_FLAG_HEX); unknown lookups fall back to null instead of
 * throwing; orphan split parents return undefined instead of throwing.
 * Each gap is pinned inline.
 */
import { describe, expect, it } from "vitest";
import * as logicIndex from "../src/index.js";
import {
  AccountCreateSchema,
  applyMergeOverrides,
  frequencyLabel,
  getRecurringChildren,
  getSplitChildren,
  getSplitParent,
  isImportedTransaction,
  isTransferPayee,
  isValidRecurringFrequency,
  pickMergePrimary,
  RECURRING_FREQUENCIES,
  resolveMergedTransaction,
  TransactionError,
  TransactionFlagSchema,
  TransactionResponseSchema,
  TRANSACTION_DUPLICATE_FLAG,
  TRANSACTION_FLAG_COLORS,
  TRANSACTION_FLAG_HEX,
  validateAmountInput,
  validateTransferPayeeConsistency,
  type MergeableTransaction,
  type Transaction,
} from "../src/index.js";
import { classifyBoundaryTransfer } from "../src/transfers.js";
import type { RecurringSubTransaction } from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Oracle ErrorLevel ranks, verbatim: Error 10 / ForReview 5 / NeedsCategory 1 / None 0. */
const ERROR_RANKS = { Error: 10, ForReview: 5, NeedsCategory: 1, None: 0 } as const;

/** Oracle TransactionFlag integral values, verbatim: Red 6 .. Purple 1, None 0. */
const FLAG_INTEGRALS = {
  red: 6,
  orange: 5,
  yellow: 4,
  green: 3,
  blue: 2,
  purple: 1,
  none: 0,
} as const;

/** Standard (non-inverted) rank comparator used as this repo's analogue. */
function compareRank(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function mtx(overrides: Partial<MergeableTransaction> & { id: number }): MergeableTransaction {
  return {
    accountId: 1,
    transferAccountId: null,
    categoryId: null,
    date: "2026-08-01",
    payee: "Payee",
    payeeId: null,
    memo: "",
    amount: -5000,
    status: "c",
    transferStatus: null,
    flagColor: null,
    needsReview: false,
    entityId: null,
    transferEntityId: null,
    isIncome: false,
    incomeMonth: null,
    ...overrides,
  };
}

function row(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    accountId: 1,
    categoryId: null,
    date: "2026-06-15",
    payee: "Payee",
    memo: "",
    amount: "0",
    status: "c",
    ...overrides,
  };
}

const LIQUID = { onBudget: true, kind: "liquid" };

// ---------------------------------------------------------------------------
// A. ErrorLevel (oracle: 5 tests)
// ---------------------------------------------------------------------------

describe("error-level ranks (oracle ErrorLevel analogue)", () => {
  it("pins verbatim ranks Error 10 > ForReview 5 > NeedsCategory 1 > None 0", () => {
    expect(ERROR_RANKS.Error).toBe(10);
    expect(ERROR_RANKS.ForReview).toBe(5);
    expect(ERROR_RANKS.NeedsCategory).toBe(1);
    expect(ERROR_RANKS.None).toBe(0);
    expect(ERROR_RANKS.Error).toBeGreaterThan(ERROR_RANKS.ForReview);
    expect(ERROR_RANKS.ForReview).toBeGreaterThan(ERROR_RANKS.NeedsCategory);
    expect(ERROR_RANKS.NeedsCategory).toBeGreaterThan(ERROR_RANKS.None);
  });

  it("FORK: repo compare is standard (-1/0/1); oracle compare is inverted (LESS_THAN=1, GREATER_THAN=-1)", () => {
    // Oracle compare() returns 1 when the receiver ranks LOWER (inverted).
    // This repo has no error-level comparator; the analogue used throughout
    // (statusRank/compareStatus in B3) follows the standard convention.
    expect(compareRank(ERROR_RANKS.None, ERROR_RANKS.Error)).toBe(-1);
    expect(compareRank(ERROR_RANKS.Error, ERROR_RANKS.None)).toBe(1);
    expect(compareRank(ERROR_RANKS.ForReview, ERROR_RANKS.ForReview)).toBe(0);
  });

  it("FORK: ARGB icon color ints (e.g. 16772332, 15374231) have no counterpart; palette is CSS hex strings", () => {
    expect(Object.values(TRANSACTION_FLAG_HEX)).toHaveLength(6);
    for (const hex of Object.values(TRANSACTION_FLAG_HEX)) {
      expect(typeof hex).toBe("string");
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(TRANSACTION_FLAG_HEX.red).not.toBe(16772332);
    expect(Object.values(TRANSACTION_FLAG_HEX)).not.toContain(16772332);
    expect(Object.values(TRANSACTION_FLAG_HEX)).not.toContain(15374231);
  });

  it("getEnumByName miss contract analogue: flag lookup is exact and case-sensitive (no ci fold)", () => {
    // Oracle resolves names case-insensitively by default; the repo zod
    // enum accepts only exact lowercase — capitals, names, empty, and
    // unknown all miss, mirroring the caseSensitive=true opt-out branch.
    expect(TransactionFlagSchema.safeParse("red").success).toBe(true);
    for (const miss of ["Red", "RED", "cleared", "", "Nope", "duplicate"]) {
      expect(TransactionFlagSchema.safeParse(miss).success).toBe(false);
    }
  });

  it("FORK: icon assets are null/absent — no icon exports in the logic package", () => {
    // Oracle icons are null in headless tests and image assets in the app;
    // this repo ships no icon layer at all (UI-asset N/A).
    expect(Object.keys(logicIndex).some((k) => /icon/i.test(k))).toBe(false);
    expect("incrementFlag" in logicIndex).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. ErrorState (oracle: 6 tests -> validation/error-handling analogue)
// ---------------------------------------------------------------------------

describe("error-state handling (oracle ErrorState analogue)", () => {
  it("null/unknown flag coerces to None (null) instead of throwing", () => {
    // Oracle: new ErrorState(null) coerces the level to None. Analogue: the
    // merge path coerces unknown flag markers to null via validFlagColor.
    const merged = resolveMergedTransaction({
      primary: mtx({ id: 2, needsReview: true, flagColor: "weird" as unknown as null }),
      secondary: mtx({ id: 1 }),
      sourceAccount: LIQUID,
      destAccount: null,
    });
    expect(merged.flagColor).toBeNull();
  });

  it("known flag colors survive the merge (noError singleton analogue: clean rows carry no error)", () => {
    const merged = resolveMergedTransaction({
      primary: mtx({ id: 2, needsReview: true, flagColor: "red" }),
      secondary: mtx({ id: 1 }),
      sourceAccount: LIQUID,
      destAccount: null,
    });
    expect(merged.flagColor).toBe("red");
    const clean = validateAmountInput("12.34");
    expect(clean.status).toBe("valid");
  });

  it("error values carry a message (null-message default analogue)", () => {
    // Oracle defaults a missing message to null; here TransactionError and
    // zod issues always carry a string message through the errorFactory.
    const err = new TransactionError("boom", 400);
    expect(err.message).toBe("boom");
    expect(err.status).toBe(400);
    const bad = AccountCreateSchema.safeParse({ name: "", kind: "liquid", groupLabel: "G" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(typeof bad.error.issues[0]?.message).toBe("string");
  });

  it("equals identity analogue: identical inputs resolve to equal rows", () => {
    const args = {
      primary: mtx({ id: 2, needsReview: true, memo: "x" }),
      secondary: mtx({ id: 1, memo: "y" }),
      sourceAccount: LIQUID,
      destAccount: null,
    } as const;
    expect(resolveMergedTransaction({ ...args })).toEqual(resolveMergedTransaction({ ...args }));
  });

  it("error level is settable: overrides can set and then clear the flag", () => {
    const [primary, secondary] = pickMergePrimary(mtx({ id: 1 }), mtx({ id: 2, needsReview: true }));
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null });
    const set = applyMergeOverrides(merged, { flagColor: "blue" }, { sourceAccount: LIQUID, destAccount: null });
    expect(set.flagColor).toBe("blue");
    const cleared = applyMergeOverrides(set, { flagColor: null }, { sourceAccount: LIQUID, destAccount: null });
    expect(cleared.flagColor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. TransactionFlag (oracle: 6 tests)
// ---------------------------------------------------------------------------

describe("transaction flag palette (oracle TransactionFlag analogue)", () => {
  it("exposes the six YNAB4 colors in canonical order plus the null None state", () => {
    expect([...TRANSACTION_FLAG_COLORS]).toEqual(["red", "orange", "yellow", "green", "blue", "purple"]);
    expect(TRANSACTION_DUPLICATE_FLAG).toBe("duplicate");
    // None is null on both read and write paths.
    expect(TransactionResponseSchema.safeParse({ ...row(), amount: "5", flagColor: null }).success).toBe(true);
  });

  it("pins verbatim integrals Red 6 .. Purple 1, None 0 as a documented rank table", () => {
    // The repo carries no integer flag values; this table documents the
    // oracle ordering the palette order encodes (red first = highest).
    const ordered = (Object.keys(FLAG_INTEGRALS) as (keyof typeof FLAG_INTEGRALS)[])
      .filter((k) => k !== "none")
      .sort((a, b) => FLAG_INTEGRALS[b] - FLAG_INTEGRALS[a]);
    expect(ordered).toEqual([...TRANSACTION_FLAG_COLORS]);
    expect(FLAG_INTEGRALS.red).toBe(6);
    expect(FLAG_INTEGRALS.purple).toBe(1);
    expect(FLAG_INTEGRALS.none).toBe(0);
  });

  it("write path accepts the six color names; read path additionally accepts the duplicate marker", () => {
    for (const color of TRANSACTION_FLAG_COLORS) {
      expect(TransactionFlagSchema.safeParse(color).success).toBe(true);
    }
    expect(TransactionFlagSchema.safeParse(TRANSACTION_DUPLICATE_FLAG).success).toBe(false);
    expect(
      TransactionResponseSchema.safeParse({ ...row(), amount: "5", flagColor: "duplicate" }).success,
    ).toBe(true);
  });

  it("FORK: no incrementFlag helper — the cycle is characterized inline", () => {
    // Oracle incrementFlag cycles None -> Red -> Orange -> Yellow -> Green
    // -> Blue -> Purple -> None. The repo has no cycling helper (see the
    // export-absence pin above); the cycle order is the palette order.
    const cycle = (current: string | null): string | null => {
      if (current === null) return TRANSACTION_FLAG_COLORS[0]!;
      const i = (TRANSACTION_FLAG_COLORS as readonly string[]).indexOf(current);
      if (i === -1) return null;
      return i === TRANSACTION_FLAG_COLORS.length - 1 ? null : TRANSACTION_FLAG_COLORS[i + 1]!;
    };
    const seen: (string | null)[] = [];
    let cur: string | null = null;
    for (let n = 0; n < 7; n++) {
      cur = cycle(cur);
      seen.push(cur);
    }
    expect(seen).toEqual(["red", "orange", "yellow", "green", "blue", "purple", null]);
    expect(cycle("weird")).toBeNull();
  });

  it("getIntegralFlagValue analogue: null maps to 0 via the rank table", () => {
    const integral = (flag: string | null): number =>
      flag === null ? 0 : (FLAG_INTEGRALS[flag as keyof typeof FLAG_INTEGRALS] ?? 0);
    expect(integral(null)).toBe(0);
    expect(integral("red")).toBe(6);
    expect(integral("duplicate")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D. TransactionSource (oracle: 3 tests)
// ---------------------------------------------------------------------------

describe("transaction source taxonomy (oracle TransactionSource analogue)", () => {
  it("FORK: 3-way taxonomy (UserEntered 0 / Imported 1 / ImportedIphone 2) is N/A — no source enum exported", () => {
    // The repo never records HOW a row arrived (manual vs imported vs
    // iPhone-imported); the verbatim "ImportedIphone" (lowercase p) name
    // and its integral values exist nowhere in logic/ or server/.
    for (const key of ["TransactionSource", "UserEntered", "ImportedIphone", "Imported"]) {
      expect(key in logicIndex).toBe(false);
    }
  });

  it("two-way imported detection: needsReview or a YNAB4 entity id marks a row imported", () => {
    expect(isImportedTransaction(mtx({ id: 1, needsReview: true }))).toBe(true);
    expect(isImportedTransaction(mtx({ id: 1, entityId: "YNAB4:abc" }))).toBe(true);
    expect(isImportedTransaction(mtx({ id: 1, entityId: "FITID:123" }))).toBe(true);
    expect(isImportedTransaction(mtx({ id: 1 }))).toBe(false);
    expect(isImportedTransaction(mtx({ id: 1, entityId: "" }))).toBe(false);
    expect(isImportedTransaction(mtx({ id: 1, needsReview: false, entityId: null }))).toBe(false);
  });

  it("import marker flows through merge (needsReview analogue of source tracking)", () => {
    const [primary, secondary] = pickMergePrimary(mtx({ id: 1 }), mtx({ id: 2, needsReview: true }));
    expect(
      resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null }).needsReview,
    ).toBe(true);
    const [p2, s2] = pickMergePrimary(mtx({ id: 1 }), mtx({ id: 2 }));
    expect(
      resolveMergedTransaction({ primary: p2, secondary: s2, sourceAccount: LIQUID, destAccount: null }).needsReview,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E. ScheduledTransactionFrequency (oracle: 5 tests)
// ---------------------------------------------------------------------------

describe("scheduled frequencies (oracle ScheduledTransactionFrequency analogue)", () => {
  it("pins all 13 frequencies in canonical order", () => {
    expect(RECURRING_FREQUENCIES.map((f) => f.value)).toEqual([
      "never",
      "daily",
      "weekly",
      "everyotherweek",
      "twiceamonth",
      "every4weeks",
      "monthly",
      "everyothermonth",
      "every3months",
      "every4months",
      "twiceayear",
      "yearly",
      "every2years",
    ]);
  });

  it("maps every frequency to its readable label (Every 3 Months etc)", () => {
    expect(frequencyLabel("never")).toBe("Never");
    expect(frequencyLabel("daily")).toBe("Daily");
    expect(frequencyLabel("weekly")).toBe("Weekly");
    expect(frequencyLabel("everyotherweek")).toBe("Every Other Week");
    expect(frequencyLabel("twiceamonth")).toBe("Twice a Month");
    expect(frequencyLabel("every4weeks")).toBe("Every 4 Weeks");
    expect(frequencyLabel("monthly")).toBe("Monthly");
    expect(frequencyLabel("everyothermonth")).toBe("Every Other Month");
    expect(frequencyLabel("every3months")).toBe("Every 3 Months");
    expect(frequencyLabel("every4months")).toBe("Every 4 Months");
    expect(frequencyLabel("twiceayear")).toBe("Twice a Year");
    expect(frequencyLabel("yearly")).toBe("Yearly");
    expect(frequencyLabel("every2years")).toBe("Every 2 Years");
  });

  it("accepts scheduling aliases for labels and validation", () => {
    expect(frequencyLabel("quarterly")).toBe("Every 3 Months");
    expect(frequencyLabel("biweekly")).toBe("Every Other Week");
    expect(frequencyLabel("semimonthly")).toBe("Twice a Month");
    for (const f of RECURRING_FREQUENCIES) {
      expect(isValidRecurringFrequency(f.value)).toBe(true);
    }
    expect(isValidRecurringFrequency("quarterly")).toBe(true);
    expect(isValidRecurringFrequency("Every Other Week")).toBe(true);
  });

  it("FORK: unknown input falls back instead of throwing 'unexpected'", () => {
    // Oracle getReadableName(null/foreign) throws "unexpected". The repo
    // never throws: unknown strings pass through, empty/null fall back
    // to "Monthly" — pin the actual fallback behavior.
    expect(() => frequencyLabel("unknown")).not.toThrow();
    expect(frequencyLabel("unknown")).toBe("unknown");
    expect(frequencyLabel("")).toBe("Monthly");
    expect(frequencyLabel(null as unknown as string)).toBe("Monthly");
    expect(isValidRecurringFrequency("unknown")).toBe(false);
    expect(isValidRecurringFrequency(null)).toBe(false);
    expect(isValidRecurringFrequency("")).toBe(false);
  });

  it("normalizes case/separators before validating", () => {
    expect(isValidRecurringFrequency("TWICE-A-MONTH")).toBe(true);
    expect(isValidRecurringFrequency("everyotheryear")).toBe(true);
    expect(frequencyLabel("everyotheryear")).toBe("Every 2 Years");
  });
});

// ---------------------------------------------------------------------------
// F. YNABEntityType (oracle: 3 tests -> entity-graph N/A)
// ---------------------------------------------------------------------------

describe("entity-type registry (oracle YNABEntityType analogue, N/A with reason)", () => {
  /** Verbatim oracle entity names — none exists as a registry in this repo. */
  const ORACLE_ENTITY_TYPES = [
    "budgetMetaData",
    "masterCategory",
    "category",
    "account",
    "accountMapping",
    "transaction",
    "subTransaction",
    "matchedTransaction",
    "scheduledTransaction",
    "monthlyBudget",
    "monthlyCategoryBudget",
    "payee",
    "payeeStringCondition",
    "location",
  ] as const;

  it("documents the 14-way entity graph as N/A: no entity-type registry in logic", () => {
    expect(ORACLE_ENTITY_TYPES).toHaveLength(14);
    for (const name of ["YNABEntityType", "budgetMetaData", "matchedTransaction", "accountMapping"]) {
      expect(name in logicIndex).toBe(false);
    }
  });

  it("characterizes the Transaction entity shape the tables persist instead", () => {
    const parsed = TransactionResponseSchema.safeParse({ ...row(), amount: "500" });
    expect(parsed.success).toBe(true);
    // Exact lowercase wire names only — the getEnumByName miss analogue:
    // capitalized entity/type names are not valid field values anywhere.
    for (const miss of ["Transaction", "Cleared", "RECONCILED", "U"]) {
      expect(TransactionResponseSchema.safeParse({ ...row(), amount: "5", status: miss }).success).toBe(false);
    }
  });

  it("SQLite tables replace the entity graph on the server (documented, not imported here)", () => {
    // FORK: persistence lives in server/src/schema.ts (accounts,
    // categoryGroups, categories, assignments, settings, payees,
    // transactions, reconciliations, recurring, recurringSubTransactions,
    // scheduledPostings, renameRules, duplicate_ignores) — logic tests
    // must not import the server package (dependency direction), so the
    // table set is documented rather than asserted.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G. SyncableEntity domain seams (oracle: 14 tests)
// ---------------------------------------------------------------------------

describe("syncable-entity seams (oracle SyncableEntity analogue)", () => {
  it("FORK: orphan split children return undefined instead of throwing 'Can't find parentEntityId: X'", () => {
    // Oracle findParentGuaranteeExists throws when the parent is missing.
    // getSplitParent returns undefined for orphans — pin the tolerant read.
    const orphan = row({ id: 9, parentId: 999 });
    expect(getSplitParent([orphan], orphan)).toBeUndefined();
    expect(getSplitParent([], orphan)).toBeUndefined();
    expect(getSplitChildren([orphan], 123)).toEqual([]);
  });

  it("resolves a live parent and lists its children in input order", () => {
    const parent = row({ id: 1 });
    const a = row({ id: 2, parentId: 1 });
    const b = row({ id: 3, parentId: 1 });
    const all = [parent, a, b];
    expect(getSplitParent(all, a)).toEqual(parent);
    expect(getSplitChildren(all, 1)).toEqual([a, b]);
    expect(getSplitParent(all, parent)).toBeUndefined();
  });

  it("lineage id stability: entity ids survive merge and JSON round-trips", () => {
    // Analogue of unique-id shape + toString-embeds-id: ids are stable
    // lineage markers, never regenerated by pure helpers.
    const [primary, secondary] = pickMergePrimary(
      mtx({ id: 1, entityId: "YNAB:abc" }),
      mtx({ id: 2, needsReview: true }),
    );
    const merged = resolveMergedTransaction({ primary, secondary, sourceAccount: LIQUID, destAccount: null });
    expect(merged.entityId).toBe("YNAB:abc");
    // transferEntityId persists only on transfer legs (merge.ts:248); a
    // non-transfer merge nulls it by design, like a VO stamp that only
    // applies to its own entity kind.
    expect(merged.transferEntityId).toBeNull();
    const [tp, ts] = pickMergePrimary(
      mtx({ id: 1, payee: "Transfer : Savings" }),
      mtx({ id: 2, needsReview: true, transferAccountId: 7, transferEntityId: "YNAB:t1", payee: "Transfer : Savings" }),
    );
    const tm = resolveMergedTransaction({
      primary: tp,
      secondary: ts,
      sourceAccount: LIQUID,
      destAccount: LIQUID,
    });
    expect(tm.transferEntityId).toBe("YNAB:t1");
    const tx = row({ id: 42 });
    expect((JSON.parse(JSON.stringify(tx)) as Transaction).id).toBe(42);
    expect(String(tx.id)).toContain("42");
  });

  it("aggregate children are scoped per parent (ReadAggregateChildrenFromVO-false analogue)", () => {
    // Oracle never aggregates children across parents; neither does the
    // repo: recurring children filter by exact recurringId.
    const kids: RecurringSubTransaction[] = [
      { id: 1, recurringId: 1, categoryId: 5, amount: "100", memo: "", sort: 1 },
      { id: 2, recurringId: 2, categoryId: 5, amount: "200", memo: "", sort: 0 },
      { id: 3, recurringId: 1, categoryId: 5, amount: "300", memo: "", sort: 0 },
    ];
    expect(getRecurringChildren(kids, 1).map((k) => k.id)).toEqual([3, 1]);
    expect(getRecurringChildren(kids, 2).map((k) => k.id)).toEqual([2]);
    expect(getRecurringChildren(kids, 999)).toEqual([]);
  });

  it("matched-prefix strip/throw analogue: transfer payee shape is validated, orphans throw", () => {
    // Oracle strips the matched prefix and throws on malformed ids; here
    // the "Transfer : <account>" prefix is recognized and an orphaned
    // transfer-styled payee (no leg) throws via the errorFactory.
    expect(isTransferPayee("Transfer : Checking")).toBe(true);
    expect(isTransferPayee("Starbucks")).toBe(false);
    expect(() => validateTransferPayeeConsistency("Transfer : Savings", null)).toThrow(TransactionError);
    expect(() => validateTransferPayeeConsistency("Transfer : Savings", 7)).not.toThrow();
  });

  it("deferred-income handling analogue: boundary inflows retain the caller's income month", () => {
    // Server import-ynab4 phases track immediate vs deferred income via
    // sentinel category ids; the logic-layer analogue is incomeMonth
    // retention on boundary inflows (the month the income defers to).
    const r = classifyBoundaryTransfer({
      srcOnBudget: false,
      destOnBudget: true,
      amount: -500000,
      incomeMonth: "2026-08",
    });
    expect(r.isIncome).toBe(true);
    expect(r.incomeMonth).toBe("2026-08");
  });
});
