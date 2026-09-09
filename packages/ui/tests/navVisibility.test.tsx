import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAV_VISIBILITY,
  NAV_ORDER,
  firstAvailableView,
  isNavVisibility,
  visibleViewCount,
} from "../src/navVisibility.js";

describe("navVisibility", () => {
  it("covers every sidebar view exactly once, transactions included", () => {
    expect([...NAV_ORDER].sort()).toEqual(
      ["budget", "reports", "transactions"].sort()
    );
  });

  it("firstAvailableView returns the first visible view in menu order", () => {
    expect(firstAvailableView(DEFAULT_NAV_VISIBILITY)).toBe("budget");
    expect(firstAvailableView({ ...DEFAULT_NAV_VISIBILITY, budget: false })).toBe("reports");
    expect(
      firstAvailableView({ ...DEFAULT_NAV_VISIBILITY, budget: false, reports: false })
    ).toBe("transactions");
  });

  it("firstAvailableView returns null when everything is hidden", () => {
    expect(
      firstAvailableView({
        budget: false,
        reports: false,
        transactions: false,
      })
    ).toBeNull();
  });

  it("visibleViewCount counts enabled views", () => {
    expect(visibleViewCount(DEFAULT_NAV_VISIBILITY)).toBe(3);
    expect(visibleViewCount({ ...DEFAULT_NAV_VISIBILITY, budget: false })).toBe(2);
  });

  it("isNavVisibility validates stored records", () => {
    expect(isNavVisibility(DEFAULT_NAV_VISIBILITY)).toBe(true);
    expect(isNavVisibility({})).toBe(false);
    expect(isNavVisibility(null)).toBe(false);
    expect(isNavVisibility([])).toBe(false);
    expect(isNavVisibility({ ...DEFAULT_NAV_VISIBILITY, budget: "yes" })).toBe(false);
  });
});
