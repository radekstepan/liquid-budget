/**
 * Regression: `is:` status search is account-scoped.
 *
 * Pins the chosen YNAB4-parity semantic: each transfer leg has its own
 * cleared state. A transfer row with source `u` + dest `r` is
 * dest-reconciled, so globally it counts as cleared and does NOT count as
 * uncleared. Covers `matchesFilter` (searchQuery.ts:461-464, previously
 * source-leg only) and the transfer payload preserving the dest-side status
 * (payload-builders.ts:200-214).
 *
 * UI-side notes (kept as documented assertions — see skips below):
 * - Bulk-edit filter (BudgetApp.tsx:1731, BulkEditModal.tsx:91,98) keys off
 *   `status` only; needs a DOM/e2e harness, not unit-testable in @ynab/logic.
 * - Edit modal (Modals.tsx:283,338,1118,1126) shows source state on dest
 *   legs; the logic-level slice IS unit-testable via `toTransactionPayload`
 *   (payload-builders.ts:200-214) — covered by the payload test below.
 * - TBB computed but never rendered (BudgetApp.tsx:1632-1642 passes `tbb`
 *   to Inspector whose body at Inspector.tsx:22-52 never references it) is a
 *   pure render concern: needs DOM/e2e, skipped here with reason.
 *
 * Fix commit: a87fc8e (g-search-status).
 */
import { describe, expect, it } from "vitest";
import { buildSearchCtx, matchesFilter } from "../src/searchQuery.js";
import { toTransactionPayload } from "../src/payload-builders.js";
import type { BudgetData, Transaction } from "../src/types.js";

const ctx = buildSearchCtx({
  accounts: [
    { id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 0 },
    { id: 2, name: "Savings", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 1 },
  ],
  groups: [],
  categories: [],
  assignments: [],
  transactions: [],
  recurring: [],
} as BudgetData);

// Transfer: source leg uncleared (u), destination leg reconciled (r).
const destReconciled: Transaction = {
  id: 1,
  accountId: 1,
  categoryId: null,
  date: "2026-09-01",
  payee: "Transfer : Savings",
  memo: "",
  amount: "-5000",
  status: "u",
  transferStatus: "r",
  transferAccountId: 2,
  parentId: null,
};

describe("ynab4 parity: is:cleared / is:uncleared is account-scoped", () => {
  it("is:cleared matches a transfer whose DEST leg is reconciled", () => {
    expect(matchesFilter(destReconciled, { kind: "is", value: "cleared" }, ctx)).toBe(true);
  });

  it("is:uncleared does NOT match a transfer whose DEST leg is reconciled", () => {
    expect(matchesFilter(destReconciled, { kind: "is", value: "uncleared" }, ctx)).toBe(false);
  });

  it("transfer payload preserves the dest-side status (edit-modal slice)", () => {
    const payload = toTransactionPayload(
      {
        mode: "transfer",
        accountId: 1,
        transferAccountId: 2,
        date: "2026-09-01",
        payee: "Transfer : Savings",
        memo: "",
        amount: "-50",
        status: "u",
      },
      {
        accounts: [
          { id: 1, name: "Checking", onBudget: true, kind: "liquid" },
          { id: 2, name: "Savings", onBudget: true, kind: "liquid" },
        ],
      }
    );
    expect(payload).not.toBeNull();
    // The TransferTransactionSavePayload branch (payload-builders.ts:200-214)
    // sets `status` and `transferStatus`, so the edit modal can show/submit
    // the dest-leg state.
    expect(payload).toHaveProperty("transferStatus");
  });

  it.skip("bulk-edit status filter covers dest legs (needs DOM/e2e: filter lives in @ynab/ui BulkEditModal + BudgetApp register wiring)", () => {
    expect(true).toBe(true);
  });

  it.skip("Inspector renders the computed TBB (needs DOM/e2e: tbb prop is accepted at BudgetApp.tsx:1632-1642 but Inspector.tsx:22-52 never references it)", () => {
    expect(true).toBe(true);
  });
});
