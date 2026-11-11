import { describe, expect, it } from "vitest";
import { monthKey, type CategoryGroup } from "@ynab/logic";
import {
  formatMonthLong,
  balanceColor,
  isInternalGroup,
  isHiddenGroup,
  COL_A,
  COL_O,
  COL_V,
} from "../src/budgetViewHelpers.js";

function group(overrides: Partial<CategoryGroup> = {}): CategoryGroup {
  return {
    id: 1,
    name: "Everyday",
    sort: 0,
    isCreditCardPayments: false,
    ...overrides,
  };
}

describe("budgetViewHelpers (ui-split slice 1)", () => {
  it("formatMonthLong renders short month + year", () => {
    expect(formatMonthLong(monthKey(2024, 0))).toBe("Jan 2024");
    expect(formatMonthLong(monthKey(2025, 11))).toBe("Dec 2025");
  });

  it("balanceColor maps sign to theme tokens", () => {
    expect(balanceColor(1)).toBe("var(--y-green-dk)");
    expect(balanceColor(-1)).toBe("var(--y-red)");
    expect(balanceColor(0)).toBe("var(--y-ink-faint)");
  });

  it("isInternalGroup matches the __Internal__ sentinel case-insensitively", () => {
    expect(isInternalGroup("__Internal__")).toBe(true);
    expect(isInternalGroup("__internal__")).toBe(true);
    expect(isInternalGroup(group({ name: "__Internal__" }))).toBe(true);
    expect(isInternalGroup("Everyday")).toBe(false);
    expect(isInternalGroup(group())).toBe(false);
  });

  it("isHiddenGroup prefers the isHidden flag, falls back to the name", () => {
    expect(isHiddenGroup(group({ isHidden: true, name: "Other" }))).toBe(true);
    expect(isHiddenGroup(group({ isHidden: false, name: "Hidden Categories" }))).toBe(false);
    expect(isHiddenGroup(group({ name: "Hidden Categories" }))).toBe(true);
    expect(isHiddenGroup(group({ name: "hidden categories" }))).toBe(true);
    expect(isHiddenGroup("Hidden Categories")).toBe(true);
    expect(isHiddenGroup(group())).toBe(false);
    expect(isHiddenGroup("Everyday")).toBe(false);
  });

  it("column widths stay uniform", () => {
    expect([COL_A, COL_O, COL_V]).toEqual(["w-[120px]", "w-[120px]", "w-[120px]"]);
  });
});
