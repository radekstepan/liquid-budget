import { describe, expect, it } from "vitest";
import * as SpendingReportModule from "../src/SpendingReport.js";

// Export-surface contract for the SpendingReport module: the god file is
// being split into src/spending/* with SpendingReport.tsx kept as the
// component + re-export surface. ReportsView, ExpenseBreakdownReport, and
// the report suites import these names from the original path, so the
// split must keep every one resolving here. (Type-only exports are
// covered by typecheck via those same importers.)
describe("SpendingReport module surface", () => {
  it("keeps every value export resolving from the original path", () => {
    const surface = SpendingReportModule as Record<string, unknown>;
    expect(typeof surface["SpendingReport"]).toBe("function");
    for (const name of [
      "SANKEY_AUTOFIT_SESSION_KEY",
      "SANKEY_BUCKET_HATCH_ID",
      "SANKEY_INCOME_GRADIENT_ID_PREFIX",
      "SANKEY_MIDDLE_GRADIENT_ID_PREFIX",
      "SANKEY_RIBBON_DIM_OPACITY",
      "SANKEY_RIBBON_HOVER_OPACITY",
      "SANKEY_RIBBON_OPACITY",
      "SANKEY_SPOTLIGHT_TRANSITION_MS",
      "SOURCE_AMOUNT_PX_PER_CHAR",
      "SOURCE_NAME_PX_PER_CHAR",
    ] as const) {
      expect(surface[name], name).toBeDefined();
    }
  });
});
