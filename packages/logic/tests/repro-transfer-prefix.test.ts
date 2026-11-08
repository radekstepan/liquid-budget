import { describe, expect, it } from "vitest";
import { isTransferPayee } from "../src/rename-rules.js";

// Regression: YNAB4 transfer-prefix (TransferUtilities.as:81-90): strip ALL
// spaces then match /^transfer:/i — so "Trans fer : X" is a transfer,
// "Transfer\t: X" is not (tab is not stripped, only spaces).
// Fix commit: e8ccbb9 (g-transfer-prefix).
describe("ynab4 parity: YNAB4 transfer-prefix (TransferUtilities.as:81-90)", () => {
  it("treats 'Trans fer : X' as a transfer (spaces stripped before match)", () => {
    expect(isTransferPayee("Trans fer : X")).toBe(true);
  });

  it("does NOT treat 'Transfer\\t: X' as a transfer (YNAB4 strips spaces only)", () => {
    expect(isTransferPayee("Transfer\t: X")).toBe(false);
  });
});
