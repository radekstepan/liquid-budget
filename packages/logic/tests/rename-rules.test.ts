import { describe, expect, it } from "vitest";
import {
  applyRenameRules,
  compileRenameRules,
  countRenameRuleMatches,
  inferRenameRule,
  isPatternRule,
  isTransferPayee,
  learnRenameRule,
  matchesCompiledRule,
  matchesRenameRule,
  normalizeRenameText,
  renamePatternToRegExp,
  renameRulePayeeFilter,
  type RenameRule,
} from "../src/rename-rules.js";

const rule = (id: number, sourcePattern: string, targetPayee: string): RenameRule => ({
  id,
  sourcePattern,
  targetPayee,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("normalizeRenameText", () => {
  it("trims, lowercases, and collapses repeated whitespace", () => {
    expect(normalizeRenameText("  BC Ferries ")).toBe("bc ferries");
    expect(normalizeRenameText("PHNOM   PENH\tRESTAURANT")).toBe(
      "phnom penh restaurant"
    );
  });
});

describe("renamePatternToRegExp", () => {
  it("builds a regex where [N] matches one or more digits", () => {
    const re = renamePatternToRegExp("BCF[N]");
    expect(re).not.toBeNull();
    expect(re!.test("bcf1")).toBe(true);
    expect(re!.test("BCF12345")).toBe(true);
    expect(re!.test("BCF1X")).toBe(false);
    expect(re!.test("XBCF1")).toBe(false);
  });

  it("returns null for empty or exact patterns", () => {
    expect(renamePatternToRegExp("")).toBeNull();
    expect(renamePatternToRegExp("BCF1")).toBeNull();
  });

  it("escapes regex metacharacters in the fixed parts", () => {
    const re = renamePatternToRegExp("WHOLE FOODS #[N]");
    expect(re).not.toBeNull();
    expect(re!.test("whole foods #24")).toBe(true);
    expect(re!.test("whole foods 24")).toBe(false);
  });

  it("handles multiple [N] wildcards in a single pattern", () => {
    const re = renamePatternToRegExp("CHK [N] REF [N]");
    expect(re).not.toBeNull();
    expect(re!.test("chk 12 ref 34")).toBe(true);
    expect(re!.test("chk 1 ref 2")).toBe(true);
    expect(re!.test("chk 12 ref ab")).toBe(false);
  });
});

describe("matchesRenameRule", () => {
  it("matches exact rules case- and whitespace-insensitively", () => {
    expect(matchesRenameRule(rule(1, "BCF1", "BC Ferries"), "  bcf1 ")).toBe(true);
    expect(matchesRenameRule(rule(1, "BCF1", "BC Ferries"), "BCF2")).toBe(false);
  });

  it("matches pattern rules against trailing numbers", () => {
    const r = rule(1, "BCF[N]", "BC Ferries");
    expect(matchesRenameRule(r, "BCF1")).toBe(true);
    expect(matchesRenameRule(r, "BCF42")).toBe(true);
    expect(matchesRenameRule(r, "BCFX")).toBe(false);
    expect(matchesRenameRule(r, "BCF")).toBe(false);
  });

  it("matches pattern rules with multiple [N] wildcards", () => {
    const r = rule(1, "CHK [N] REF [N]", "Check Payment");
    expect(matchesRenameRule(r, "CHK 12 REF 34")).toBe(true);
    expect(matchesRenameRule(r, "chk 99 ref 100")).toBe(true);
    expect(matchesRenameRule(r, "  CHK   12   REF   34  ")).toBe(true);
    expect(matchesRenameRule(r, "CHK 12 REF AB")).toBe(false);
  });

  it("returns false for empty payees", () => {
    expect(matchesRenameRule(rule(1, "BCF1", "BC Ferries"), "   ")).toBe(false);
  });
});

describe("applyRenameRules", () => {
  it("returns the payee unchanged when no rules apply", () => {
    expect(applyRenameRules([], "BCF1")).toBe("BCF1");
    expect(
      applyRenameRules([rule(1, "BCF[N]", "BC Ferries")], "UBER TRIP")
    ).toBe("UBER TRIP");
  });

  it("applies the matching rule", () => {
    const rules = [rule(1, "BCF[N]", "BC Ferries")];
    expect(applyRenameRules(rules, "BCF1")).toBe("BC Ferries");
    expect(applyRenameRules(rules, "BCF221")).toBe("BC Ferries");
  });

  it("gives exact rules precedence over patterns", () => {
    const rules = [
      rule(1, "BCF[N]", "BC Ferries"),
      rule(2, "BCF3", "BC Ferries Downtown"),
    ];
    expect(applyRenameRules(rules, "BCF1")).toBe("BC Ferries");
    expect(applyRenameRules(rules, "BCF3")).toBe("BC Ferries Downtown");
  });

  it("gives newer rules precedence over older rules when specificity is equal", () => {
    const rules = [
      { id: 1, sourcePattern: "BCF1", targetPayee: "Old", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: 2, sourcePattern: "BCF1", targetPayee: "New", createdAt: "2026-01-02T00:00:00.000Z" },
    ];
    expect(applyRenameRules(rules, "BCF1")).toBe("New");
  });

  it("is case/whitespace-insensitive in both rule and payee", () => {
    const rules = [rule(1, "  BC FERRIES ", "BC Ferries")];
    expect(applyRenameRules(rules, "BC  FERRIES")).toBe("BC Ferries");
  });
});

describe("inferRenameRule", () => {
  it("generalises BCF1 + BCF2 into BCF[N]", () => {
    const inferred = inferRenameRule(["BCF1"], "BCF2");
    expect(inferred).toEqual({ sourcePattern: "BCF[N]" });
  });

  it("generalises case-insensitively (e.g. bcf1 + BCF2)", () => {
    const inferred = inferRenameRule(["bcf1"], "BCF2");
    expect(inferred).toEqual({ sourcePattern: "bcf[N]" });
  });

  it("refuses to generalise unrelated prefixes", () => {
    expect(inferRenameRule(["BCF1"], "UBER2")).toBeNull();
    expect(inferRenameRule(["BCF1", "BCF2"], "WHOLE FOODS #24")).toBeNull();
  });

  it("refuses to generalise when the new source has no trailing number", () => {
    expect(inferRenameRule(["BCF1"], "BCFerries")).toBeNull();
  });

  it("refuses to generalise a single source", () => {
    expect(inferRenameRule([], "BCF1")).toBeNull();
  });

  it("infers rule for '7-Eleven Store 456' with pattern '7-Eleven Store [N]'", () => {
    const inferred = inferRenameRule(["7-Eleven Store 123"], "7-Eleven Store 456");
    expect(inferred).toEqual({ sourcePattern: "7-Eleven Store [N]" });
  });

  it("clusters sources by prefix when existing sources contain diverse merchants", () => {
    const inferred = inferRenameRule(["Uber 123", "Lyft 456"], "Uber 789");
    expect(inferred).toEqual({ sourcePattern: "Uber [N]" });
  });
});

describe("learnRenameRule", () => {
  it("creates an exact rule from a single rename", () => {
    const { rules, generalised } = learnRenameRule([], "BCF1", "BC Ferries");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sourcePattern).toBe("BCF1");
    expect(rules[0]!.targetPayee).toBe("BC Ferries");
  });

  it("replaces an existing conflicting exact rule with the new target", () => {
    const existing = [rule(1, "BCF1", "Old")];
    const { rules, generalised } = learnRenameRule(existing, "BCF1", "New");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sourcePattern).toBe("BCF1");
    expect(rules[0]!.targetPayee).toBe("New");
    expect(applyRenameRules(rules as RenameRule[], "BCF1")).toBe("New");
  });

  it("generalises when a conflicting exact rule is updated to match a second target", () => {
    const existing = [
      rule(1, "BCF1", "Old"),
      rule(2, "BCF2", "New"),
    ];
    const { rules, generalised } = learnRenameRule(existing, "BCF1", "New");
    expect(generalised).toBe(true);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sourcePattern).toBe("BCF[N]");
    expect(rules[0]!.targetPayee).toBe("New");
  });

  it("removes an exact override when the payee is renamed back to the pattern target", () => {
    const existing = [
      rule(1, "BCF[N]", "BC Ferries"),
      rule(2, "BCF3", "BC Ferries Downtown"),
    ];
    const { rules, generalised } = learnRenameRule(existing, "BCF3", "BC Ferries");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sourcePattern).toBe("BCF[N]");
    expect(rules[0]!.targetPayee).toBe("BC Ferries");
    expect(applyRenameRules(rules as RenameRule[], "BCF3")).toBe("BC Ferries");
  });

  it("generalises the second rename into BCF[N] -> BC Ferries", () => {
    let { rules } = learnRenameRule([], "BCF1", "BC Ferries");
    const second = learnRenameRule(rules, "BCF2", "BC Ferries");
    expect(second.generalised).toBe(true);
    expect(second.rules).toHaveLength(1);
    expect(second.rules[0]).toMatchObject({
      sourcePattern: "BCF[N]",
      targetPayee: "BC Ferries",
    });
  });

  it("generalises renames with mixed casing (e.g. bcf1 and BCF2)", () => {
    let { rules } = learnRenameRule([], "bcf1", "BC Ferries");
    const second = learnRenameRule(rules, "BCF2", "BC Ferries");
    expect(second.generalised).toBe(true);
    expect(second.rules).toHaveLength(1);
    expect(second.rules[0]!.targetPayee).toBe("BC Ferries");
    expect(applyRenameRules(second.rules, "bcf3")).toBe("BC Ferries");
    expect(applyRenameRules(second.rules, "BCF3")).toBe("BC Ferries");
  });

  it("generalises a third rename and removes both exact rules", () => {
    let { rules } = learnRenameRule([], "BCF1", "BC Ferries");
    ({ rules } = learnRenameRule(rules, "BCF2", "BC Ferries"));
    // Force two exact rules that failed to merge before (simulated), then
    // confirm a family collapses to a single pattern.
    const preExisting = [
      rule(1, "BCF1", "BC Ferries"),
      rule(2, "BCF2", "BC Ferries"),
    ];
    const third = learnRenameRule(preExisting, "BCF3", "BC Ferries");
    expect(third.generalised).toBe(true);
    expect(third.rules).toHaveLength(1);
    expect(third.rules[0]!.sourcePattern).toBe("BCF[N]");
  });

  it("does not merge different targets", () => {
    let { rules } = learnRenameRule([], "BCF1", "BC Ferries");
    const other = learnRenameRule(rules, "BCF2", "BC Ferries Downtown");
    expect(other.generalised).toBe(false);
    expect(other.rules).toHaveLength(2);
    expect(other.rules.map((r) => r.targetPayee).sort()).toEqual([
      "BC Ferries",
      "BC Ferries Downtown",
    ]);
  });

  it("leaves rules untouched when the rename is a no-op or matches an existing rule", () => {
    const existing = [rule(1, "BCF[N]", "BC Ferries")];
    const noOp = learnRenameRule(existing, "bcf1", "BCF1");
    expect(noOp.generalised).toBe(false);
    expect(noOp.rules).toHaveLength(1);

    const alreadyCovered = learnRenameRule(existing, "BCF9", "BC Ferries");
    expect(alreadyCovered.generalised).toBe(false);
    expect(alreadyCovered.rules).toHaveLength(1);
  });

  it("generalises numbered branches like WHOLE FOODS #24/#25", () => {
    let { rules } = learnRenameRule([], "WHOLE FOODS #24", "Whole Foods");
    const second = learnRenameRule(rules, "WHOLE FOODS #25", "Whole Foods");
    expect(second.generalised).toBe(true);
    expect(second.rules[0]).toMatchObject({
      sourcePattern: "WHOLE FOODS #[N]",
      targetPayee: "Whole Foods",
    });
    expect(applyRenameRules(second.rules, "WHOLE FOODS #31")).toBe("Whole Foods");
  });

  it("clusters sources by prefix and generalises even when target has multiple diverse merchants (BUG-20)", () => {
    let { rules } = learnRenameRule([], "Uber 123", "Taxis");
    ({ rules } = learnRenameRule(rules, "Lyft 456", "Taxis"));
    const third = learnRenameRule(rules, "Uber 789", "Taxis");
    expect(third.generalised).toBe(true);
    expect(third.rules).toHaveLength(2);
    expect(third.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourcePattern: "Lyft 456", targetPayee: "Taxis" }),
        expect.objectContaining({ sourcePattern: "Uber [N]", targetPayee: "Taxis" }),
      ])
    );
    expect(applyRenameRules(third.rules, "Uber 999")).toBe("Taxis");
    expect(applyRenameRules(third.rules, "Lyft 456")).toBe("Taxis");
    expect(applyRenameRules(third.rules, "Lyft 789")).toBe("Lyft 789");
  });

  it("generalises 7-Eleven Store 123 and 7-Eleven Store 456 into 7-Eleven Store [N] without over-generalizing digits in merchant name", () => {
    let { rules } = learnRenameRule([], "7-Eleven Store 123", "7-Eleven");
    const second = learnRenameRule(rules, "7-Eleven Store 456", "7-Eleven");
    expect(second.generalised).toBe(true);
    expect(second.rules).toHaveLength(1);
    expect(second.rules[0]!.sourcePattern).toBe("7-Eleven Store [N]");
    expect(second.rules[0]!.targetPayee).toBe("7-Eleven");
    expect(applyRenameRules(second.rules, "7-Eleven Store 999")).toBe("7-Eleven");
    expect(applyRenameRules(second.rules, "11-Eleven Store 123")).toBe("11-Eleven Store 123");
  });
});

describe("isTransferPayee", () => {
  it("detects system transfer payees", () => {
    expect(isTransferPayee("Transfer : AMEX Cobalt")).toBe(true);
    expect(isTransferPayee("  transfer : savings ")).toBe(true);
    expect(isTransferPayee("TRANSFER: X")).toBe(true);
  });

  it("does not flag ordinary merchant payees", () => {
    expect(isTransferPayee("BCF1")).toBe(false);
    expect(isTransferPayee("TransferWise")).toBe(false);
    expect(isTransferPayee("Transfer")).toBe(false);
    expect(isTransferPayee("")).toBe(false);
  });
});

describe("learnRenameRule transfer guards", () => {
  it("ignores a rename from a transfer payee", () => {
    const { rules, generalised } = learnRenameRule([], "Transfer : AMEX Cobalt", "Foobar");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(0);
  });

  it("ignores a rename to a transfer payee", () => {
    const { rules, generalised } = learnRenameRule([], "BCF1", "Transfer : AMEX Cobalt");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(0);
  });

  it("ignores transfer renames case-insensitively", () => {
    const { rules, generalised } = learnRenameRule([], "  TRANSFER : Savings ", "Groceries");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(0);
  });

  it("leaves existing rules untouched when a transfer rename is attempted", () => {
    const existing = [rule(1, "BCF[N]", "BC Ferries")];
    const { rules, generalised } = learnRenameRule(existing, "Transfer : AMEX Cobalt", "BC Ferries");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ sourcePattern: "BCF[N]", targetPayee: "BC Ferries" });
  });

  it("refuses to infer a pattern from a transfer source", () => {
    expect(inferRenameRule(["Transfer : A1"], "Transfer : A2")).toBeNull();
  });
});

describe("normalizeRenameText separator folding", () => {
  it("folds bank separator punctuation to spaces", () => {
    expect(normalizeRenameText("AMZN*MKTP")).toBe("amzn mktp");
    expect(normalizeRenameText("Amzn-Mktp")).toBe("amzn mktp");
    expect(normalizeRenameText("AMZN.MKTP/US")).toBe("amzn mktp us");
  });

  it("keeps # significant so #24 never equals 24", () => {
    expect(normalizeRenameText("WHOLE FOODS #24")).toBe("whole foods #24");
    expect(normalizeRenameText("WHOLE FOODS #24")).not.toBe(
      normalizeRenameText("WHOLE FOODS 24")
    );
  });

  it("keeps [N]/[X] wildcards intact through normalisation", () => {
    expect(normalizeRenameText("BCF[N]")).toBe("bcf[n]");
    expect(normalizeRenameText("AMZN*[X]")).toBe("amzn [x]");
  });
});

describe("reference wildcard [X]", () => {
  it("builds a regex where [X] matches letter/digit runs", () => {
    const re = renamePatternToRegExp("AMZN Mktp US*[X]");
    expect(re).not.toBeNull();
    // Inputs are normalised before matching (as matchesRenameRule does).
    expect(re!.test(normalizeRenameText("amzn mktp us rt3abcd12"))).toBe(true);
    expect(re!.test(normalizeRenameText("AMZN Mktp US*XY9ZZ"))).toBe(true);
    expect(re!.test(normalizeRenameText("AMZN Mktp US*123"))).toBe(true);
    expect(re!.test(normalizeRenameText("AMZN Mktp US ****"))).toBe(false);
    expect(re!.test(normalizeRenameText("AMZN Mktp US"))).toBe(false);
  });

  it("detects [X] patterns and applies them", () => {
    expect(isPatternRule("AMZN*[X]")).toBe(true);
    expect(isPatternRule("BCF[N]")).toBe(true);
    expect(isPatternRule("BCF1")).toBe(false);
    const rules = [rule(1, "AMZN Mktp US*[X]", "Amazon")];
    expect(applyRenameRules(rules, "AMZN Mktp US*RT3ABCD12")).toBe("Amazon");
    expect(applyRenameRules(rules, "AMZN Mktp US*XY9ZZ")).toBe("Amazon");
    expect(applyRenameRules(rules, "AMZN Mktp US")).toBe("AMZN Mktp US");
  });
});

describe("inferRenameRule generalised families", () => {
  it("generalises middle numbers with a fixed suffix", () => {
    const inferred = inferRenameRule(
      ["STORE #123 - SEATTLE"],
      "STORE #456 - SEATTLE"
    );
    expect(inferred).toEqual({ sourcePattern: "STORE #[N] - SEATTLE" });
  });

  it("generalises number-like prefixes", () => {
    const inferred = inferRenameRule(["123 Main St"], "456 Main St");
    expect(inferred).toEqual({ sourcePattern: "[N] Main St" });
  });

  it("generalises bank reference codes into [X]", () => {
    const inferred = inferRenameRule(
      ["AMZN Mktp US*RT3ABCD12"],
      "AMZN Mktp US*XY9ZZ"
    );
    expect(inferred).toEqual({ sourcePattern: "AMZN Mktp US*[X]" });
  });

  it("generalises several varying runs at once", () => {
    const inferred = inferRenameRule(["CHK 12 REF 34"], "CHK 56 REF 78");
    expect(inferred).toEqual({ sourcePattern: "CHK [N] REF [N]" });
  });

  it("treats numbers as atomic (WHOLE FOODS #24 + #25 vary as 24)", () => {
    const inferred = inferRenameRule(["WHOLE FOODS #24"], "WHOLE FOODS #25");
    expect(inferred).toEqual({ sourcePattern: "WHOLE FOODS #[N]" });
    expect(
      applyRenameRules(
        [{ ...rule(1, inferred!.sourcePattern, "Whole Foods") }],
        "WHOLE FOODS #31"
      )
    ).toBe("Whole Foods");
  });

  it("refuses pure-letter variation (distinct names, not numbering)", () => {
    expect(inferRenameRule(["STORE A"], "STORE B")).toBeNull();
  });

  it("refuses a pattern that would be all wildcard", () => {
    expect(inferRenameRule(["12"], "34")).toBeNull();
  });

  it("keeps a generalisable pair when junk shares the target", () => {
    const inferred = inferRenameRule(
      ["Uber 123", "Shell 999", "Lyft 456"],
      "Uber 789"
    );
    expect(inferred).toEqual({ sourcePattern: "Uber [N]" });
  });

  it("matches punctuation variants of a generalised pattern", () => {
    const inferred = inferRenameRule(["AMZN*MKTP 12"], "AMZN*MKTP 34");
    expect(inferred).toEqual({ sourcePattern: "AMZN*MKTP [N]" });
    expect(
      applyRenameRules(
        [{ ...rule(1, inferred!.sourcePattern, "Amazon") }],
        "AMZN-MKTP 56"
      )
    ).toBe("Amazon");
  });
});

describe("learnRenameRule generalised families", () => {
  it("learns a middle-number family end to end", () => {
    let { rules } = learnRenameRule([], "STORE #123 - SEATTLE", "PCC");
    const second = learnRenameRule(rules, "STORE #456 - SEATTLE", "PCC");
    expect(second.generalised).toBe(true);
    expect(second.rules).toHaveLength(1);
    expect(second.rules[0]).toMatchObject({
      sourcePattern: "STORE #[N] - SEATTLE",
      targetPayee: "PCC",
    });
    expect(applyRenameRules(second.rules, "STORE #789 - SEATTLE")).toBe("PCC");
    expect(applyRenameRules(second.rules, "STORE #789 - TACOMA")).toBe(
      "STORE #789 - TACOMA"
    );
  });

  it("learns a reference-code family end to end", () => {
    let { rules } = learnRenameRule([], "AMZN Mktp US*RT3ABCD12", "Amazon");
    const second = learnRenameRule(rules, "AMZN Mktp US*XY9ZZ", "Amazon");
    expect(second.generalised).toBe(true);
    expect(second.rules).toHaveLength(1);
    expect(second.rules[0]!.sourcePattern).toContain("[X]");
    expect(applyRenameRules(second.rules, "AMZN Mktp US*QQ1WW")).toBe("Amazon");
  });

  it("gives newer rules precedence when [N] and [X] overlap", () => {
    const rules = [
      { ...rule(1, "AMZN [N]", "Amazon Digits"), createdAt: "2026-01-01T00:00:00.000Z" },
      { ...rule(2, "AMZN [X]", "Amazon Refs"), createdAt: "2026-01-02T00:00:00.000Z" },
    ];
    expect(applyRenameRules(rules, "AMZN 123")).toBe("Amazon Refs");
  });
});

describe("compiled rule matching", () => {
  it("matches the same payees as matchesRenameRule", () => {
    const rules = [
      rule(1, "BCF1", "BC Ferries"),
      rule(2, "BCF[N]", "BC Ferries"),
      rule(3, "AMZN Mktp US*[X]", "Amazon"),
    ];
    const compiled = compileRenameRules(rules);
    const payees = [
      "BCF1",
      "bcf1",
      "BCF9",
      "BCF10",
      "BCF1X",
      "BC Ferries",
      "AMZN Mktp US*RT3ABCD12",
      "amzn mktp us*xy9zz",
      "AMZN Mktp US*",
      "Whole Foods",
      "",
      "   ",
    ];
    for (const r of rules) {
      const c = compiled.find((x) => x.rule.id === r.id)!;
      for (const payee of payees) {
        const expected = payee.trim() ? matchesRenameRule(r, payee) : false;
        expect(matchesCompiledRule(c, normalizeRenameText(payee))).toBe(expected);
      }
    }
  });
});

describe("countRenameRuleMatches", () => {
  const rules = [
    rule(1, "BCF1", "BC Ferries"),
    rule(2, "BCF[N]", "BC Ferries"),
    rule(3, "UBER", "Uber"),
  ];

  it("counts matching rows per rule, excluding rows already at the target", () => {
    const counts = countRenameRuleMatches(rules, [
      "BCF1",
      "bcf1", // same payee, different casing — still counts
      "BCF9",
      "BC Ferries", // already at the target — excluded
      "UBER TRIP", // no rule matches
      "",
    ]);
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(3);
    expect(counts.get(3)).toBe(0);
  });

  it("returns zero counts for every rule when nothing matches", () => {
    const counts = countRenameRuleMatches(rules, ["Whole Foods"]);
    expect(counts.get(1)).toBe(0);
    expect(counts.get(2)).toBe(0);
    expect(counts.get(3)).toBe(0);
  });
});

describe("renameRulePayeeFilter", () => {
  it("returns the source itself for exact rules", () => {
    expect(renameRulePayeeFilter("BCF1")).toBe("BCF1");
    expect(renameRulePayeeFilter("  AMZN Mktp  ")).toBe("AMZN Mktp");
  });

  it("returns the longest literal fragment for pattern rules", () => {
    expect(renameRulePayeeFilter("BCF[N]")).toBe("BCF");
    expect(renameRulePayeeFilter("AMZN Mktp US*[X]")).toBe("AMZN Mktp US*");
    expect(renameRulePayeeFilter("STORE #[N] - SEATTLE")).toBe("- SEATTLE");
  });

  it("returns null when there is no literal text to filter on", () => {
    expect(renameRulePayeeFilter("")).toBeNull();
    expect(renameRulePayeeFilter("   ")).toBeNull();
    expect(renameRulePayeeFilter("[N]")).toBeNull();
    expect(renameRulePayeeFilter("[N][X]")).toBeNull();
  });
});
