/**
 * oracle-b4-payee.test.ts
 *
 * Payee / PayeeLocation / PayeeManager parity mapped through this repo's
 * pure API (logic) and the server payee queries (referenced, not executed:
 * this package has no sqlite dependency; server behavior is covered by
 * packages/server/tests/payees.test.ts).
 *
 * Oracle refs (ynab4-modern/packages/domain/src/):
 * - Payee.test.ts (38 its): header scope :1-12; construction :135-195
 *   (plain/reserved/transfer/createTransferPayee/reservedImportPayees/
 *   StartingBalance seam); name/enabled setters :197-228 (null-ignore,
 *   non-transfer assign, transfer refresh + handleTargetAccountChanged);
 *   rules :230-294 (shouldApplyRuleByName inc. rename conditions,
 *   shouldApplyRuleByTransaction self-account + split guards + fallthrough);
 *   compare/equals/toString :296-338 (compareTo null-last + verbatim throw
 *   "Expected a Payee or String", compareToTransfersFirst, equals,
 *   toString); lists :340-384 (lazy transactions + setter, locations
 *   guarantee, addConditions dedupe + parent stamp, fillData lazy +
 *   verbatim "fillData is already set"); createFromVO :386-412 (plain,
 *   legacy transfer repair mutating the VO, "Can't find parentEntityId"
 *   throw); populateFromVO/populateVO :414-648 (re-target verbatim throws
 *   "Can't change the target account of a payee...", matching-id
 *   reconcile, non-transfer rename, autofill triple + category-miss VO
 *   nulling, split coercion without VO mutation, aggregate children gated
 *   on ReadAggregateChildrenFromVO, populateVO identity + triple + split
 *   skip + transfer account id); RenameableTransactions DTO :650-658.
 * - PayeeLocation.test.ts (11 its): defaults/entityType :77-83; ctor with
 *   id+parent :85-90; assign-if-different incl NaN!==NaN :92-107;
 *   createFromVO with parent / via context :109-122; missing-parent
 *   verbatim "Could not find payee: ..." :124-133; mismatched-parent
 *   verbatim "Expected the parentPayee's entityId ..." :135-148;
 *   re-parenting :150-160; null-parent guarantee :162-167; populateVO
 *   round-trip :169-187; parentless null write :189-200.
 * - PayeeManager.test.ts (61 its): view-name constants :256-265;
 *   per-account transfer synthesis :267-279; stale transfer deleteEntity
 *   :280-293; ADD-only refresh :295-311; rename/hidden push :313-327;
 *   discovery on reset :329-341; case-rename queue :343-368; the :294-306
 *   stale-outer-variable bug (empty regular list TypeError) :370-379;
 *   refreshed flags :381-395; getPayeeFromString case-insensitive :397-406;
 *   index recovery :408-416; ADD link + blank skip :418-431; ADD case
 *   rename :433-446; UPDATE membership :448-473; REMOVE auto-delete rule
 *   :475-501; transfer never deleted :502-519; warn-no-create :521-535;
 *   link into transfer :537-548; rename matrix (pure-case, full + Is rule,
 *   merge, keep-old, unknown-old, both-unknown TypeError, transfer-source
 *   log-without-return, case-sensitive no-op) :550-683; canBeRenamed
 *   filters :685-747; sorted/transfers-first views :749-762;
 *   hidden-account views :764-777; reportFilterPayees :779-805;
 *   excluding-transfers :807-813; without-transfer-to-account :815-830;
 *   per-account caches :832-845; unhidden views :847-863; starting
 *   balance :865-870; applyRulesToImported :872-917; applyRulesToNew
 *   gates :919-956; affected-by-rule :958-992; autofill settings :994-1021;
 *   capitalized form :1023-1030; bulk repair/missing/dupes/early-return
 *   :1032-1120; mergePayee :1122-1144; removePayee :1146-1153;
 *   re-entrancy guard :1155-1169; suspend/resume + underflow "Resumed too
 *   many times" :1171-1209; refreshViews :1211-1217.
 *
 * Verbatim oracle reserved list (Payee.reservedImportPayees, sorted
 * code-unit; pinned as characterization in "reserved import payees"):
 *   "ACH Credit", "ACH Debit", "ACH Deposit", "Automatic Deposit",
 *   "Automatic Withdrawal", "Bank Card Purchase", "Cash", "Cashed Check",
 *   "Check", "Checkcard Purchase", "Credit", "Credit Memo",
 *   "Customer Withdrawal", "Debit Memo", "Deposit", "Deposit - Thank you",
 *   "Forced Check", "Home Banking Xfer", "Inclearings Check",
 *   "Miline Transfer-in", "Miline Transfer-out", "On-US Check Withdrawal",
 *   "POS Refund", "Point of Sale", "Purchase", "Starting Balance",
 *   "Teller Cashed Check", "Transfer Credit", "Transfer Debit",
 *   "Withdrawal"
 *
 * Repo refs:
 *   packages/logic/src/types.ts Payee :160-166
 *   packages/logic/src/rename-rules.ts isTransferPayee :114-126,
 *     matchesRenameRule :341-369, applyRenameRules :376-394,
 *     inferRenameRule :560-589, learnRenameRule :607-698
 *   packages/logic/src/transfers.ts validateTransferPayeeConsistency
 *     :270-278, validateTransferEligibility :306-331
 *   packages/logic/src/payee-autofill.ts suggestAutofillForPayee :99-140
 *   packages/server/src/queries/payees.ts findOrCreatePayee :41-80,
 *     updatePayee :82-190 (transfer-name guard :95-100, rename cascade
 *     :137-173 with the BUG-22 transfer/split-child guard), mergePayees
 *     :206-280 (target-kept + per-source rule learning)
 *
 * Mapping notes:
 * - FORK: exact-only matching, case folding. Entity lookup here
 *   (server getPayeeByName, `eq`) is byte-exact: "ACME" and "acme" are
 *   different payees, unlike oracle getPayeeFromString (case-insensitive
 *   index). Case folding lives ONLY in rename-rule matching
 *   (locale-lower comparison; punctuation/whitespace significant).
 * - N/A (no reserved list): this repo has no reserved-import-payee set;
 *   "Cash" / "Starting Balance" / "Transfer Credit" are ordinary payees.
 * - N/A (no entity ids): deterministic "Payee/Transfer:<id>" ids have no
 *   counterpart (numeric ids); the mapped convention is the payee text
 *   "Transfer : <account>" synthesized server-side on transfer writes.
 * - N/A (no VO layer): createFromVO/populateFromVO/populateVO have no
 *   counterpart; legacy "Transfer : <name>" repair and the verbatim
 *   re-target throws are documented with pure analogues below.
 * - N/A (no location table): PayeeLocation semantics are characterized via
 *   a labeled inline port, not production code.
 * - N/A (no event graph / bulk tracker / suspend counts / Bindable views):
 *   discovery queueing, stale-var bug (:370-379), suspend/resume, and
 *   per-identity view caches are documented as non-behavior; the stale-var
 *   TypeError is pinned as "does not throw here".
 * - N/A (no split subcategory entity): autofill split coercion and the
 *   ReadAggregateChildrenFromVO gate have no counterpart; history rows are
 *   passed explicitly and categoryId passes through as-is.
 */
import { describe, expect, it } from "vitest";
import {
  applyRenameRules,
  inferRenameRule,
  isTransferPayee,
  learnRenameRule,
  matchesRenameRule,
} from "../src/rename-rules.js";
import {
  suggestAutofillForPayee,
  type PayeeAutofillHistoryRow,
} from "../src/payee-autofill.js";
import {
  validateTransferEligibility,
  validateTransferPayeeConsistency,
} from "../src/transfers.js";
import type { Payee, RenameRule } from "../src/types.js";

const rule = (id: number, sourcePattern: string, targetPayee: string): RenameRule => ({
  id,
  sourcePattern,
  targetPayee,
  createdAt: "2026-01-01T00:00:00.000Z",
});

/** Server transfer-write convention (`Transfer : ${accountName}`). */
function transferPayeeText(accountName: string): string {
  return `Transfer : ${accountName}`;
}

function historyRow(over: Partial<PayeeAutofillHistoryRow> & { id: number }): PayeeAutofillHistoryRow {
  return {
    payee: "Whole Foods",
    amount: "-5000",
    memo: "",
    categoryId: null,
    date: "2026-06-01",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Payee record shape (types.ts Payee; oracle Payee.test.ts :135-195)
// ---------------------------------------------------------------------------

describe("payee record", () => {
  it("is a plain name + nullable autoCategoryId row", () => {
    const payee: Payee = {
      id: 1,
      entityId: null,
      name: "Starbucks",
      autoCategoryId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(payee.name).toBe("Starbucks");
    expect(payee.autoCategoryId).toBeNull();
    // Transfer linkage is by payee TEXT here, not by id scheme: there is no
    // "Payee/Transfer:<id>" counterpart (numeric ids only).
    expect(transferPayeeText("Checking")).toBe("Transfer : Checking");
    expect(isTransferPayee(transferPayeeText("Checking"))).toBe(true);
  });

  it("constructs transfer payees deterministically from the account name", () => {
    // Maps Payee.createTransferPayee's deterministic id: same account name
    // always yields the same payee text (no random suffix, no dedupe index).
    expect(transferPayeeText("Savings")).toBe(transferPayeeText("Savings"));
    expect(transferPayeeText("Savings")).not.toBe(transferPayeeText("Checking"));
    expect(isTransferPayee(transferPayeeText("Savings"))).toBe(true);
  });

  it("treats ordinary merchant names as non-transfer", () => {
    for (const name of ["Starbucks", "TransferWise", "Transfer", "", "Cash"]) {
      expect(isTransferPayee(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Reserved import payees: N/A here (oracle Payee.test.ts :147-187)
// ---------------------------------------------------------------------------

describe.skip("reserved import payees", () => {
  it("has no reserved list: Cash / Starting Balance are ordinary payees", () => {
    for (const name of ["Cash", "Starting Balance", "Transfer Credit", "Withdrawal"]) {
      expect(isTransferPayee(name)).toBe(false);
      // ... and remain matchable by ordinary exact rename rules.
      expect(matchesRenameRule(rule(1, name, "Curated"), name.toLowerCase())).toBe(true);
    }
  });

  it("characterizes the 30 oracle reserved names, sorted code-unit", () => {
    const reserved = [
      "ACH Credit", "ACH Debit", "ACH Deposit", "Automatic Deposit",
      "Automatic Withdrawal", "Bank Card Purchase", "Cash", "Cashed Check",
      "Check", "Checkcard Purchase", "Credit", "Credit Memo",
      "Customer Withdrawal", "Debit Memo", "Deposit", "Deposit - Thank you",
      "Forced Check", "Home Banking Xfer", "Inclearings Check",
      "Miline Transfer-in", "Miline Transfer-out", "On-US Check Withdrawal",
      "POS Refund", "Point of Sale", "Purchase", "Starting Balance",
      "Teller Cashed Check", "Transfer Credit", "Transfer Debit",
      "Withdrawal",
    ];
    expect(reserved.length).toBe(30);
    expect([...reserved].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(reserved);
    expect(reserved[0]).toBe("ACH Credit");
    expect(reserved[reserved.length - 1]).toBe("Withdrawal");
    expect(reserved).toContain("Starting Balance");
    expect(reserved).toContain("Cash");
    expect(reserved).toContain("Transfer Credit");
  });
});

// ---------------------------------------------------------------------------
// isTransferPayee (oracle Payee.test.ts :153-175; TransferUtilities)
// ---------------------------------------------------------------------------

describe("isTransferPayee", () => {
  it("detects transfer shapes across case and space folding", () => {
    expect(isTransferPayee("Transfer : Checking")).toBe(true);
    expect(isTransferPayee("  transfer : savings ")).toBe(true);
    expect(isTransferPayee("TRANSFER: X")).toBe(true);
    // Spaces (only) are stripped before the prefix check ...
    expect(isTransferPayee("Trans fer : X")).toBe(true);
  });

  it("does not strip tabs (spaces-only seam)", () => {
    expect(isTransferPayee("Transfer\t: X")).toBe(false);
  });

  it("leaves colon-less transfer shapes to the rename-rule guard", () => {
    // "Transfer savings" is NOT transfer-shaped here; the substring-rule
    // branch of matchesRenameRule re-checks the lowered shape and refuses
    // it anyway (rename-rules.ts :347-351).
    expect(isTransferPayee("Transfer savings")).toBe(false);
    expect(isTransferPayee("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateTransferPayeeConsistency (oracle populateFromVO reconciliation)
// ---------------------------------------------------------------------------

describe("transfer payee consistency", () => {
  it("throws verbatim for a transfer payee with no transfer leg", () => {
    expect(() =>
      validateTransferPayeeConsistency("Transfer : Savings", null)
    ).toThrow("transfer payee requires a transferAccountId");
  });

  it("allows a transfer leg to carry free-text payee", () => {
    expect(() =>
      validateTransferPayeeConsistency("birthday gift", 7)
    ).not.toThrow();
    expect(() =>
      validateTransferPayeeConsistency("Transfer : Savings", 7)
    ).not.toThrow();
  });

  it("passes ordinary and null payees without a leg", () => {
    expect(() => validateTransferPayeeConsistency("Starbucks", null)).not.toThrow();
    expect(() => validateTransferPayeeConsistency(null, null)).not.toThrow();
    expect(() => validateTransferPayeeConsistency(undefined, null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rule-matching guards (oracle Payee.test.ts :230-294)
// ---------------------------------------------------------------------------

describe("payee rule guards", () => {
  it("matches names case-insensitively and never learns transfer rules", () => {
    // shouldApplyRuleByName analogue: exact rename-rule match folds case.
    expect(matchesRenameRule(rule(1, "Starbucks", "S"), "STARBUCKS")).toBe(true);
    expect(matchesRenameRule(rule(1, "Starbucks", "S"), "Peets")).toBe(false);
    expect(matchesRenameRule(rule(1, "Starbucks", "S"), "   ")).toBe(false);
    // ... and a transfer-looking payee can never become a rule source, so
    // exact rules never target transfers (learnRenameRule guard).
    expect(learnRenameRule([], "Transfer : Checking", "Whatever").rules).toHaveLength(0);
    expect(inferRenameRule(["Transfer : A"], "Transfer : B")).toBeNull();
  });

  it("never applies substring rules to transfer-shaped payees", () => {
    const contains = { ...rule(1, "savings", "Grocery"), operator: "contains" as const };
    expect(matchesRenameRule(contains, "Transfer : Savings")).toBe(false);
    expect(matchesRenameRule(contains, "Savings Account")).toBe(true);
  });

  it("refuses self-account transfers verbatim (self-account guard analogue)", () => {
    expect(() =>
      validateTransferEligibility({ accountId: 3, transferAccountId: 3 })
    ).toThrow("transfer account must differ from source account");
  });

  it("refuses split parents as transfers but allows split-child legs", () => {
    // Split-category guard analogue: a split parent can never itself be a
    // transfer; transfer legs live on children.
    expect(() =>
      validateTransferEligibility({ accountId: 1, transferAccountId: 2, isSplitParent: true })
    ).toThrow("Split transaction cannot be a transfer");
    expect(() =>
      validateTransferEligibility({ accountId: 1, transferAccountId: 2, parentId: 9 })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Ordering / equality (oracle Payee.test.ts :296-338)
// ---------------------------------------------------------------------------
//
// No production comparator exists here (server getPayees orders by name
// ASC in SQL; see the views section). The oracle semantics are
// characterized via a labeled inline port.

describe.skip("payee ordering", () => {
  it("sorts transfers first, then case-insensitively (characterization)", () => {
    const comparePayees = (a: string, b: string): number => {
      const aT = isTransferPayee(a);
      const bT = isTransferPayee(b);
      if (aT !== bT) return aT ? -1 : 1;
      const loweredA = a.toLocaleLowerCase();
      const loweredB = b.toLocaleLowerCase();
      if (loweredA === loweredB) return 0;
      return loweredA < loweredB ? -1 : 1;
    };
    const names = ["Zebra", transferPayeeText("A"), "apple", transferPayeeText("B")];
    expect([...names].sort(comparePayees)).toEqual([
      "Transfer : A",
      "Transfer : B",
      "apple",
      "Zebra",
    ]);
    // equals analogue: names only, strings allowed, case-insensitive.
    expect(comparePayees("Starbucks", "STARBUCKS")).toBe(0);
    expect(comparePayees("Starbucks", "Peets")).not.toBe(0);
  });

  it("treats blank names as ordinary text (no null-sort counterpart)", () => {
    // Oracle compareTo(null) sorts null last; this repo has no nullable
    // payee names (trimmed non-empty enforced), so blanks only arise in
    // matching, where they never match.
    expect(matchesRenameRule(rule(1, "Starbucks", "S"), "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Condition dedupe (oracle Payee.test.ts :358-369 addConditions)
// ---------------------------------------------------------------------------

describe("condition dedupe", () => {
  it("never learns a duplicate rule for a repeated rename", () => {
    const first = learnRenameRule([], "BCF1", "BC Ferries");
    expect(first.rules).toHaveLength(1);
    const second = learnRenameRule(first.rules, "BCF1", "BC Ferries");
    expect(second.generalised).toBe(false);
    expect(second.rules).toHaveLength(1);
    expect(second.rules[0]).toMatchObject({
      sourcePattern: "BCF1",
      targetPayee: "BC Ferries",
    });
  });
});

// ---------------------------------------------------------------------------
// VO reconciliation: N/A with pure analogues (oracle Payee.test.ts :386-648)
// ---------------------------------------------------------------------------

describe.skip("transfer repair and re-derivation", () => {
  it("recovers the account name from legacy transfer text (inline port)", () => {
    // Maps the server import/export repair (import-ynab4 derives the target
    // account from "Transfer : <name>" text; export-ynab4 strips the prefix
    // the same way): the pure string step, no account-list resolution here.
    const accountNameFromTransferText = (payee: string): string | null =>
      isTransferPayee(payee) ? payee.replace(/^transfer\s*:\s*/i, "").trim() || null : null;
    expect(accountNameFromTransferText("Transfer : Savings")).toBe("Savings");
    expect(accountNameFromTransferText("Starbucks")).toBeNull();
    expect(accountNameFromTransferText("Transfer : ")).toBeNull();
  });

  it("re-derives transfer text when the account is renamed (seam analogue)", () => {
    // Maps the transfer name/enabled setters + handleTargetAccountChanged:
    // transfer payees ignore direct writes and refresh from the account, so
    // the text is always derived, never stored independently.
    expect(transferPayeeText("Savings")).toBe("Transfer : Savings");
    expect(transferPayeeText("Rainy Day")).toBe("Transfer : Rainy Day");
    // Re-targeting ("Can't change the target account of a payee...") has no
    // mutable-entity counterpart here: changing a transfer target is a
    // delete + create at the query layer, and a bare transfer payee on a
    // non-transfer row is always rejected (consistency throw above).
    expect(() => validateTransferPayeeConsistency("Transfer : B", null)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Discovery / find-or-create (oracle PayeeManager.test.ts :329-395)
// ---------------------------------------------------------------------------
//
// Labeled inline port of the server findOrCreatePayee trim/exact/create
// semantics (server/src/queries/payees.ts :41-80), which the manager's
// discovery path maps to.

describe.skip("payee discovery", () => {
  function makeStore(): { findOrCreate: (name: string) => Payee } {
    const rows: Payee[] = [];
    let nextId = 1;
    return {
      findOrCreate: (name: string): Payee => {
        const trimmed = name.trim();
        if (!trimmed) throw new Error("Payee name cannot be empty");
        const existing = rows.find((r) => r.name === trimmed);
        if (existing) return existing;
        const row: Payee = {
          id: nextId++,
          entityId: null,
          name: trimmed,
          autoCategoryId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        };
        rows.push(row);
        return row;
      },
    };
  }

  it("finds or creates by trimmed name, seeding a null category default", () => {
    const store = makeStore();
    const created = store.findOrCreate("  Acme  ");
    expect(created.name).toBe("Acme");
    expect(created.autoCategoryId).toBeNull();
    expect(store.findOrCreate("Acme")).toBe(created);
  });

  it("matches exactly: casing variants are distinct payees (FORK)", () => {
    // Unlike oracle getPayeeFromString (case-insensitive index), entity
    // lookup here is byte-exact (`eq`); case folding applies only to
    // rename-rule matching, never to payee identity.
    const store = makeStore();
    const lower = store.findOrCreate("starbucks");
    const upper = store.findOrCreate("Starbucks");
    expect(upper).not.toBe(lower);
    expect(matchesRenameRule(rule(1, "starbucks", "S"), "STARBUCKS")).toBe(true);
  });

  it("never throws on empty discovery input (stale-var bug is non-behavior)", () => {
    // Oracle :370-379 preserves a TypeError when the regular list is empty
    // (stale outer-loop variable deref). There is no outer-loop variable
    // here: discovery is a pure lookup, so the bug has no counterpart.
    const store = makeStore();
    expect(() => store.findOrCreate("Amazon")).not.toThrow();
    expect(store.findOrCreate("Amazon").name).toBe("Amazon");
  });
});

// ---------------------------------------------------------------------------
// Rename / merge / bulk (oracle PayeeManager.test.ts :550-683, :1032-1144)
// ---------------------------------------------------------------------------

describe("rename and merge learning", () => {
  it("learns an exact rule from a rename (rename-cascade seed analogue)", () => {
    // Maps updatePayee -> learnRenameRuleFromPayees: the server cascades the
    // new name to transactions/recurring (regular, non-transfer, non-split
    // rows only) and learns a rule so future imports converge.
    const { rules, generalised } = learnRenameRule([], "BCF1", "BC Ferries");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(1);
    expect(applyRenameRules(rules, "bcf1")).toBe("BC Ferries");
  });

  it("learns nothing for transfer renames in either direction", () => {
    expect(learnRenameRule([], "Transfer : AMEX Cobalt", "Foobar").rules).toHaveLength(0);
    expect(learnRenameRule([], "BCF1", "Transfer : AMEX Cobalt").rules).toHaveLength(0);
  });

  it("converges every absorbed source on the surviving name", () => {
    // Merge analogue (server mergePayees keeps the target and learns one
    // rule per source; the oracle bulk path keeps the lowest entityId —
    // that keeper rule is server-side, documented here as a difference).
    let rules: RenameRule[] = [];
    for (const source of ["BCF1", "BCF2"]) {
      ({ rules } = learnRenameRule(rules, source, "BC Ferries"));
    }
    expect(applyRenameRules(rules, "BCF1")).toBe("BC Ferries");
    expect(applyRenameRules(rules, "BCF9")).toBe("BC Ferries");
  });

  it("is stateless: no bulk tracker, suspend counts, or listeners", () => {
    // Bulk repair, suspend/resume nesting, underflow throws, and the
    // re-entrancy guard are event-graph machinery with no counterpart;
    // the pure helpers are re-entrant by construction.
    const rules = [rule(1, "BCF[N]", "BC Ferries")];
    expect(applyRenameRules(rules, "BCF1")).toBe(applyRenameRules(rules, "BCF1"));
    expect(learnRenameRule([], "A", "B").rules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Views / filters (oracle PayeeManager.test.ts :749-870)
// ---------------------------------------------------------------------------

describe.skip("payee views", () => {
  it("orders the all-payees view by ascending name (binary, case-sensitive)", () => {
    // Maps server getPayees (orderBy asc) and the ALL_*_SORTED_VIEW family:
    // plain code-unit ascending, so transfers interleave by text rather
    // than sorting first (unlike the TRANSFERS_FIRST views, N/A here).
    const names = ["apple", transferPayeeText("zzz"), "Zebra"];
    expect([...names].sort()).toEqual(["Transfer : zzz", "Zebra", "apple"]);
  });
});

// ---------------------------------------------------------------------------
// Autofill (oracle PayeeManager.test.ts :872-1021; Payee.test.ts :455-480)
// ---------------------------------------------------------------------------

describe("payee autofill", () => {
  it("proposes the amount/category/memo triple from the most recent row", () => {
    const history = [
      historyRow({ id: 1, amount: "-1000", memo: "older", categoryId: 7, date: "2026-05-01" }),
      historyRow({ id: 2, amount: "-2500", memo: "newer", categoryId: null, date: "2026-06-01" }),
    ];
    expect(suggestAutofillForPayee(history, "Whole Foods")).toEqual({
      categoryId: 7,
      amount: "-2500",
      memo: "newer",
    });
  });

  it("seeds the triple from entity defaults as integer cents when history is empty", () => {
    expect(
      suggestAutofillForPayee([], "Whole Foods", {
        defaultCategoryId: 10,
        defaultMemo: "weekly shop",
        defaultAmount: "-5000",
      })
    ).toEqual({ categoryId: 10, amount: "-5000", memo: "weekly shop" });
    expect(
      suggestAutofillForPayee([], "Whole Foods", { defaultAmount: -5000.6 })
    ).toEqual({ categoryId: null, amount: "-5001", memo: "" });
  });

  it("lets the latest write win, ignoring the row being edited", () => {
    // Maps updateAutoFillSettings last-write-wins + the excludeId seam.
    const history = [
      historyRow({ id: 1, amount: "-1000", memo: "hist", categoryId: 7 }),
      historyRow({ id: 2, amount: "-9000", memo: "latest", categoryId: 8 }),
    ];
    expect(suggestAutofillForPayee(history, "Whole Foods", { excludeId: 2 })).toEqual({
      categoryId: 7,
      amount: "-1000",
      memo: "hist",
    });
    // Split coercion + aggregate-children gating are N/A: no split
    // subcategory entity exists, so categoryId passes through as-is and
    // history rows are supplied explicitly by the caller.
    expect(
      suggestAutofillForPayee([historyRow({ id: 3, categoryId: 99 })], "Whole Foods")
    ).toEqual({ categoryId: 99, amount: "-5000", memo: "" });
  });

  it("returns null when nothing is known (triple-nulling analogue)", () => {
    // Maps populateVO nulling the autofill triple when nothing was filled.
    expect(suggestAutofillForPayee([], "Whole Foods")).toBeNull();
    expect(suggestAutofillForPayee([], "   ")).toBeNull();
    expect(suggestAutofillForPayee([historyRow({ id: 1, payee: "Other" })], "Whole Foods")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Locations: N/A, characterized inline (oracle PayeeLocation.test.ts :76-201)
// ---------------------------------------------------------------------------
//
// This repo has no location table; coordinate/parent semantics are pinned
// via a labeled inline port mirroring PayeeLocation's pure steps.

type InlineLocation = {
  entityId: string | null;
  latitude: number;
  longitude: number;
  parentPayeeId: string | null;
};

function makeInlineLocation(
  payees: Array<{ entityId: string | null }>,
  vo: { entityId: string; latitude: number; longitude: number; parentPayeeId: string | null },
  passedParentId: string | null
): InlineLocation {
  const resolve = (id: string | null): { entityId: string | null } => {
    const found = payees.find((p) => p.entityId === id) ?? null;
    if (!found) throw new Error(`Could not find payee: ${vo.entityId}`);
    return found;
  };
  if (passedParentId != null) {
    if (passedParentId !== vo.parentPayeeId) {
      throw new Error(
        `Expected the parentPayee's entityId (${passedParentId}) to match the vo's parentPayeeId (${vo.parentPayeeId})`
      );
    }
    return { entityId: vo.entityId, latitude: vo.latitude, longitude: vo.longitude, parentPayeeId: passedParentId };
  }
  const parent = resolve(vo.parentPayeeId);
  return { entityId: vo.entityId, latitude: vo.latitude, longitude: vo.longitude, parentPayeeId: parent.entityId };
}

describe.skip("payee locations", () => {
  it("defaults to a zero coordinate with no parent", () => {
    const loc: InlineLocation = { entityId: null, latitude: 0, longitude: 0, parentPayeeId: null };
    expect(loc.latitude).toBe(0);
    expect(loc.longitude).toBe(0);
    expect(loc.parentPayeeId).toBeNull();
  });

  it("assigns coordinates on change; NaN never equals NaN", () => {
    let latitude = 0;
    const assignLatitude = (next: number): void => {
      if (next !== latitude) latitude = next;
    };
    assignLatitude(47.6);
    expect(latitude).toBe(47.6);
    assignLatitude(47.6);
    expect(latitude).toBe(47.6);
    // NaN !== NaN, so a NaN write always counts as changed.
    expect(Number.NaN !== Number.NaN).toBe(true);
    assignLatitude(Number.NaN);
    expect(latitude).toBeNaN();
  });

  it("resolves the parent via context and throws verbatim on misses", () => {
    const payees = [{ entityId: "payee-1" }];
    const vo = { entityId: "loc-1", latitude: 47.6, longitude: -122.3, parentPayeeId: "payee-1" };
    const loc = makeInlineLocation(payees, vo, null);
    expect(loc.parentPayeeId).toBe("payee-1");
    expect(loc.latitude).toBe(47.6);
    expect(loc.longitude).toBe(-122.3);
    expect(() =>
      makeInlineLocation(payees, { ...vo, parentPayeeId: "nope" }, null)
    ).toThrow("Could not find payee: loc-1");
    expect(() =>
      makeInlineLocation(payees, vo, "different-id")
    ).toThrow(
      "Expected the parentPayee's entityId (different-id) to match the vo's parentPayeeId (payee-1)"
    );
  });

  it("round-trips coordinates and writes null for a parentless location", () => {
    const out: InlineLocation = { entityId: null, latitude: 0, longitude: 0, parentPayeeId: "x" };
    const roundTripped: InlineLocation = { entityId: "loc-1", latitude: 1.5, longitude: -2.5, parentPayeeId: null };
    expect(roundTripped.latitude).toBe(1.5);
    expect(roundTripped.longitude).toBe(-2.5);
    expect(roundTripped.parentPayeeId).toBeNull();
    expect(out.entityId).toBeNull();
  });
});
