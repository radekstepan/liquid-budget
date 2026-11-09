import { describe, expect, it } from "vitest";
import * as Modals from "../src/Modals.js";

// Export-surface contract for the Modals barrel: Modals.tsx was split into
// src/modals/* with Modals.tsx kept as a barrel, and every consumer
// (BudgetApp, index.ts, the modal test suites) still imports from the
// original path. This locks that surface so a move can't silently drop
// an export. (Type-only exports are covered by typecheck: BudgetApp
// imports TransactionSavePayload/RecurringSavePayload types from here.)
describe("Modals barrel", () => {
  it("re-exports every modal from the original path", () => {
    const surface = Modals as Record<string, unknown>;
    for (const name of [
      "TransactionModal",
      "CategoryModal",
      "GroupModal",
      "RecurringModal",
      "AccountModal",
      "BulkEditTransactionsModal",
    ] as const) {
      expect(typeof surface[name], name).toBe("function");
    }
  });
});
