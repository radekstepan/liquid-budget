import { describe, expect, it } from "vitest";
import {
  applyRenameRules,
  inferRenameRule,
  learnRenameRule,
  matchesRenameRule,
  normalizeRenameText,
  renamePatternToRegExp,
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
});

describe("learnRenameRule", () => {
  it("creates an exact rule from a single rename", () => {
    const { rules, generalised } = learnRenameRule([], "BCF1", "BC Ferries");
    expect(generalised).toBe(false);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sourcePattern).toBe("BCF1");
    expect(rules[0]!.targetPayee).toBe("BC Ferries");
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
});
