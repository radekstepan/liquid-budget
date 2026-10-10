import { describe, expect, it } from "vitest";
import {
  createPrivacyMask,
  isPrivacyFactor,
  maskBudgetData,
  maskReconcileState,
  maskRenameSuggestResponse,
  maskRenameSuggestStatus,
  scaleMaskedAmount,
  makeSeedBudgetData,
  PRIVACY_ACCOUNT_NAMES,
  PRIVACY_PAYEE_NAMES,
} from "../src/index.js";

/** Pool entry, with or without the overflow " N" suffix. */
function isPayeeMask(name: string): boolean {
  return PRIVACY_PAYEE_NAMES.some(
    (p) => name === p || name.startsWith(`${p} `)
  );
}

function isAccountMask(name: string): boolean {
  return PRIVACY_ACCOUNT_NAMES.some(
    (p) => name === p || name.startsWith(`${p} `)
  );
}

describe("scaleMaskedAmount", () => {
  it("scales by the factor and rounds to cents", () => {
    expect(scaleMaskedAmount(10000, 0.5)).toBe(5000);
    expect(scaleMaskedAmount(10001, 0.5)).toBe(5001);
    expect(scaleMaskedAmount(-250, 2)).toBe(-500);
  });

  it("keeps zero at zero and preserves signs", () => {
    expect(scaleMaskedAmount(0, 3.7)).toBe(0);
    expect(scaleMaskedAmount(-0, 3.7)).toBe(0);
    const up = scaleMaskedAmount(-123, 0.05);
    expect(up).toBeLessThan(0);
    const down = scaleMaskedAmount(123, 0.05);
    expect(down).toBeGreaterThan(0);
  });

  it("keeps non-zero amounts non-zero (clamps to a cent)", () => {
    expect(scaleMaskedAmount(1, 0.05)).toBe(1);
    expect(scaleMaskedAmount(-1, 0.05)).toBe(-1);
  });
});

describe("isPrivacyFactor", () => {
  it("accepts finite factors inside the bounds", () => {
    expect(isPrivacyFactor(1)).toBe(true);
    expect(isPrivacyFactor(0.05)).toBe(true);
    expect(isPrivacyFactor(20)).toBe(true);
  });

  it("rejects junk", () => {
    expect(isPrivacyFactor(0)).toBe(false);
    expect(isPrivacyFactor(-1)).toBe(false);
    expect(isPrivacyFactor(21)).toBe(false);
    expect(isPrivacyFactor(Number.NaN)).toBe(false);
    expect(isPrivacyFactor("2")).toBe(false);
    expect(isPrivacyFactor(null)).toBe(false);
  });
});

describe("createPrivacyMask", () => {
  it("maps payees deterministically to distinct pool names", () => {
    const data = makeSeedBudgetData();
    const a = createPrivacyMask(data, 2);
    const b = createPrivacyMask(data, 2);
    const names = [...new Set(data.transactions.map((t) => t.payee))]
      .filter(Boolean)
      .sort();
    expect(names.length).toBeGreaterThan(1);
    const masked = names.map((name) => a.maskPayee(name));
    // Distinct realistic names, none of them the original.
    expect(new Set(masked).size).toBe(masked.length);
    for (const m of masked) {
      expect(isPayeeMask(m)).toBe(true);
      expect(names).not.toContain(m);
    }
    // Stable across mask instances.
    names.forEach((name) => {
      expect(b.maskPayee(name)).toBe(a.maskPayee(name));
    });
    // Same mapping covers recurring, payee rows, and rules.
    for (const r of data.recurring) {
      if (r.payee) expect(isPayeeMask(a.maskPayee(r.payee))).toBe(true);
    }
  });

  it("keeps empty payees empty and gives stable fallbacks for unknowns", () => {
    const data = makeSeedBudgetData();
    const a = createPrivacyMask(data, 2);
    expect(a.maskPayee("")).toBe("");
    const unknown = "No Such Payee 《xyz》";
    expect(isPayeeMask(a.maskPayee(unknown))).toBe(true);
    expect(createPrivacyMask(data, 2).maskPayee(unknown)).toBe(
      a.maskPayee(unknown)
    );
  });

  it("maps accounts by id order with a deterministic fallback", () => {
    const data = makeSeedBudgetData();
    const mask = createPrivacyMask(data, 2);
    const ids = data.accounts.map((a) => a.id).sort((x, y) => x - y);
    const masked = ids.map((id) => mask.maskAccountName(id));
    expect(new Set(masked).size).toBe(masked.length);
    for (const m of masked) expect(isAccountMask(m)).toBe(true);
    // Id order drives pool order; the pool cycles with a suffix past its end.
    expect(mask.maskAccountName(ids[0]!)).toBe(PRIVACY_ACCOUNT_NAMES[0]);
    expect(isAccountMask(mask.maskAccountName(999999))).toBe(true);
  });

  it("falls back to factor 1 for invalid factors", () => {
    const data = makeSeedBudgetData();
    expect(createPrivacyMask(data, 0).scaleAmount(100)).toBe(100);
    expect(createPrivacyMask(data, Number.NaN).scaleAmount(100)).toBe(100);
  });
});

describe("maskBudgetData", () => {
  it("scales amounts, replaces names, and blanks memos/notes", () => {
    const data = makeSeedBudgetData();
    const mask = createPrivacyMask(data, 0.5);
    const masked = maskBudgetData(data, mask);

    const txn = data.transactions.find((t) => t.payee && t.amount !== "0")!;
    const maskedTxn = masked.transactions.find((t) => t.id === txn.id)!;
    expect(maskedTxn.payee).toBe(mask.maskPayee(txn.payee));
    expect(maskedTxn.payee).not.toBe(txn.payee);
    expect(maskedTxn.memo).toBe("");
    expect(maskedTxn.amount).toBe(String(Math.round(Number(txn.amount) * 0.5)));

    const account = data.accounts[0]!;
    const maskedAccount = masked.accounts.find((a) => a.id === account.id)!;
    expect(maskedAccount.name).toBe(mask.maskAccountName(account.id));
    expect(isAccountMask(maskedAccount.name)).toBe(true);
    expect(maskedAccount.balance).toBe(
      String(Math.round(Number(account.balance) * 0.5))
    );
    expect(maskedAccount.notes).toBeNull();

    const assignment = data.assignments.find((a) => a.amount !== "0")!;
    const maskedAssignment = masked.assignments.find(
      (a) => a.id === assignment.id
    )!;
    expect(maskedAssignment.amount).toBe(
      String(Math.round(Number(assignment.amount) * 0.5))
    );
  });

  it("preserves ids, dates, statuses, categories, and groups", () => {
    const data = makeSeedBudgetData();
    const masked = maskBudgetData(data, createPrivacyMask(data, 3));
    expect(masked.transactions.map((t) => t.id)).toEqual(
      data.transactions.map((t) => t.id)
    );
    expect(masked.transactions.map((t) => t.date)).toEqual(
      data.transactions.map((t) => t.date)
    );
    expect(masked.transactions.map((t) => t.status)).toEqual(
      data.transactions.map((t) => t.status)
    );
    expect(masked.categories.map((c) => c.name)).toEqual(
      data.categories.map((c) => c.name)
    );
    expect(masked.groups).toEqual(data.groups);
    // Category amounts still scale.
    expect(masked.categories.map((c) => c.carryover)).toEqual(
      data.categories.map((c) => String(scaleMaskedAmount(Number(c.carryover), 3)))
    );
  });

  it("drops the precomputed budget index and does not mutate the input", () => {
    const data = makeSeedBudgetData();
    const before = JSON.stringify(data);
    const masked = maskBudgetData(data, createPrivacyMask(data, 2));
    expect(masked.budgetIndex).toBeUndefined();
    expect(JSON.stringify(data)).toBe(before);
  });

  it("masks recurring rows, splits, rules, and payee rows consistently", () => {
    const data = makeSeedBudgetData();
    const mask = createPrivacyMask(data, 2);
    const masked = maskBudgetData(data, mask);
    for (const r of masked.recurring) {
      const orig = data.recurring.find((x) => x.id === r.id)!;
      expect(r.payee).toBe(mask.maskPayee(orig.payee));
      expect(r.memo ?? "").toBe("");
      for (const s of r.subTransactions) {
        expect(s.memo).toBe("");
      }
    }
    for (const rule of masked.renameRules ?? []) {
      expect(isPayeeMask(rule.sourcePattern)).toBe(true);
      expect(isPayeeMask(rule.targetPayee)).toBe(true);
    }
    for (const p of masked.payees ?? []) {
      expect(isPayeeMask(p.name)).toBe(true);
    }
  });
});

describe("read-result masks", () => {
  it("masks suggest-status candidates", () => {
    const data = makeSeedBudgetData();
    const mask = createPrivacyMask(data, 2);
    const payee = data.transactions.find((t) => t.payee)!.payee;
    const out = maskRenameSuggestStatus(
      {
        enabled: true,
        candidates: [{ payee, count: 3 }],
        totalUnique: 1,
        truncated: false,
      },
      mask
    );
    expect(out.candidates[0]!.payee).toBe(mask.maskPayee(payee));
    expect(out.candidates[0]!.count).toBe(3);
    expect(out.totalUnique).toBe(1);
  });

  it("masks suggestions, evidence memos, and skipped sources", () => {
    const data = makeSeedBudgetData();
    const mask = createPrivacyMask(data, 2);
    const payee = data.transactions.find((t) => t.payee)!.payee;
    const out = maskRenameSuggestResponse(
      {
        suggestions: [
          {
            sourcePattern: payee,
            targetPayee: payee,
            count: 2,
            memos: ["lunch tewksbury"],
          },
        ],
        skipped: [{ source: payee, reason: "too short" }],
        model: "test-model",
        processed: 1,
      },
      mask
    );
    expect(out.suggestions[0]!.sourcePattern).toBe(mask.maskPayee(payee));
    expect(out.suggestions[0]!.targetPayee).toBe(mask.maskPayee(payee));
    expect(out.suggestions[0]!.memos).toEqual([""]);
    expect(out.skipped[0]!.source).toBe(mask.maskPayee(payee));
    expect(out.skipped[0]!.reason).toBe("too short");
    expect(out.model).toBe("test-model");
  });

  it("masks reconcile state names and balances but keeps counts", () => {
    const data = makeSeedBudgetData();
    const mask = createPrivacyMask(data, 0.5);
    const accountId = data.accounts[0]!.id;
    const out = maskReconcileState(
      {
        accountId,
        accountName: "Real Name",
        workingBalance: 10001,
        unclearedTotal: -250,
        unclearedCount: 2,
        clearedCount: 5,
        reconciledCount: 9,
        lastReconciledAt: "2026-01-01",
        lastReconciledBalance: 100,
      },
      mask
    );
    expect(out.accountName).toBe(mask.maskAccountName(accountId));
    expect(out.workingBalance).toBe(5001);
    expect(out.unclearedTotal).toBe(-125);
    expect(out.lastReconciledBalance).toBe(50);
    expect(out.unclearedCount).toBe(2);
    expect(out.lastReconciledAt).toBe("2026-01-01");
  });
});
