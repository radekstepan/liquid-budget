import { describe, expect, it } from "vitest";
import * as RegisterModule from "../src/TransactionsView.js";

// Export-surface contract for the TransactionsView module: the god file is
// being split into src/transactions/* with TransactionsView.tsx kept as the
// component + re-export surface. BudgetApp, index.ts, and the register
// suites import these names from the original path, so the split must keep
// every one resolving here.
describe("TransactionsView module surface", () => {
  it("keeps every value export resolving from the original path", () => {
    const surface = RegisterModule as Record<string, unknown>;
    expect(typeof surface["TransactionsView"]).toBeDefined();
    expect(surface["SCHEDULED_HEIGHT_STORAGE_KEY"]).toBe(
      "ynab:transactions:scheduledHeight"
    );
    expect(typeof surface["isScheduledHeights"]).toBe("function");
  });
});
