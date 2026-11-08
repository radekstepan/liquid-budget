import { describe, expect, it } from "vitest";
import { applySplitTemplate, type SplitTemplateLeg } from "../src/split-templates.js";

// Regression: YNAB4 split penny leg (RegisterGrid.as:322-348,337-347):
// the penny remainder goes to the LARGEST leg, so 100c in 3 equal shares
// -> [34, 33, 33]. Fix commit: 61d159c (g-split-penny).
describe("ynab4 parity: YNAB4 split penny leg (RegisterGrid.as:337-347)", () => {
  it("assigns the penny remainder largest-first: 100c / 3 -> [34,33,33]", () => {
    const legs: SplitTemplateLeg[] = [
      { kind: "category", categoryId: 1, transferAccountId: null, shareBps: 3334 },
      { kind: "category", categoryId: 2, transferAccountId: null, shareBps: 3333 },
      { kind: "category", categoryId: 3, transferAccountId: null, shareBps: 3333 },
    ];
    const applied = applySplitTemplate(100, legs);
    expect(applied.map((l) => l.amount)).toEqual([34, 33, 33]);
  });
});
