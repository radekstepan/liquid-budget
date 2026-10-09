import { describe, expect, it } from "vitest";
import { buildPageTitle } from "../src/page-title.js";

describe("buildPageTitle", () => {
  it("labels the budget view with its month", () => {
    expect(buildPageTitle("budget", { month: "2026-10" })).toBe(
      "October 2026 Budget - Liquid"
    );
  });

  it("omits a missing or invalid budget month", () => {
    expect(buildPageTitle("budget")).toBe("Budget - Liquid");
    expect(buildPageTitle("budget", { month: "not-a-month" })).toBe(
      "Budget - Liquid"
    );
  });

  it("labels a filtered register with the account name", () => {
    expect(
      buildPageTitle("transactions", { accountName: "TD Unlimited Chequing" })
    ).toBe("TD Unlimited Chequing Transactions - Liquid");
  });

  it("labels the unfiltered register without an account", () => {
    expect(buildPageTitle("transactions")).toBe("All Transactions - Liquid");
    expect(buildPageTitle("transactions", { accountName: "  " })).toBe(
      "All Transactions - Liquid"
    );
  });

  it("labels the reports view", () => {
    expect(buildPageTitle("reports")).toBe("Reports - Liquid");
  });
});
