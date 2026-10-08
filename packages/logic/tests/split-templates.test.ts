import { describe, expect, it } from "vitest";
import {
  applySplitTemplate,
  resolveSplitTemplatePresets,
  SPLIT_TEMPLATE_PRESETS,
  validateSplitTemplate,
  type SplitTemplateLeg,
  type SplitTemplatePreset,
} from "../src/split-templates.js";

const susieTemplate: SplitTemplateLeg[] = [
  { kind: "category", categoryId: 7, transferAccountId: null, shareBps: 8500 },
  { kind: "transfer", categoryId: null, transferAccountId: 3, shareBps: 1500 },
];

describe("validateSplitTemplate", () => {
  it("accepts the 85/15 cost-share template", () => {
    expect(validateSplitTemplate("Susie 85/15", susieTemplate)).toBeNull();
  });

  it("rejects an empty name", () => {
    expect(validateSplitTemplate("  ", susieTemplate)).toBe("Template name is required");
  });

  it("rejects fewer than two legs", () => {
    expect(validateSplitTemplate("x", [susieTemplate[0]!])).toBe(
      "Template must have at least two legs"
    );
  });

  it("rejects shares that do not add to 100%", () => {
    const legs = susieTemplate.map((l) => ({ ...l, shareBps: 4000 }));
    expect(validateSplitTemplate("x", legs)).toContain("100%");
  });

  it("accepts a category leg without a preset category (chosen when applying)", () => {
    const legs: SplitTemplateLeg[] = [
      { kind: "category", categoryId: null, transferAccountId: null, shareBps: 8500 },
      { kind: "transfer", categoryId: null, transferAccountId: 3, shareBps: 1500 },
    ];
    expect(validateSplitTemplate("x", legs)).toBeNull();
  });

  it("rejects a transfer target on a category leg", () => {
    const legs: SplitTemplateLeg[] = [
      { kind: "category", categoryId: 7, transferAccountId: 3, shareBps: 5000 },
      { kind: "transfer", categoryId: null, transferAccountId: 3, shareBps: 5000 },
    ];
    expect(validateSplitTemplate("x", legs)).toBe("Leg 1 must not have a transfer account");
  });

  it("rejects a transfer leg without an account", () => {
    const legs: SplitTemplateLeg[] = [
      { kind: "category", categoryId: 7, transferAccountId: null, shareBps: 5000 },
      { kind: "transfer", categoryId: 9, transferAccountId: null, shareBps: 5000 },
    ];
    expect(validateSplitTemplate("x", legs)).toBe("Leg 2 must have a transfer account");
  });

  it("accepts a boundary category on a transfer leg", () => {
    const legs: SplitTemplateLeg[] = [
      { kind: "category", categoryId: 7, transferAccountId: null, shareBps: 8500 },
      { kind: "transfer", categoryId: 7, transferAccountId: 3, shareBps: 1500 },
    ];
    expect(validateSplitTemplate("x", legs)).toBeNull();
  });
});

describe("applySplitTemplate", () => {
  it("splits $100.00 into 85/15 with a transfer leg", () => {
    const legs = applySplitTemplate(-10000, susieTemplate);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ categoryId: 7, transferAccountId: null, amount: -8500 });
    expect(legs[1]).toMatchObject({ categoryId: null, transferAccountId: 3, amount: -1500 });
  });

  it("absorbs penny rounding in the last leg so children sum to the parent", () => {
    // 85% of $10.01 = $8.5085 -> $8.51; remainder $1.50 keeps the sum exact.
    const legs = applySplitTemplate(-1001, susieTemplate);
    const sum = legs.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBe(-1001);
    expect(legs[0]!.amount).toBe(-851);
    expect(legs[1]!.amount).toBe(-150);
  });

  it("mirrors the sign for inflows", () => {
    const legs = applySplitTemplate(10000, susieTemplate);
    expect(legs.map((l) => l.amount)).toEqual([8500, 1500]);
  });

  it("passes a boundary category through on transfer legs", () => {
    const legs = applySplitTemplate(-10000, [
      { kind: "category", categoryId: 7, transferAccountId: null, shareBps: 8500 },
      { kind: "transfer", categoryId: 7, transferAccountId: 3, shareBps: 1500 },
    ]);
    expect(legs[1]).toMatchObject({ categoryId: 7, transferAccountId: 3, amount: -1500 });
  });

  it("keeps three-way splits balanced", () => {
    const three: SplitTemplateLeg[] = [
      { kind: "category", categoryId: 1, transferAccountId: null, shareBps: 3333 },
      { kind: "category", categoryId: 2, transferAccountId: null, shareBps: 3333 },
      { kind: "category", categoryId: 3, transferAccountId: null, shareBps: 3334 },
    ];
    const legs = applySplitTemplate(-100, three);
    expect(legs.reduce((s, l) => s + l.amount, 0)).toBe(-100);
  });

  it("throws on a zero total and on invalid templates", () => {
    expect(() => applySplitTemplate(0, susieTemplate)).toThrow();
    expect(() => applySplitTemplate(-100, [susieTemplate[0]!])).toThrow();
  });
});

describe("resolveSplitTemplatePresets", () => {
  const accounts = [
    { id: 1, name: "Chequing" },
    { id: 4, name: "Susie" },
  ];

  it("resolves the shipped preset against budget accounts", () => {
    const [template] = resolveSplitTemplatePresets(SPLIT_TEMPLATE_PRESETS, accounts);
    expect(template).toMatchObject({ id: 1, name: "Susie 85/15" });
    expect(template!.legs).toEqual([
      { kind: "category", categoryId: null, transferAccountId: null, shareBps: 8500 },
      { kind: "transfer", categoryId: null, transferAccountId: 4, shareBps: 1500 },
    ]);
  });

  it("leaves transfer legs unassigned when the account name is missing", () => {
    const presets: SplitTemplatePreset[] = [
      {
        name: "Someone 50/50",
        legs: [
          { kind: "category", shareBps: 5000 },
          { kind: "transfer", transferAccountName: "Nobody", shareBps: 5000 },
        ],
      },
    ];
    const [template] = resolveSplitTemplatePresets(presets, accounts);
    expect(template!.legs[1]).toMatchObject({ kind: "transfer", transferAccountId: null });
    expect(validateSplitTemplate(template!.name, template!.legs)).toBe(
      "Leg 2 must have a transfer account"
    );
  });

  it("assigns stable ids in preset order", () => {
    const presets: SplitTemplatePreset[] = [
      { name: "A", legs: [{ kind: "category", shareBps: 5000 }, { kind: "category", shareBps: 5000 }] },
      { name: "B", legs: [{ kind: "category", shareBps: 5000 }, { kind: "category", shareBps: 5000 }] },
    ];
    const [a, b] = resolveSplitTemplatePresets(presets, accounts);
    expect([a!.id, b!.id]).toEqual([1, 2]);
  });
});

describe("applySplitTemplate with an unset category", () => {
  it("leaves the leg unassigned so the editor picks the category", () => {
    const legs = applySplitTemplate(-10000, [
      { kind: "category", categoryId: null, transferAccountId: null, shareBps: 8500 },
      { kind: "transfer", categoryId: null, transferAccountId: 3, shareBps: 1500 },
    ]);
    expect(legs[0]).toMatchObject({ categoryId: null, transferAccountId: null, amount: -8500 });
    expect(legs[1]).toMatchObject({ categoryId: null, transferAccountId: 3, amount: -1500 });
  });
});
