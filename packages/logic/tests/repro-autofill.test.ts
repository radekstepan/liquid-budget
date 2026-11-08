/**
 * Regression: payee amount/memo autofill recall.
 *
 * Pins YNAB4 behaviour (AutoFillData.as:110-164, RegisterGrid.as:815/843/871,
 * RowRenderer.as:1977-1983, Transaction.as:172-207, PayeeManager.as:346-353):
 * typing a known payee on a blank row proposes amount + memo from history,
 * via `suggestAutofillForPayee` generalizing `lastCategoryForPayee`.
 *
 * Fix commit: 82e267d (g-autofill).
 */
import { describe, expect, it } from "vitest";
import * as register from "../src/register.js";
import { suggestAutofillForPayee } from "../src/payee-autofill.js";
import type { Transaction } from "../src/types.js";

describe("ynab4 parity: payee amount/memo autofill", () => {
  it("exposes an amount/memo recall helper generalizing lastCategoryForPayee", () => {
    const mod = register as unknown as Record<string, unknown>;
    const helper =
      mod["suggestAutofillForPayee"] ?? mod["lastAmountForPayee"] ?? mod["autofillForPayee"];
    // No such export previously — only Payee.autoCategoryId existed (types.ts:164).
    expect(typeof helper).toBe("function");
  });

  it("payee with consistent $12.50 history -> blank-row proposal is $12.50", () => {
    const history: Transaction[] = [1, 2, 3].map((i) => ({
      id: i,
      accountId: 1,
      categoryId: 100,
      date: `2026-08-0${i}`,
      payee: "Corner Deli",
      memo: "lunch",
      amount: "-1250",
      status: "c" as const,
      transferAccountId: null,
      parentId: null,
    }));
    // A blank row for a known payee proposes the most recent amount/memo.
    // Expected YNAB4 behaviour: amount "-1250", memo "lunch".
    const proposal = suggestAutofillForPayee(history, "Corner Deli");
    expect(proposal?.amount).toBe("-1250");
    expect(proposal?.memo).toBe("lunch");
  });
});
