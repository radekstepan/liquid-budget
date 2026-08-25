import { describe, expect, it } from "vitest";
import { makeSeedBudgetData, DEMO_MONTH } from "../src/seed-fixture.js";

describe("seed fixture", () => {
  it("returns a fully-populated BudgetData", () => {
    const d = makeSeedBudgetData();
    expect(d.accounts.length).toBeGreaterThan(0);
    expect(d.groups.length).toBeGreaterThan(0);
    expect(d.categories.length).toBeGreaterThan(0);
    expect(d.assignments.length).toBeGreaterThan(0);
    expect(d.transactions.length).toBeGreaterThan(0);
    expect(d.recurring.length).toBeGreaterThan(0);
  });

  it("is internally consistent: every categoryId in assignments exists in categories", () => {
    const d = makeSeedBudgetData();
    const catIds = new Set(d.categories.map((c) => c.id));
    for (const a of d.assignments) {
      expect(catIds.has(a.categoryId)).toBe(true);
    }
  });

  it("credit-card categories link to credit accounts", () => {
    const d = makeSeedBudgetData();
    const ccGroup = d.groups.find((g) => g.isCreditCardPayments)!;
    const ccCats = d.categories.filter((c) => c.groupId === ccGroup.id);
    const ccAccountIds = new Set(
      d.accounts.filter((a) => a.kind === "credit").map((a) => a.id)
    );
    for (const c of ccCats) {
      expect(c.linkedAccountId).not.toBeNull();
      expect(ccAccountIds.has(c.linkedAccountId!)).toBe(true);
    }
  });

  it("DEMO_MONTH has at least one assignment and one transaction", () => {
    const d = makeSeedBudgetData();
    // Fixture spans multiple months (prior months supply carryover history);
    // verify the primary demo month has data.
    expect(
      d.assignments.some((a) => a.month === DEMO_MONTH)
    ).toBe(true);
    expect(
      d.transactions.some((t) => t.date.startsWith(DEMO_MONTH))
    ).toBe(true);
  });

  it("stamps the TD chequing account with reconcile metadata matching seed.ts", () => {
    const d = makeSeedBudgetData();
    const td = d.accounts.find((a) => a.name === "TD Unlimited Chequing");
    expect(td).toBeDefined();
    expect(td!.lastReconciledAt).toBe("2026-04-10");
    expect(Number(td!.lastReconciledBalance)).toBe(608358);
  });

  it("marks TD starting balance and April transactions as status 'r'", () => {
    const d = makeSeedBudgetData();
    const td = d.accounts.find((a) => a.name === "TD Unlimited Chequing")!;
    const tdAprilTx = d.transactions.filter(
      (t) => t.accountId === td.id && t.date.startsWith("2026-04")
    );
    expect(tdAprilTx).toHaveLength(6);
    for (const t of tdAprilTx) {
      expect(t.status).toBe("r");
    }
  });

  it("categorizes TFSA transfer and recurring contribution to Retirement", () => {
    const d = makeSeedBudgetData();
    const retirementCat = d.categories.find((c) => c.name === "Retirement")!;
    const tfsaAccount = d.accounts.find((a) => a.name === "Wealthsimple TFSA")!;

    const tfsaTx = d.transactions.find(
      (t) => t.transferAccountId === tfsaAccount.id
    );
    expect(tfsaTx).toBeDefined();
    expect(tfsaTx!.categoryId).toBe(retirementCat.id);

    const tfsaRecurring = d.recurring.find(
      (r) => r.transferAccountId === tfsaAccount.id
    );
    expect(tfsaRecurring).toBeDefined();
    expect(tfsaRecurring!.categoryId).toBe(retirementCat.id);
  });
});
